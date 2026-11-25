import Zkteco from 'zkteco-js';
import { errMsg } from './errors';
import {
  ackPacket,
  CMD_ENABLEDEVICE,
  CMD_REG_EVENT,
  decodeAttLog,
  EF_ATTLOG,
  eventFlags,
  type LiveRecord,
  splitPackets,
  type ZkPacket,
} from './live-events';
import { log } from './logger';

/** A punch normalized from either library record shape. */
export interface Punch {
  deviceUserId: string; // trimmed string
  punchedAt: string; // ISO-8601 UTC
  state: number | null; // check-in/out etc.; null if the device didn't send it
  verifyType: number | null; // finger, card etc.; null if the device didn't send it
  source: 'realtime' | 'pull';
}

export interface DeviceStats {
  userCounts: number;
  logCounts: number;
  logCapacity: number;
  deviceTime: string | null; // ISO-8601 UTC
  serialNumber: string | null;
}

/** A device user as we expose it: the password is dropped on purpose. */
export interface DeviceUser {
  uid: number;
  userId: string;
  name: string;
  role: number;
  cardno: number;
}

export interface NewUser {
  uid: number;
  userId: string;
  name: string;
  password?: string;
  role?: number;
  cardno?: number;
}

export interface DeviceOptions {
  ip: string;
  port: number;
  timeoutMs: number;
  udpInport: number;
}

// ZK protocol codes (zkteco-js src/helper/command.js).
const CMD_GET_FREE_SIZES = 50;
const CMD_ACK_OK = 2000;
const CMD_ACK_UNAUTH = 2005;
const REPLY_NAMES: Record<number, string> = {
  2000: 'ACK_OK',
  2001: 'ACK_ERROR',
  2003: 'ACK_RETRY',
  2004: 'ACK_REPEAT',
  2005: 'ACK_UNAUTH',
  65531: 'ACK_ERROR_DATA',
  65532: 'ACK_ERROR_INIT',
  65533: 'ACK_ERROR_CMD',
  65535: 'ACK_UNKNOWN',
};

const RT_BACKOFF_START_MS = 5_000;
const RT_BACKOFF_MAX_MS = 120_000;
/** Safety net so a hung library promise can never block the device queue forever. */
const OP_TIMEOUT_MS = 5 * 60_000;
const CLOSE_TIMEOUT_MS = 4_000;
/** Wait after an operation before re-opening real-time, so back-to-back operations don't reconnect it each time. */
const RT_RESUME_DELAY_MS = 1_000;
/** A live punch this far from the PC clock is a garbled packet or a broken device clock. */
const MAX_LIVE_SKEW_MS = 24 * 3600_000;

/**
 * Talks to the K40 through zkteco-js.
 *
 * The K40 handles one client connection at a time, and zkteco-js gets confused if
 * two commands share a socket (a real-time listener would swallow other replies).
 * So every operation runs through runExclusive(): one at a time, each on a fresh
 * connection, with the real-time listener paused around it.
 */
export class DeviceClient {
  /** True after the last connection attempt succeeded; false after a failure or a lost listener. */
  get online(): boolean {
    return this._online;
  }
  /** When the device stopped answering (ms), or null while it answers / before the first failure. */
  offlineSince: number | null = null;
  /** True while the live (real-time) listener is connected. */
  get realtimeConnected(): boolean {
    return this.rt !== null;
  }
  /** Cached stats, refreshed by pullAll() / stats(). The heartbeat sends these without touching the device. */
  lastStats: DeviceStats | null = null;
  /** False if the last pull returned fewer records than the device reported (possible partial download). */
  lastPullComplete = false;

  private _online = false;
  private chain: Promise<unknown> = Promise.resolve();
  private pendingOps = 0;
  private stopped = false;

  private rtWanted = false;
  private rtOnPunch: ((p: Punch) => void) | null = null;
  private rtOnConnected: ((downSince: number | null) => void) | null = null;
  /** When the live connection last went down by itself (lost or failed to connect); null if it is fine or only paused by us. */
  private rtDownSince: number | null = null;
  private rt: { zk: Zkteco; gen: number } | null = null;
  private rtGen = 0;
  private rtTimer: NodeJS.Timeout | null = null;
  private rtBackoffMs = RT_BACKOFF_START_MS;
  /** Log reconnects after our own pauses at debug level; only the first connect or a recovery at info. */
  private rtReportedUp = false;

  constructor(private readonly opts: DeviceOptions) {}

