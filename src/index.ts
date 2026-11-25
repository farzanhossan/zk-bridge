import { runCommand, type CommandContext } from './commands';
import { ConfigError, loadConfig, VERSION, type Config } from './config';
import { CrmClient, CrmError, type CommandAck } from './crm-client';
import { DeviceClient, localTime, type Punch } from './device';
import { errMsg } from './errors';
import { captureConsole, installWarningFilter, log } from './logger';
import { META_DEVICE_OLDEST_PUNCH, Outbox } from './outbox';

installWarningFilter();
captureConsole();

const FLUSH_BATCH = 500;
const PRUNE_AFTER_DAYS = 90;
const TIME_SYNC_CHECK_MS = 3600_000;
const PRUNE_EVERY_MS = 24 * 3600_000;
/** NSSM waits 10 s after Ctrl+C (AppStopMethodConsole); stay well inside that. */
const SHUTDOWN_FLUSH_MS = 5_000;
const META_LAST_TIME_SYNC = 'last_time_sync';
/** Wake detection: a tick that arrives this much later than expected means the PC slept or hibernated. */
const WAKE_TICK_MS = 5_000;
const WAKE_GAP_MS = 30_000;
/** After waking, give Wi-Fi/Ethernet a moment to come back before catching up. */
const WAKE_SETTLE_MS = 5_000;
/** If the device keeps dropping, don't pull on every reconnect; the regular full pull covers the rest. */
const CATCH_UP_MIN_GAP_MS = 60_000;
/** A one-line health summary in the log: shortly after start, after a wake, then every 15 min. */
const STATUS_EVERY_MS = 15 * 60_000;
const STATUS_FIRST_AFTER_MS = 60_000;

interface Task {
  /** Run now; if already running, run once more right after. */
  trigger(): void;
  /** Run now and wait for it; if already running, just wait for that run. */
  runNow(): Promise<void>;
  /** Start the timer (first run after one interval). */
  start(): void;
  stop(): void;
  /** The run in progress, if any. */
  readonly current: Promise<void> | null;
}

/**
 * Repeats `fn` every `intervalMs`, measured from the end of the previous run,
 * so a task never overlaps itself. Failures are logged and never crash the process.
 */
function makeTask(name: string, intervalMs: number, fn: () => Promise<unknown>): Task {
  let timer: NodeJS.Timeout | null = null;
  let current: Promise<void> | null = null;
  let again = false;
  let started = false;
  let stopped = false;

  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const arm = () => {
    clear();
    if (started && !stopped) timer = setTimeout(() => void run(false), intervalMs);
  };
  function run(rerunIfBusy: boolean): Promise<void> {
    if (stopped) return Promise.resolve();
    if (current) {
      // e.g. a live punch arrives while a flush is already sending: send it right after.
      if (rerunIfBusy) again = true;
      return current;
    }
    clear();
    current = (async () => {
      do {
        again = false;
        try {
          await fn();
        } catch (e) {
          log.warn(`${name} failed: ${errMsg(e)}`);
        }
      } while (again && !stopped);
    })().finally(() => {
      current = null;
      arm();
    });
    return current;
  }

  return {
    trigger: () => void run(true),
    runNow: () => run(false),
    start: () => {
      started = true;
      if (!current) arm();
    },
    stop: () => {
      stopped = true;
      clear();
    },
    get current() {
      return current;
    },
  };
}

