/**
 * Puts a few fake punches into an outbox, to test sending without a device.
 *   npx tsx test/seed-outbox.ts ./data/test-outbox.db [count]
 */
import * as path from 'node:path';
import { Outbox } from '../src/outbox';

const file = path.resolve(process.argv[2] ?? './data/test-outbox.db');
const count = Number(process.argv[3] ?? 3);
const ob = new Outbox(file);
const base = Date.parse('2026-11-24T03:00:00Z');
const added = ob.add(
  Array.from({ length: count }, (_, i) => ({
    deviceUserId: String(100 + i),
    punchedAt: new Date(base + i * 60_000).toISOString(),
    state: i % 2,
    verifyType: 1,
    source: 'pull' as const,
  })),
);
console.log(`Seeded ${added} new punch(es) into ${file}; ${ob.pendingCount()} pending`);
ob.close();