  get address(): string {
    return `${this.opts.ip}:${this.opts.port}`;
  }

  // ---------------------------------------------------------------- operations

  /** Downloads every log on the device. Never clears anything. Also refreshes lastStats. */
  pullAll(): Promise<Punch[]> {
    return this.runExclusive('pullAll', async (zk) => {
      const stats = await this.readStats(zk).catch((e) => {
        log.warn(`Could not read device stats before the pull: ${errMsg(e)}`);
        return null;
      });

      const res = await zk.getAttendances();
      if (res.err) {
        // Only the UDP path reports errors here; TCP silently returns what it got.
        if (!res.data.length) throw res.err;
        log.warn(`Pull returned an error after ${res.data.length} records: ${errMsg(res.err)}`);
      }

      this.lastPullComplete = !res.err && stats !== null && res.data.length >= stats.logCounts;
      if (stats && res.data.length < stats.logCounts) {
        log.warn(`Pull got ${res.data.length} of ${stats.logCounts} logs (download cut short?). The next pull will retry.`);
      }

      const punches: Punch[] = [];
      for (const r of res.data) {
        const p = normalizeRecord(r);
        if (p) punches.push(p);
      }
      const dropped = res.data.length - punches.length;
      if (dropped) log.warn(`Pull: ignored ${dropped} record(s) with an empty user ID or invalid time`);
      return punches;
    });
  }

  stats(): Promise<DeviceStats> {
    return this.runExclusive('stats', (zk) => this.readStats(zk));
  }

  getUsers(): Promise<DeviceUser[]> {
    return this.runExclusive('getUsers', async (zk) => {
      const res = await zk.getUsers();
      if (res.err && !res.data.length) throw res.err;
      return res.data.map((u) => ({
        uid: u.uid,
        userId: String(u.userId ?? '').trim(),
        name: String(u.name ?? '').trim(),
        role: u.role,
        cardno: u.cardno ?? 0,
      }));
    });
  }

  setUser(u: NewUser): Promise<void> {
    return this.runExclusive('setUser', async (zk) => {
      requireTcp(zk, 'SET_USER');
      const reply = await zk.setUser(u.uid, u.userId, u.name, u.password ?? '', u.role ?? 0, u.cardno ?? 0);
      assertAck(reply, 'SET_USER');
    });
  }

  deleteUser(uid: number): Promise<void> {
    return this.runExclusive('deleteUser', async (zk) => {
      requireTcp(zk, 'DELETE_USER');
      assertAck(await zk.deleteUser(uid), 'DELETE_USER');
    });
  }

  /** Sets the device clock from this computer's clock and returns the time read back. */
  syncTime(): Promise<Date> {
    return this.runExclusive('syncTime', async (zk) => {
      const before = await zk.getTime().catch(() => null);
      const now = new Date();
      assertAck(await zk.setTime(now), 'SET_TIME');
      const after = await zk.getTime();
      if (!isValidDate(after)) throw new Error('Device returned an invalid time after SET_TIME');
      const drift = isValidDate(before) ? `, it was ${Math.round((before.getTime() - now.getTime()) / 1000)} s off` : '';
      log.info(`Device clock set to ${localTime(now)} (${process.env.TZ})${drift}`);
      if (this.lastStats) this.lastStats.deviceTime = after.toISOString();
      return after;
    });
  }

  // ----------------------------------------------------------------- real-time

  /**
   * Keeps one connection open listening for punches, reconnecting with backoff.
   * `onConnected` runs after every successful connect. `downSince` is when the
   * connection had gone down by itself (so punches since then were missed live),
   * or null after a normal first connect or one of our own pauses.
   */
  startRealtime(onPunch: (p: Punch) => void, opts: { onConnected?: (downSince: number | null) => void } = {}): void {
    this.rtOnPunch = onPunch;
    this.rtOnConnected = opts.onConnected ?? null;
    this.rtDownSince = null;
    this.rtWanted = true;
    this.rtBackoffMs = RT_BACKOFF_START_MS;
    if (!this.rt && this.pendingOps === 0) this.scheduleRealtime(0);
  }

  /** Does not wait for the operation queue, so it is safe to call during shutdown. */
  async stopRealtime(): Promise<void> {
    this.rtWanted = false;
    this.clearRtTimer();
    const rt = this.rt;
    this.rt = null;
    if (rt) await this.closeSession(rt.zk);
  }