async function main(): Promise<void> {
  let cfg: Config;
  try {
    cfg = loadConfig({ requireCrm: true });
  } catch (e) {
    log.error(e instanceof ConfigError ? e.message : `Could not load configuration: ${errMsg(e)}`);
    process.exit(1);
  }

  const outbox = new Outbox(cfg.outboxPath);
  const device = new DeviceClient({
    ip: cfg.deviceIp,
    port: cfg.devicePort,
    timeoutMs: cfg.deviceTimeoutMs,
    udpInport: cfg.deviceUdpInport,
  });
  const crm = new CrmClient(cfg.crmBaseUrl, cfg.crmDeviceKey, VERSION);
  let shuttingDown = false;
  let wakeTicker: NodeJS.Timeout | null = null;

  log.info(`zk-bridge ${VERSION} starting (Node ${process.version}, ${process.platform})`);
  log.info(`Device ${device.address}, timezone ${cfg.deviceTimezone} (local time now ${localTime(new Date())}), CRM ${cfg.crmBaseUrl}`);
  log.info(`Outbox ${cfg.outboxPath}: ${outbox.pendingCount()} punch(es) waiting to be sent`);

  // --------------------------------------------------------------- the work

  // Catch-up bookkeeping: was the last pull OK, and when did the last good one start?
  let lastPullFailed = true;
  let lastGoodPullStartedAt = 0;
  let lastCatchUpAt = 0;

  /** Pull every log from the device into the outbox. Shared by the schedule and the PULL_ALL command. */
  async function pullAndQueue(): Promise<{ onDevice: number; newlyQueued: number }> {
    const startedAt = Date.now();
    let punches: Punch[];
    try {
      punches = await device.pullAll();
    } catch (e) {
      lastPullFailed = true;
      throw e;
    }
    lastPullFailed = false;
    lastGoodPullStartedAt = startedAt;
    const newlyQueued = outbox.add(punches);
    if (device.lastPullComplete) {
      // Remember the oldest log still on the device; pruneSent() never deletes newer rows.
      let oldest: string | null = null;
      for (const p of punches) if (oldest === null || p.punchedAt < oldest) oldest = p.punchedAt;
      outbox.setMeta(META_DEVICE_OLDEST_PUNCH, oldest ?? new Date().toISOString());
    }
    log.info(`Pull: ${punches.length} log(s) on the device, ${newlyQueued} new`);
    if (newlyQueued > 0) flushTask.trigger();
    return { onDevice: punches.length, newlyQueued };
  }

  async function syncTimeAndRecord(): Promise<Date> {
    const deviceTime = await device.syncTime();
    outbox.setMeta(META_LAST_TIME_SYNC, new Date().toISOString());
    return deviceTime;
  }

  // CRM health, for the status line. Every CRM call goes through trackCrm().
  let crmFailingSince: number | null = null;
  let crmLastError = '';
  let lastSentAt = 0;
  async function trackCrm<T>(call: Promise<T>): Promise<T> {
    try {
      const result = await call;
      crmFailingSince = null;
      return result;
    } catch (e) {
      crmFailingSince ??= Date.now();
      crmLastError = errMsg(e);
      throw e;
    }
  }

  /** Send queued punches oldest first. A punch is marked sent only after a 2xx. */
  async function flush(): Promise<void> {
    for (;;) {
      const batch = outbox.pending(FLUSH_BATCH);
      if (!batch.length) return;
      const keys = batch.map((p) => p.key);
      try {
        const res = await trackCrm(
          crm.postPunches(
            batch.map(({ deviceUserId, punchedAt, state, verifyType, source }) => ({ deviceUserId, punchedAt, state, verifyType, source })),
          ),
        );
        outbox.markSent(keys);
        lastSentAt = Date.now();
        log.info(`Sent ${batch.length} punch(es) to the CRM (accepted ${res.accepted}, duplicates ${res.duplicates})`);
      } catch (e) {
        outbox.markAttempt(keys);
        const pending = outbox.pendingCount();
        if (e instanceof CrmError && e.permanent) {
          log.error(`${errMsg(e)}. The CRM refused the punches; check CRM_DEVICE_KEY and CRM_BASE_URL. ${pending} punch(es) stay queued.`);
        } else {
          log.warn(`Could not send punches, ${pending} stay queued and will be retried: ${errMsg(e)}`);
        }
        return; // stop this round; the next one retries
      }
      if (batch.length < FLUSH_BATCH) return;
    }
  }

  /** Reports cached state only; never touches the device. */
  async function heartbeat(): Promise<void> {
    await trackCrm(
      crm.heartbeat({
        deviceOnline: device.online,
        pendingPunches: outbox.pendingCount(),
        bridgeVersion: VERSION,
        stats: device.lastStats,
      }),
    );
  }

  const commandCtx: CommandContext = { device, pullAndQueue, syncTimeAndRecord };

  async function pollCommands(): Promise<void> {
    const commands = await trackCrm(crm.getCommands());
    for (const cmd of commands) {
      if (shuttingDown) return;
      log.info(`Running CRM command ${cmd.id}: ${cmd.type || '(no type)'}`);
      let ack: CommandAck;
      try {
        ack = { success: true, result: await runCommand(cmd, commandCtx) };
        log.info(`Command ${cmd.id} (${cmd.type}) succeeded`);
      } catch (e) {
        ack = { success: false, error: errMsg(e) };
        log.warn(`Command ${cmd.id} (${cmd.type}) failed: ${ack.error}`);
      }
      try {
        await trackCrm(crm.ackCommand(cmd.id, ack));
      } catch (e) {
        log.warn(`Could not ack command ${cmd.id}; the CRM will probably send it again: ${errMsg(e)}`);
      }
    }
  }

  async function timeSyncIfDue(): Promise<void> {
    const last = Date.parse(outbox.getMeta(META_LAST_TIME_SYNC) ?? '');
    if (Number.isFinite(last) && Date.now() - last < cfg.timeSyncIntervalHours * 3600_000) return;
    await syncTimeAndRecord();
  }

  async function prune(): Promise<void> {
    const n = outbox.pruneSent(PRUNE_AFTER_DAYS);
    if (n) log.info(`Pruned ${n} punch(es) sent more than ${PRUNE_AFTER_DAYS} days ago`);
  }

  /**
   * One line that says whether everything is fine, e.g.
   *   Status: OK - K40 reachable, live listener on, CRM OK (last sent 09:41), 0 waiting, today 37 punch(es), last punch user 7 at 09:40
   * Logged at warn level with "PROBLEM" and the reasons when the K40 or the CRM is not answering.
   */
  async function logStatus(): Promise<void> {
    const problems: string[] = [];
    const facts: string[] = [];

    if (device.online) facts.push(`K40 reachable, live listener ${device.realtimeConnected ? 'on' : 'reconnecting'}`);
    else problems.push(`K40 not reachable${device.offlineSince ? ` since ${shortTime(device.offlineSince)}` : ''}`);

    if (crmFailingSince !== null) problems.push(`CRM not answering since ${shortTime(crmFailingSince)} (${crmLastError})`);
    else facts.push(`CRM OK${lastSentAt ? ` (last sent ${shortTime(lastSentAt)})` : ''}`);

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0); // local midnight in DEVICE_TIMEZONE
    facts.push(`${outbox.pendingCount()} waiting`, `today ${outbox.countPunchedSince(midnight.toISOString())} punch(es)`);
    const last = outbox.latestPunch();
    facts.push(last ? `last punch user ${last.deviceUserId} at ${shortTime(last.punchedAt)}` : 'no punches yet');

    if (problems.length) log.warn(`Status: PROBLEM - ${problems.join('; ')}; ${facts.join(', ')}`);
    else log.info(`Status: OK - ${facts.join(', ')}`);
  }

  const flushTask = makeTask('Flush', cfg.flushIntervalSec * 1000, flush);
  const pullTask = makeTask('Full pull', cfg.fullPullIntervalSec * 1000, pullAndQueue);
  const heartbeatTask = makeTask('Heartbeat', cfg.heartbeatIntervalSec * 1000, heartbeat);
  const commandTask = makeTask('Command poll', cfg.commandPollIntervalSec * 1000, pollCommands);
  const pruneTask = makeTask('Prune', PRUNE_EVERY_MS, prune);
  const timeSyncTask = cfg.timeSyncIntervalHours > 0 ? makeTask('Time sync', TIME_SYNC_CHECK_MS, timeSyncIfDue) : null;
  const statusTask = makeTask('Status', STATUS_EVERY_MS, logStatus);
  const tasks = [flushTask, pullTask, heartbeatTask, commandTask, pruneTask, statusTask, ...(timeSyncTask ? [timeSyncTask] : [])];

  // --------------------------------------------------------------- shutdown

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      log.warn(`${signal} received again, exiting now`);
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    if (wakeTicker) clearInterval(wakeTicker);
    for (const t of tasks) t.stop();
    try {
      await device.stop();
    } catch (e) {
      log.warn(`Stopping the device listener: ${errMsg(e)}`);
    }
    // Last chance to deliver; anything not sent stays in the outbox for next start.
    const finalFlush = (flushTask.current ?? Promise.resolve()).then(() => flush());
    const timedOut = await Promise.race([
      finalFlush.then(() => false).catch((e) => (log.warn(`Final flush: ${errMsg(e)}`), false)),
      new Promise<boolean>((r) => setTimeout(() => r(true), SHUTDOWN_FLUSH_MS).unref()),
    ]);
    if (timedOut) log.warn('Final flush did not finish in time; unsent punches stay queued');
    log.info(`Stopped. ${outbox.pendingCount()} punch(es) still queued.`);
    outbox.close();
    process.exit(0);
  }

  // NSSM stops the service with Ctrl+C, which Node reports as SIGINT on Windows too.
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'));

  process.on('uncaughtException', (e) => {
    // State is unknown after this; exit and let NSSM restart us. The outbox is durable.
    log.error(`Uncaught exception, exiting so the service restarts: ${errMsg(e)}`, e instanceof Error ? e.stack : '');
    try {
      outbox.close();
    } finally {
      process.exit(1);
    }
  });

  // ---------------------------------------------------------------- startup

  // 1. Catch up on everything punched while the bridge was off. Not fatal.
  let deviceReachable = true;
  try {
    await pullAndQueue();
  } catch (e) {
    deviceReachable = false;
    log.warn(`Initial pull failed, will retry as soon as the device answers: ${errMsg(e)}`);
  }
  await flushTask.runNow();
  if (shuttingDown) return;

  // Fix the device clock before going live, but don't wait another timeout if it's offline.
  if (timeSyncTask && deviceReachable) await timeSyncTask.runNow();
  if (shuttingDown) return;

  // 2. Live punches: store first, then send right away.
  device.startRealtime(
    (p: Punch) => {
      if (outbox.add([p]) === 0) return; // already known
      log.info(`Live punch: user ${p.deviceUserId} at ${localTime(p.punchedAt)} (${p.punchedAt})`);
      flushTask.trigger();
    },
    {
      // The device is reachable again. If punches may have been missed (the last pull
      // failed, e.g. no network at boot, or the live connection had dropped since the
      // last good pull), pull now instead of waiting for the next scheduled pull.
      onConnected: (downSince) => {
        const missed = lastPullFailed || (downSince !== null && lastGoodPullStartedAt < downSince);
        if (!missed || shuttingDown || Date.now() - lastCatchUpAt < CATCH_UP_MIN_GAP_MS) return;
        lastCatchUpAt = Date.now();
        log.info('Device reachable again, pulling to catch up on punches made meanwhile');
        pullTask.trigger();
      },
    },
  );

  // 3. Schedules. The full pull already ran above, so it starts one interval from now.
  for (const t of tasks) t.start();
  heartbeatTask.trigger();
  commandTask.trigger();

  // 4. Sleep / hibernate / Windows Fast Startup freeze the service instead of
  // restarting it. On wake the live connection is dead and punches made while
  // asleep are only on the device, so catch up right away.
  let lastTick = Date.now();
  wakeTicker = setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (gap < WAKE_GAP_MS || shuttingDown) return;
    const away = gap >= 120_000 ? `${Math.round(gap / 60_000)} min` : `${Math.round(gap / 1000)} s`;
    log.info(`Resumed after ~${away} (sleep, hibernate or clock change); catching up in ${WAKE_SETTLE_MS / 1000} s`);
    setTimeout(() => {
      if (shuttingDown) return;
      pullTask.trigger(); // also replaces the dead live connection
      flushTask.trigger();
      heartbeatTask.trigger();
      commandTask.trigger();
    }, WAKE_SETTLE_MS);
    // Wi-Fi can take a while to rejoin after a wake; report once things have settled.
    setTimeout(() => statusTask.trigger(), STATUS_FIRST_AFTER_MS).unref();
  }, WAKE_TICK_MS);

  setTimeout(() => statusTask.trigger(), STATUS_FIRST_AFTER_MS).unref();
  log.info('Bridge running');
}

/** "09:41" for today, "2026-11-24 09:41" for other days, in DEVICE_TIMEZONE. */
function shortTime(t: number | string): string {
  const s = localTime(new Date(t));
  return s.slice(0, 10) === localTime(new Date()).slice(0, 10) ? s.slice(11, 16) : s.slice(0, 16);
}

process.on('unhandledRejection', (reason) => {
  // zkteco-js leaves some promises rejected with nobody listening (e.g. after a
  // failed data request). Log and keep running.
  log.warn(`Unhandled promise rejection (ignored): ${errMsg(reason)}`);
});

main().catch((e) => {
  log.error(`Fatal: ${errMsg(e)}`);
  process.exit(1);
});
