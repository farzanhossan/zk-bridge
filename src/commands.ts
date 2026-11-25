import type { CrmCommand } from './crm-client';
import type { DeviceClient, NewUser } from './device';

/** What a command may use. The pull and time-sync helpers are shared with the scheduled tasks in index.ts. */
export interface CommandContext {
  device: DeviceClient;
  pullAndQueue(): Promise<{ onDevice: number; newlyQueued: number }>;
  syncTimeAndRecord(): Promise<Date>;
}

/**
 * Runs one CRM command and returns the ack `result`. Throws on bad input or a
 * device error; the caller acks that with success:false.
 */
export async function runCommand(cmd: CrmCommand, ctx: CommandContext): Promise<unknown> {
  switch (cmd.type) {
    case 'SET_USER': {
      const user = parseSetUser(cmd.payload);
      await ctx.device.setUser(user);
      return { uid: user.uid, userId: user.userId };
    }
    case 'DELETE_USER': {
      const p = requirePayload('DELETE_USER', cmd.payload);
      const uid = int('DELETE_USER', p, 'uid', 1, 3000, true) as number;
      await ctx.device.deleteUser(uid);
      return { uid };
    }
    case 'SYNC_TIME': {
      const deviceTime = await ctx.syncTimeAndRecord();
      return { deviceTime: deviceTime.toISOString() };
    }
    case 'PULL_ALL':
      return ctx.pullAndQueue();
    case 'GET_USERS': {
      const users = await ctx.device.getUsers();
      // Explicit field list: never send passwords or fingerprint data to the CRM.
      return { users: users.map(({ uid, userId, name, role, cardno }) => ({ uid, userId, name, role, cardno })) };
    }
    default:
      throw new Error(`Unknown command type "${cmd.type || '(empty)'}"`);
  }
}

function parseSetUser(payload: Record<string, unknown> | null): NewUser {
  const C = 'SET_USER';
  const p = requirePayload(C, payload);
  const user: NewUser = {
    uid: int(C, p, 'uid', 1, 3000, true) as number,
    userId: text(C, p, 'userId', 9, { required: true, nonEmpty: true, ascii: true, allowNumber: true }) as string,
    name: text(C, p, 'name', 24, { required: true }) as string,
  };
  const password = text(C, p, 'password', 8, { ascii: true, allowNumber: true });
  const role = int(C, p, 'role', 0, 14, false);
  const cardno = int(C, p, 'cardno', 0, 65535, false); // zkteco-js writes it as uint16
  if (password !== undefined) user.password = password;
  if (role !== undefined) user.role = role;
  if (cardno !== undefined) user.cardno = cardno;
  return user;
}

function requirePayload(cmd: string, payload: Record<string, unknown> | null): Record<string, unknown> {
  if (!payload) throw new Error(`${cmd}: payload must be an object`);
  return payload;
}

function int(cmd: string, p: Record<string, unknown>, field: string, min: number, max: number, required: boolean): number | undefined {
  const v = p[field];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${cmd}: "${field}" is required (integer ${min}-${max})`);
    return undefined;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${cmd}: "${field}" must be an integer from ${min} to ${max} (got ${JSON.stringify(v)})`);
  }
  return v;
}

/** Length limits are in bytes, because that is what the device record holds. */
function text(
  cmd: string,
  p: Record<string, unknown>,
  field: string,
  maxBytes: number,
  opts: { required?: boolean; nonEmpty?: boolean; ascii?: boolean; allowNumber?: boolean },
): string | undefined {
  let v = p[field];
  if (v === undefined || v === null) {
    if (opts.required) throw new Error(`${cmd}: "${field}" is required`);
    return undefined;
  }
  if (opts.allowNumber && typeof v === 'number' && Number.isInteger(v) && v >= 0) v = String(v);
  if (typeof v !== 'string') throw new Error(`${cmd}: "${field}" must be a string (got ${JSON.stringify(v)})`);
  if (opts.nonEmpty && v.trim() === '') throw new Error(`${cmd}: "${field}" must not be empty`);
  if (v.includes('\0')) throw new Error(`${cmd}: "${field}" must not contain NUL characters`);
  if (opts.ascii && !/^[\x20-\x7E]*$/.test(v)) throw new Error(`${cmd}: "${field}" may only contain plain ASCII characters`);
  const bytes = Buffer.byteLength(v, 'utf8');
  if (bytes > maxBytes) throw new Error(`${cmd}: "${field}" is too long (${bytes} bytes, max ${maxBytes})`);
  return v;
}
