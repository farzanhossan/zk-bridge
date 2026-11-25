/**
 * Phase 1 proof of concept: talks to the K40 only, no CRM needed.
 *   npm run poc
 * Prints stats, users and the latest logs, then shows live punches until Ctrl+C.
 */
import { Console } from 'node:console';
import { ConfigError, loadConfig } from './config';
import { DeviceClient, localTime } from './device';
import { errMsg } from './errors';
import { captureConsole, installWarningFilter } from './logger';

installWarningFilter();
captureConsole(); // silences zkteco-js chatter; we print through our own Console below
const out = new Console({ stdout: process.stdout, stderr: process.stderr });

let target = '(not configured)';

async function main(): Promise<void> {
  const cfg = loadConfig({ requireCrm: false });
  const device = new DeviceClient({
    ip: cfg.deviceIp,
    port: cfg.devicePort,
    timeoutMs: cfg.deviceTimeoutMs,
    udpInport: cfg.deviceUdpInport,
  });
  target = device.address;

  out.log(`zk-bridge POC: device ${device.address}, timezone ${cfg.deviceTimezone}`);
  out.log(`This PC's time in ${cfg.deviceTimezone}: ${localTime(new Date())}\n`);

  const stats = await device.stats();
  const driftSec = stats.deviceTime ? Math.round((Date.parse(stats.deviceTime) - Date.now()) / 1000) : null;
  out.log('Device stats');
  out.table({
    'serial number': stats.serialNumber ?? '(unknown)',
    users: stats.userCounts,
    logs: stats.logCounts,
    'log capacity': stats.logCapacity,
    'device time (local)': stats.deviceTime ? localTime(stats.deviceTime) : '(unknown)',
    'device time (UTC)': stats.deviceTime ?? '(unknown)',
    'drift vs this PC (s)': driftSec ?? '(unknown)',
  });
  out.log('Check that "device time (local)" matches the clock on the K40 screen.\n');

  const users = await device.getUsers();
  out.log(`Users: ${users.length}${users.length > 20 ? ' (first 20)' : ''}`);
  if (users.length) out.table(users.slice(0, 20)); // no passwords: DeviceClient drops them

  const punches = await device.pullAll();
  const latest = [...punches].sort((a, b) => (a.punchedAt < b.punchedAt ? 1 : -1)).slice(0, 20);
  out.log(`\nLogs: ${punches.length}${punches.length > 20 ? ' (latest 20)' : ''}`);
  if (latest.length) {
    out.table(
      latest.map((p) => ({ userId: p.deviceUserId, utc: p.punchedAt, local: localTime(p.punchedAt), state: p.state, verifyType: p.verifyType })),
    );
  }

  out.log('\nListening for live punches. Punch on the K40 now (Ctrl+C to stop)...');
  device.startRealtime((p) => out.log(`LIVE punch: user ${p.deviceUserId} at ${localTime(p.punchedAt)}`));

  const stop = async () => {
    out.log('\nStopping...');
    await device.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((e) => {
  if (e instanceof ConfigError) {
    out.error(e.message);
    process.exit(1);
  }
  out.error(`\nDevice test failed: ${errMsg(e)}\n`);
  out.error(
    [
      'Things to check:',
      `  - DEVICE_IP / DEVICE_PORT in .env (now ${target}) match the K40 (Menu > Comm. > Ethernet)`,
      '  - this PC is on the same network / switch as the K40',
      `  - the device answers a ping: ping ${target.split(':')[0]}`,
      '  - Comm Key on the K40 is 0 (zkteco-js cannot send a Comm Key)',
      '  - no other program (ZKTime, ZKBioTime...) is connected to the device right now',
    ].join('\n'),
  );
  process.exit(1);
});
