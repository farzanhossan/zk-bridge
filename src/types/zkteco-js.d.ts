/**
 * Hand-written typings for zkteco-js@1.7.2, taken from its source
 * (index.js, src/ztcp.js, src/zudp.js, src/helper/utils.js).
 *
 * Only what zk-bridge uses is declared. `clearAttendanceLog()` and
 * `clearData()` exist in the library but are deliberately left out, so the
 * compiler rejects any attempt to wipe the device.
 *
 * Every method rejects with a (possibly nested) `ZkError`
 * `{ err, ip, command }`, which is NOT an Error instance; see errMsg().
 */
declare module 'zkteco-js' {
  import type { Socket as TcpSocket } from 'node:net';
  import type { Socket as UdpSocket } from 'node:dgram';

  namespace Zkteco {
    /** 40-byte TCP log record (decodeRecordData40). */
    interface TcpAttendanceRecord {
      sn: number;
      /** Up to 9 ASCII chars, NUL-trimmed. */
      user_id: string;
      /** `Date#toString()` of a Date built in the process timezone. */
      record_time: string;
      /** Byte 26: verify type (fingerprint, card, password...). */
      type: number;
      /** Byte 31: attendance state (check-in, check-out...). */
      state: number;
      ip: string;
    }

    /** 16-byte UDP log record (decodeRecordData16). */
    interface UdpAttendanceRecord {
      user_id: number;
      record_time: Date;
      ip: string;
    }

    type AttendanceRecord = TcpAttendanceRecord | UdpAttendanceRecord;

    /** Real-time event. TCP gives a string userId, UDP a number. No state or verify type. */
    interface RealTimeLog {
      userId: string | number;
      attTime: Date;
    }

    /** TCP users have every field; UDP users only uid, role, name and a numeric userId. */
    interface User {
      uid: number;
      role: number;
      password?: string;
      name: string;
      cardno?: number;
      userId: string | number;
    }

    interface Info {
      userCounts: number;
      logCounts: number;
      logCapacity: number;
    }

    /** Internal ZTCP / ZUDP objects; we only touch `.socket` to harden it. */
    interface Transport<S> {
      socket: S | null;
    }
  }

  class Zkteco {
    /** Note the order: timeout (ms) comes before inport (local UDP port, UDP fallback only). */
    constructor(ip: string, port: number, timeout: number, inport: number, maxChunk?: number);

    connectionType: 'tcp' | 'udp' | null;
    ztcp: Zkteco.Transport<TcpSocket>;
    zudp: Zkteco.Transport<UdpSocket>;

    /**
     * Opens TCP (UDP fallback is coded for ECONNREFUSED but, as of 1.7.2, never
     * triggers because the error is already wrapped). The callbacks are wired to
     * the socket's first 'error' and its 'close' events.
     */
    createSocket(cbErr?: (err: unknown) => void, cbClose?: (type: 'tcp' | 'udp') => void): Promise<boolean>;
    disconnect(): Promise<unknown>;

    getInfo(): Promise<Zkteco.Info>;
    getTime(): Promise<Date>;
    /** Encodes the Date with local (process timezone) getters. TCP resolves with the raw reply. */
    setTime(t: Date | number): Promise<Buffer | boolean>;
    getSerialNumber(): Promise<string>;

    /**
     * TCP: a chunk timeout or socket drop is swallowed and a partial list is
     * returned. UDP: errors are returned in `err` instead of thrown.
     */
    getAttendances(onProgress?: (received: number, total: number) => void): Promise<{ data: Zkteco.AttendanceRecord[]; err?: unknown }>;

    /**
     * Sends CMD_REG_EVENT and attaches a 'data' listener only if the socket has
     * none, so nothing else may run on this socket while listening.
     */
    getRealTimeLogs(cb: (log: Zkteco.RealTimeLog) => void): Promise<void>;

    getUsers(): Promise<{ data: Zkteco.User[]; err?: unknown }>;
    /** uid 1-3000, userid <= 9, name <= 24, password <= 8; cardno is written as uint16. TCP only. */
    setUser(uid: number, userid: string, name: string, password: string, role?: number, cardno?: number): Promise<Buffer>;
    /** TCP only. */
    deleteUser(uid: number): Promise<Buffer>;

    /** Raw command; resolves with the reply minus the TCP prefix (first 2 bytes = reply code). */
    executeCmd(command: number, data?: string | Buffer): Promise<Buffer>;
  }

  export = Zkteco;
}
