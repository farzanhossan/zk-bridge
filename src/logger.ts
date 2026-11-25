import { format } from 'node:util';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: number = ORDER.info;

export function isLogLevel(v: string): v is LogLevel {
  return v in ORDER;
}

export function setLogLevel(level: LogLevel): void {
  minLevel = ORDER[level];
}

// Writes straight to the process streams rather than through `console`, because
// `captureConsole()` below reroutes `console` and must not loop back into itself.
function write(level: LogLevel, args: unknown[]): void {
  if (ORDER[level] < minLevel) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`;
  (level === 'warn' || level === 'error' ? process.stderr : process.stdout).write(line);
}

export const log = {
  debug: (...args: unknown[]) => write('debug', args),
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};

/**
 * zkteco-js prints to the console on every connect and on every error
 * ("TCP connection successful", "Error executing command: ..." with whole
 * objects). Those lines would swamp the service log, and every failure is
 * already reported by our own code, so send all `console.*` output to the
 * logger at debug level. Use `LOG_LEVEL=debug` to see it.
 */
export function captureConsole(): void {
  const toDebug = (...args: unknown[]) => write('debug', ['[zkteco-js]', ...args]);
  console.log = toDebug;
  console.info = toDebug;
  console.debug = toDebug;
  console.warn = toDebug;
  console.error = toDebug;
}

/**
 * `node:sqlite` is stable enough for our needs but still prints an
 * ExperimentalWarning on every start. Drop that one warning and send any
 * other process warning through the logger. Node emits warnings on the
 * next tick, so calling this during startup still catches the warning
 * raised by importing `node:sqlite`.
 */
export function installWarningFilter(): void {
  process.removeAllListeners('warning');
  process.on('warning', (w) => {
    if (w.name === 'ExperimentalWarning' && /sqlite/i.test(w.message)) return;
    write('warn', [`${w.name}: ${w.message}`]);
  });
}
