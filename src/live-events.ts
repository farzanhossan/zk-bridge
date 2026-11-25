/**
 * The ZK live-event (real-time) protocol, done here instead of in zkteco-js.
 *
 * Checked on a real K40 on 2026-11-25:
 * - The K40 only sends live punches to a session that sent CMD_ENABLEDEVICE
 *   before CMD_REG_EVENT. zkteco-js sends only CMD_REG_EVENT, so with the
 *   library alone no live punch ever arrives (they still show up in the pull).
 * - Each punch comes as a CMD_REG_EVENT packet with EF_ATTLOG in the session
 *   field and a 36-byte record: user ID (24 bytes ASCII), verify type, state,
 *   time (6 bytes). The time matches the pulled log to the second.
 * - Like pyzk, we answer every event with ACK_OK.
 */

export const CMD_ENABLEDEVICE = 1002;
export const CMD_REG_EVENT = 500;
export const CMD_ACK_OK = 2000;
export const EF_ATTLOG = 1;

/** Every TCP packet starts with these 4 bytes (50 50 82 7d), then a uint32 length. */
const TCP_MAGIC = 0x7d825050;
const USHRT_MAX = 65535;
const MAX_PACKET = 65_536;

export interface ZkPacket {
  command: number;
  /** The session ID, except in event packets, where it holds the event flag (EF_ATTLOG...). */
  sessionField: number;
  replyId: number;
  payload: Buffer;
}

export interface LiveRecord {
  userId: string;
  /** In the process timezone (= DEVICE_TIMEZONE); null if the device sent an impossible date. */
  at: Date | null;
  verifyType: number;
  state: number;
}

/**
 * Splits bytes read from the socket into packets. A packet can be split over
 * several reads, so the unfinished tail comes back as `rest` to prepend to the
 * next read. Throws if the bytes are not ZK packets at all.
 */
export function splitPackets(buf: Buffer): { packets: ZkPacket[]; rest: Buffer } {
  const packets: ZkPacket[] = [];
  let off = 0;
  while (buf.length - off >= 8) {
    if (buf.readUInt32LE(off) !== TCP_MAGIC) {
      throw new Error(`not a ZK packet: ${buf.subarray(off, off + 16).toString('hex')}`);
    }
    const len = buf.readUInt32LE(off + 4);
    if (len < 8 || len > MAX_PACKET) throw new Error(`impossible packet length ${len}`);
    if (buf.length - off - 8 < len) break; // rest of this packet comes with the next read
    const p = buf.subarray(off + 8, off + 8 + len);
    packets.push({ command: p.readUInt16LE(0), sessionField: p.readUInt16LE(4), replyId: p.readUInt16LE(6), payload: p.subarray(8) });
    off += 8 + len;
  }
  return { packets, rest: buf.subarray(off) };
}

/**
 * Decodes the records in an EF_ATTLOG event. The K40 sends the 36-byte layout;
 * the others are what pyzk's live_capture() handles for other ZK firmware.
 */
export function decodeAttLog(data: Buffer): LiveRecord[] {
  const records: LiveRecord[] = [];
  let d = data;
  while (d.length >= 10) {
    const n = d.length;
    if (n === 10 || n === 14) {
      // uint16 user ID, verify, state, time (+ 4 unknown bytes)
      records.push({ userId: String(d.readUInt16LE(0)), verifyType: d[2], state: d[3], at: zkTime(d.subarray(4, 10)) });
      d = d.subarray(n);
    } else if (n === 12) {
      // uint32 user ID, verify, state, time
      records.push({ userId: String(d.readUInt32LE(0)), verifyType: d[4], state: d[5], at: zkTime(d.subarray(6, 12)) });
      d = d.subarray(12);
    } else if (n === 32 || n === 36 || n === 37 || n >= 52) {
      // 24-byte ASCII user ID, verify, state, time (+ 0/4/5/20 unknown bytes)
      const size = n >= 52 ? 52 : n;
      const userId = d.subarray(0, 24).toString('ascii').split('\0')[0].trim();
      records.push({ userId, verifyType: d[24], state: d[25], at: zkTime(d.subarray(26, 32)) });
      d = d.subarray(size);
    } else {
      throw new Error(`unknown live record layout (${n} bytes)`);
    }
  }
  return records;
}

/** The 4-byte CMD_REG_EVENT argument: which events the device should send us. */
export function eventFlags(flags: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(flags, 0);
  return b;
}

/** ACK_OK for an event, sent back on the same session. */
export function ackPacket(sessionId: number, replyId: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt16LE(CMD_ACK_OK, 0);
  body.writeUInt16LE(sessionId & 0xffff, 4);
  body.writeUInt16LE(replyId & 0xffff, 6);
  body.writeUInt16LE(checksum(body), 2);
  const top = Buffer.alloc(8);
  top.writeUInt32LE(TCP_MAGIC, 0);
  top.writeUInt32LE(body.length, 4);
  return Buffer.concat([top, body]);
}

/** The ZK packet checksum, computed the way zkteco-js and pyzk do it. */
function checksum(buf: Buffer): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 2) {
    sum += i === buf.length - 1 ? buf[i] : buf.readUInt16LE(i);
    sum %= USHRT_MAX;
  }
  return USHRT_MAX - sum - 1;
}

/** 6 bytes: year - 2000, month, day, hour, minute, second; device local time. */
function zkTime(b: Buffer): Date | null {
  const [y, mo, d, h, mi, s] = b;
  if (b.length < 6 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  return new Date(2000 + y, mo - 1, d, h, mi, s);
}