  /** Stops real-time and refuses new operations. */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.stopRealtime();
  }

  // ------------------------------------------------------------------ internals

  /**
   * Promise-chain mutex. Each operation: pauses real-time, opens a fresh
   * connection, runs fn, disconnects, then resumes real-time once no other
   * operation is waiting (so back-to-back operations don't reconnect it each time).
   */
  runExclusive<T>(name: string, fn: (zk: Zkteco) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Device client is stopped'));
    this.pendingOps++;
    return this.enqueue(async () => {
      const started = Date.now();
      try {
        await this.pauseRealtime();
        const zk = await this.openSession();
        try {
          return await withTimeout(fn(zk), OP_TIMEOUT_MS, `Device operation ${name} did not finish within ${OP_TIMEOUT_MS / 1000} s`);
        } finally {
          await this.closeSession(zk);
          log.debug(`Device ${name} took ${Date.now() - started} ms`);
        }
      } finally {
        this.pendingOps--;
        this.resumeRealtimeIfIdle();
      }
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.chain.then(task);
    this.chain = result.catch(() => undefined);
    return result;
  }

  /**
   * Reusing a zkteco-js instance after a disconnect is unreliable (it leaves
   * listeners and session state behind), so every session gets a new one.
   */
  private async openSession(onLost?: (why: string) => void): Promise<Zkteco> {
    const { ip, port, timeoutMs, udpInport } = this.opts;
    const zk = new Zkteco(ip, port, timeoutMs, udpInport);
    try {
      // The library sets no timeout on the TCP connect itself, so an unreachable
      // IP would hang for the OS default (20-75 s). Bound it ourselves.
      await withTimeout(
        zk.createSocket(
          onLost ? (e) => onLost(errMsg(e)) : undefined,
          onLost ? () => onLost('connection closed') : undefined,
        ),
        timeoutMs,
        `No answer from the device at ${ip}:${port} within ${timeoutMs / 1000} s`,
      );
      hardenSockets(zk);
      await checkAuthorized(zk);
      this.setOnline(true);
      return zk;
    } catch (e) {
      this.setOnline(false);
      await this.closeSession(zk);
      throw e;
    }
  }

  private async closeSession(zk: Zkteco): Promise<void> {
    try {
      await withTimeout(zk.disconnect(), CLOSE_TIMEOUT_MS, 'disconnect timed out');
    } catch (e) {
      log.debug(`Disconnect: ${errMsg(e)}`);
    }
    // Make sure nothing stays open even if the polite CMD_EXIT failed or hung, and
    // wait for the close so the next session never overlaps this one on the device.
    const tcp = zk.ztcp.socket;
    if (tcp && !tcp.closed) {
      const closed = new Promise<void>((resolve) => {
        tcp.once('close', () => resolve());
        setTimeout(resolve, 1_000).unref();
      });
      tcp.destroy();
      await closed;
    }
    try {
      zk.zudp.socket?.close();
    } catch {
      /* already closed */
    }
  }

  /** Must only run inside the queue. */
  private async pauseRealtime(): Promise<void> {
    this.clearRtTimer();
    const rt = this.rt;
    if (!rt) return;
    this.rt = null; // from here on, its close event is ours and gets ignored
    log.debug('Pausing real-time listener for a device operation');
    await this.closeSession(rt.zk);
  }

  private resumeRealtimeIfIdle(): void {
    if (!this.rtWanted || this.stopped || this.pendingOps > 0 || this.rt) return;
    // The device just answered: reconnect shortly. Otherwise keep the current backoff.
    this.scheduleRealtime(this.online ? RT_RESUME_DELAY_MS : this.rtBackoffMs);
  }

  private scheduleRealtime(delayMs: number): void {
    this.clearRtTimer();
    this.rtTimer = setTimeout(() => {
      this.rtTimer = null;
      void this.enqueue(() => this.connectRealtime());
    }, delayMs);
  }

  private clearRtTimer(): void {
    if (this.rtTimer) clearTimeout(this.rtTimer);
    this.rtTimer = null;
  }

  /** Runs inside the queue, so it never overlaps an operation. */
  private async connectRealtime(): Promise<void> {
    if (!this.rtWanted || this.stopped || this.pendingOps > 0 || this.rt) return;
    const gen = ++this.rtGen;
    try {
      const zk = await this.openSession((why) => this.onRealtimeLost(gen, why));
      try {
        await listenForPunches(zk, (rec) => this.handleRealtime(rec));
      } catch (e) {
        await this.closeSession(zk);
        throw e;
      }
      if (!this.rtWanted || this.stopped) {
        await this.closeSession(zk);
        return;
      }
      this.rt = { zk, gen };
      this.rtBackoffMs = RT_BACKOFF_START_MS; // reset after a successful connect
      (this.rtReportedUp ? log.debug : log.info)(`Real-time listener connected to ${this.address}`);
      this.rtReportedUp = true;
      const downSince = this.rtDownSince;
      this.rtDownSince = null;
      try {
        this.rtOnConnected?.(downSince);
      } catch (e) {
        log.error(`Real-time connect handler failed: ${errMsg(e)}`);
      }
    } catch (e) {
      const delay = this.nextBackoff();
      this.rtReportedUp = false;
      this.rtDownSince ??= Date.now();
      log.warn(`Real-time connect to ${this.address} failed: ${errMsg(e)}. Retrying in ${delay / 1000} s`);
      this.scheduleRealtime(delay);
    }
  }

  private onRealtimeLost(gen: number, why: string): void {
    // Ignore our own pause/stop (rt already cleared) and attempts still being set up.
    if (!this.rt || this.rt.gen !== gen) return;
    const { zk } = this.rt;
    this.rt = null;
    this.setOnline(false);
    this.rtReportedUp = false;
    this.rtDownSince ??= Date.now();
    const delay = this.nextBackoff();
    log.warn(`Real-time connection lost (${why}). Reconnecting in ${delay / 1000} s`);
    void this.closeSession(zk);
    this.scheduleRealtime(delay);
  }

  private setOnline(v: boolean): void {
    if (v) this.offlineSince = null;
    else this.offlineSince ??= Date.now();
    this._online = v;
  }

  private nextBackoff(): number {
    const delay = this.rtBackoffMs;
    this.rtBackoffMs = Math.min(delay * 2, RT_BACKOFF_MAX_MS);
    return delay;
  }

  private handleRealtime(rec: LiveRecord): void {
    const { userId, at } = rec;
    if (!userId || !isValidDate(at)) {
      log.warn(`Ignored a live punch without a user ID or valid time (user '${userId}'). The next full pull will still collect it.`);
      return;
    }
    if (Math.abs(at.getTime() - Date.now()) > MAX_LIVE_SKEW_MS) {
      log.warn(
        `Ignored live punch for user ${userId} stamped ${localTime(at)}: more than 24 h from this PC's clock. ` +
          'The periodic pull will still collect it.',
      );
      return;
    }
    const punch: Punch = {
      deviceUserId: userId,
      punchedAt: at.toISOString(),
      state: rec.state,
      verifyType: rec.verifyType,
      source: 'realtime',
    };
    try {
      this.rtOnPunch?.(punch);
    } catch (e) {
      log.error(`Live punch handler failed: ${errMsg(e)}`);
    }
  }

  private async readStats(zk: Zkteco): Promise<DeviceStats> {
    const info = await zk.getInfo();
    const time = await zk.getTime().catch(() => null);
    const serial = await zk.getSerialNumber().catch(() => null);
    const stats: DeviceStats = {
      userCounts: info.userCounts,
      logCounts: info.logCounts,
      logCapacity: info.logCapacity,
      deviceTime: isValidDate(time) ? time.toISOString() : null,
      serialNumber: serial ? serial.trim() || null : null,
    };
    this.lastStats = stats;
    return stats;
  }
}

// -------------------------------------------------------------------- helpers

/** Normalizes TCP `{ user_id: string, record_time: string }` and UDP `{ user_id: number, record_time: Date }`. */
export function normalizeRecord(r: Zkteco.AttendanceRecord): Punch | null {
  const deviceUserId = String(r.user_id ?? '').trim();
  // TCP gives Date#toString() of a Date built in the process timezone; it includes
  // the offset, so parsing it back gives the right instant.
  const when = r.record_time instanceof Date ? r.record_time : new Date(r.record_time);
  if (!deviceUserId || !isValidDate(when)) return null;
  const tcp = 'state' in r;
  return {
    deviceUserId,
    punchedAt: when.toISOString(),
    state: tcp && typeof r.state === 'number' ? r.state : null,
    verifyType: tcp && typeof r.type === 'number' ? r.type : null,
    source: 'pull',
  };
}

export function isValidDate(d: unknown): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/** "YYYY-MM-DD HH:MM:SS" in the process timezone (= DEVICE_TIMEZONE), i.e. what the device screen shows. */
export function localTime(d: Date | string): string {
  const t = typeof d === 'string' ? new Date(d) : d;
  if (!isValidDate(t)) return 'invalid time';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())}`;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function hardenSockets(zk: Zkteco): void {
  const tcp = zk.ztcp.socket;
  if (tcp) {
    // The library listens only for the first 'error'. A second one with no
    // listener would crash the whole process, so keep one attached for good.
    tcp.on('error', (e) => log.debug(`Device socket error: ${errMsg(e)}`));
    // An idle real-time connection would otherwise never notice an unplugged
    // cable or a powered-off device. Keepalive lets the OS detect it.
    tcp.setKeepAlive(true, 15_000);
  }
  zk.zudp.socket?.on('error', (e) => log.debug(`Device UDP socket error: ${errMsg(e)}`));
}

/**
 * zkteco-js treats any reply to CMD_CONNECT as success, so a device with a
 * Comm Key set looks connected and then fails with confusing errors. Probe
 * with a harmless command and turn ACK_UNAUTH into a clear message.
 */
async function checkAuthorized(zk: Zkteco): Promise<void> {
  if (zk.connectionType !== 'tcp') return;
  const reply = await zk.executeCmd(CMD_GET_FREE_SIZES, '');
  if (Buffer.isBuffer(reply) && reply.length >= 2 && reply.readUInt16LE(0) === CMD_ACK_UNAUTH) {
    throw new Error(
      'The device refused the session (ACK_UNAUTH): a Comm Key is set on the K40. ' +
        'zkteco-js cannot send one, so set Comm Key = 0 in the device communication settings.',
    );
  }
}

/**
 * Turns on live punches for this session and decodes them ourselves (zkteco-js's
 * getRealTimeLogs never gets any from the K40: see live-events.ts). Nothing else
 * may run on this session afterwards, because its replies would be read as events.
 */
async function listenForPunches(zk: Zkteco, onRecord: (r: LiveRecord) => void): Promise<void> {
  requireTcp(zk, 'The live listener');
  assertAck(await zk.executeCmd(CMD_ENABLEDEVICE, ''), 'ENABLEDEVICE');
  assertAck(await zk.executeCmd(CMD_REG_EVENT, eventFlags(EF_ATTLOG)), 'REG_EVENT');
  const sock = zk.ztcp.socket;
  if (!sock) throw new Error('connection closed right after connecting');

  let pending: Buffer = Buffer.alloc(0); // start of a packet split over two reads
  sock.on('data', (chunk: Buffer) => {
    let packets: ZkPacket[];
    try {
      const split = splitPackets(pending.length ? Buffer.concat([pending, chunk]) : chunk);
      packets = split.packets;
      pending = split.rest;
    } catch (e) {
      pending = Buffer.alloc(0);
      log.warn(`Could not read data on the live connection: ${errMsg(e)}. The next full pull will still collect any punch in it.`);
      return;
    }
    for (const p of packets) {
      if (p.command !== CMD_REG_EVENT) {
        log.debug(`Live connection: ignored a packet with command ${p.command}`);
        continue;
      }
      // Acknowledge every event, as pyzk does, so the device never waits for us.
      if (sock.writable) sock.write(ackPacket(zk.ztcp.sessionId ?? 0, p.replyId));
      if (p.sessionField !== EF_ATTLOG) {
        log.debug(`Live connection: ignored event ${p.sessionField}`);
        continue;
      }
      try {
        const records = decodeAttLog(p.payload);
        if (!records.length) throw new Error('no record in it');
        for (const r of records) onRecord(r);
      } catch (e) {
        log.warn(`Could not decode a live punch (${p.payload.toString('hex')}): ${errMsg(e)}. The next full pull will still collect it.`);
      }
    }
  });
}

/** setUser/deleteUser exist only on the TCP path of zkteco-js. */
function requireTcp(zk: Zkteco, what: string): void {
  if (zk.connectionType !== 'tcp') throw new Error(`${what} needs a TCP connection (connected over ${zk.connectionType})`);
}

/** zkteco-js returns the raw reply without checking it; treat anything but ACK_OK as failure. */
function assertAck(reply: unknown, what: string): void {
  if (!Buffer.isBuffer(reply) || reply.length < 2) return; // UDP setTime resolves with `true`
  const code = reply.readUInt16LE(0);
  if (code !== CMD_ACK_OK) throw new Error(`Device rejected ${what} (reply ${REPLY_NAMES[code] ?? code})`);
}
