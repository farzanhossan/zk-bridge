import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dotenv from 'dotenv';
import { isLogLevel, type LogLevel, setLogLevel } from './logger';

/** Project folder (parent of src/ and dist/), so paths work whatever the working directory is. */
export const ROOT = path.resolve(__dirname, '..');

export const VERSION: string = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  } catch {
    return '0.0.0';
  }
})();

export interface Config {
  deviceIp: string;
  devicePort: number;
  deviceTimeoutMs: number;
  deviceUdpInport: number;
  deviceTimezone: string;
  crmBaseUrl: string;
  crmDeviceKey: string;
  fullPullIntervalSec: number;
  flushIntervalSec: number;
  heartbeatIntervalSec: number;
  commandPollIntervalSec: number;
  timeSyncIntervalHours: number;
  outboxPath: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {}

/**
 * Loads `.env` from the project folder (real environment variables win),
 * validates everything, sets the log level and switches the process
 * timezone to DEVICE_TIMEZONE. Throws ConfigError listing every problem.
 *
 * `requireCrm: false` is for the device-only POC.
 */
export function loadConfig(opts: { requireCrm: boolean }): Config {
  dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });
  const env = process.env;
  const problems: string[] = [];

  const str = (name: string, def = ''): string => (env[name] ?? def).trim();
  const int = (name: string, def: number, min: number, max: number): number => {
    const raw = str(name);
    if (raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} must be a whole number between ${min} and ${max} (got "${raw}")`);
      return def;
    }
    return n;
  };

  const deviceIp = str('DEVICE_IP');
  if (!deviceIp) problems.push('DEVICE_IP is required (the K40 address on the LAN, e.g. 192.168.1.201)');
  else if (/\s/.test(deviceIp)) problems.push(`DEVICE_IP is not a valid address: "${deviceIp}"`);

  const deviceTimezone = str('DEVICE_TIMEZONE', 'Asia/Dhaka');
  if (!isValidTimezone(deviceTimezone)) {
    problems.push(`DEVICE_TIMEZONE "${deviceTimezone}" is not a valid IANA timezone (e.g. Asia/Dhaka)`);
  }

  let crmBaseUrl = str('CRM_BASE_URL').replace(/\/+$/, '');
  const crmDeviceKey = str('CRM_DEVICE_KEY');
  if (opts.requireCrm) {
    if (!crmBaseUrl) problems.push('CRM_BASE_URL is required (e.g. https://crm.example.com/api)');
    else {
      const urlProblem = checkCrmUrl(crmBaseUrl);
      if (urlProblem) problems.push(urlProblem);
    }
    if (!crmDeviceKey) problems.push('CRM_DEVICE_KEY is required');
    else if (crmDeviceKey === 'replace-me') problems.push('CRM_DEVICE_KEY is still the placeholder "replace-me"');
  } else {
    crmBaseUrl = '';
  }

  const logLevelRaw = str('LOG_LEVEL', 'info').toLowerCase();
  if (!isLogLevel(logLevelRaw)) problems.push(`LOG_LEVEL must be debug, info, warn or error (got "${logLevelRaw}")`);

  const cfg: Config = {
    deviceIp,
    devicePort: int('DEVICE_PORT', 4370, 1, 65535),
    deviceTimeoutMs: int('DEVICE_TIMEOUT_MS', 10_000, 1_000, 120_000),
    deviceUdpInport: int('DEVICE_UDP_INPORT', 5200, 1, 65535),
    deviceTimezone,
    crmBaseUrl,
    crmDeviceKey,
    fullPullIntervalSec: int('FULL_PULL_INTERVAL_SEC', 600, 30, 86_400),
    flushIntervalSec: int('FLUSH_INTERVAL_SEC', 15, 1, 3_600),
    heartbeatIntervalSec: int('HEARTBEAT_INTERVAL_SEC', 60, 1, 3_600),
    commandPollIntervalSec: int('COMMAND_POLL_INTERVAL_SEC', 20, 1, 3_600),
    timeSyncIntervalHours: int('TIME_SYNC_INTERVAL_HOURS', 24, 0, 24 * 365),
    outboxPath: path.resolve(ROOT, str('OUTBOX_PATH', './data/outbox.db')),
    logLevel: isLogLevel(logLevelRaw) ? logLevelRaw : 'info',
  };

  if (problems.length) {
    throw new ConfigError(`Invalid configuration (check .env):\n  - ${problems.join('\n  - ')}`);
  }

  setLogLevel(cfg.logLevel);
  applyTimezone(cfg.deviceTimezone);
  return cfg;
}

function checkCrmUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `CRM_BASE_URL is not a valid URL: "${raw}"`;
  }
  if (u.protocol === 'https:') return null;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol === 'http:' && local) return null;
  return 'CRM_BASE_URL must start with https:// (http:// is only allowed for localhost/127.0.0.1)';
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The K40 stores local wall-clock time with no offset, and zkteco-js builds
 * Date objects with the *process* timezone. Running the process in the
 * device's timezone makes those Dates (and setTime) correct, whatever
 * timezone Windows itself is set to. Node applies a TZ change at runtime;
 * the check below makes sure it really did (e.g. on an unusual Node build).
 */
function applyTimezone(tz: string): void {
  process.env.TZ = tz;
  const probe = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(probe);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  if (part('day') !== probe.getDate() || part('hour') !== probe.getHours() || part('minute') !== probe.getMinutes()) {
    throw new ConfigError(
      `Could not switch the process timezone to ${tz}. Device timestamps would be converted wrongly, so refusing to start.`,
    );
  }
}
