import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Punch } from './device';

export interface PendingPunch extends Punch {
  key: string;
  attempts: number;
}

interface PunchRow {
  key: string;
  device_user_id: string;
  punched_at: string;
  state: number | null;
  verify_type: number | null;
  source: string;
  attempts: number;
}

/** Meta key: oldest punch time seen on the device in the last complete pull. Used by pruneSent(). */
export const META_DEVICE_OLDEST_PUNCH = 'device_oldest_punch';

/**
 * Durable queue of punches. Every punch lands here before any network send,
 * and is marked sent only after the CRM answered 2xx. The key
 * `${deviceUserId}|${punchedAt}` makes re-pulling the whole device log harmless.
 */
export class Outbox {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly sentStmt: StatementSync;
  private readonly attemptStmt: StatementSync;
  private closed = false;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS punches (
        key            TEXT PRIMARY KEY,
        device_user_id TEXT NOT NULL,
        punched_at     TEXT NOT NULL,
        state          INTEGER,
        verify_type    INTEGER,
        source         TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        sent_at        TEXT,
        attempts       INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS punches_pending ON punches (sent_at, punched_at);
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT
      );
    `);
    this.insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO punches (key, device_user_id, punched_at, state, verify_type, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.sentStmt = this.db.prepare('UPDATE punches SET sent_at = ? WHERE key = ? AND sent_at IS NULL');
    this.attemptStmt = this.db.prepare('UPDATE punches SET attempts = attempts + 1 WHERE key = ?');
  }

  static keyOf(p: Pick<Punch, 'deviceUserId' | 'punchedAt'>): string {
    return `${p.deviceUserId}|${p.punchedAt}`;
  }

  /** Inserts in one transaction; returns how many punches were new. */
  add(punches: readonly Punch[]): number {
    if (!punches.length) return 0;
    const now = new Date().toISOString();
    return this.tx(() => {
      let added = 0;
      for (const p of punches) {
        const r = this.insertStmt.run(Outbox.keyOf(p), p.deviceUserId, p.punchedAt, p.state, p.verifyType, p.source, now);
        added += Number(r.changes);
      }
      return added;
    });
  }

  /** Unsent punches, oldest first. */
  pending(limit = 500): PendingPunch[] {
    const rows = this.db
      .prepare(
        `SELECT key, device_user_id, punched_at, state, verify_type, source, attempts
         FROM punches WHERE sent_at IS NULL ORDER BY punched_at, key LIMIT ?`,
      )
      .all(limit) as unknown as PunchRow[];
    return rows.map((r) => ({
      key: r.key,
      deviceUserId: r.device_user_id,
      punchedAt: r.punched_at,
      state: r.state,
      verifyType: r.verify_type,
      source: r.source === 'realtime' ? 'realtime' : 'pull',
      attempts: r.attempts,
    }));
  }

  pendingCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM punches WHERE sent_at IS NULL').get() as { n: number };
    return Number(row.n);
  }

  /** All punches (sent or not) made at or after `iso`. For the status line. */
  countPunchedSince(iso: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM punches WHERE punched_at >= ?').get(iso) as { n: number };
    return Number(row.n);
  }

  /** The most recent punch we know of, sent or not. */
  latestPunch(): { deviceUserId: string; punchedAt: string } | null {
    const row = this.db.prepare('SELECT device_user_id, punched_at FROM punches ORDER BY punched_at DESC LIMIT 1').get() as
      | { device_user_id: string; punched_at: string }
      | undefined;
    return row ? { deviceUserId: row.device_user_id, punchedAt: row.punched_at } : null;
  }

  markSent(keys: readonly string[]): void {
    const now = new Date().toISOString();
    this.tx(() => {
      for (const k of keys) this.sentStmt.run(now, k);
    });
  }

  markAttempt(keys: readonly string[]): void {
    this.tx(() => {
      for (const k of keys) this.attemptStmt.run(k);
    });
  }

  /**
   * Deletes punches sent more than `days` ago, but only those older than the
   * oldest log still on the device (META_DEVICE_OLDEST_PUNCH). A row deleted
   * while the device still holds that log would come back as "new" on the next
   * full pull and be sent again, every pruning cycle. Until a complete pull has
   * recorded that mark, nothing is pruned. Returns the number of rows deleted.
   */
  pruneSent(days = 90): number {
    const oldestOnDevice = this.getMeta(META_DEVICE_OLDEST_PUNCH);
    if (!oldestOnDevice) return 0;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const r = this.db
      .prepare('DELETE FROM punches WHERE sent_at IS NOT NULL AND sent_at < ? AND punched_at < ?')
      .run(cutoff, oldestOnDevice);
    return Number(r.changes);
  }

  getMeta(k: string): string | null {
    const row = this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k) as { v: string | null } | undefined;
    return row?.v ?? null;
  }

  setMeta(k: string, v: string): void {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
  }

  close(): void {
    // Own flag: DatabaseSync#isOpen only exists from Node 22.15.
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}
