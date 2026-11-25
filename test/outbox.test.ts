import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { normalizeRecord, type Punch } from '../src/device';
import { errMsg } from '../src/errors';
import { META_DEVICE_OLDEST_PUNCH, Outbox } from '../src/outbox';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zk-bridge-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

let n = 0;
function freshOutbox(): Outbox {
  // A nested folder also checks that the data directory gets created.
  return new Outbox(path.join(dir, `run${++n}`, 'sub', 'outbox.db'));
}

function punch(userId: string, at: string, extra: Partial<Punch> = {}): Punch {
  return { deviceUserId: userId, punchedAt: at, state: null, verifyType: null, source: 'pull', ...extra };
}

describe('Outbox', () => {
  let ob: Outbox;
  beforeEach(() => {
    ob = freshOutbox();
  });

  it('dedupes on deviceUserId + punchedAt and reports only new rows', () => {
    const a = punch('1', '2026-01-01T03:00:00.000Z', { state: 0, verifyType: 1 });
    const b = punch('2', '2026-01-01T03:00:00.000Z');
    assert.equal(ob.add([a, b]), 2);
    assert.equal(ob.add([a, b]), 0);
    // Same key coming in live after being pulled is still a duplicate.
    assert.equal(ob.add([{ ...a, source: 'realtime', state: null }]), 0);
    assert.equal(ob.add([a, punch('1', '2026-01-01T03:00:01.000Z')]), 1);
    assert.equal(ob.pendingCount(), 3);
    assert.equal(ob.add([]), 0);
  });

  it('returns pending punches oldest first, honours the limit, and keeps fields', () => {
    ob.add([
      punch('9', '2026-01-03T00:00:00.000Z'),
      punch('5', '2026-01-01T00:00:00.000Z', { state: 1, verifyType: 15, source: 'realtime' }),
      punch('7', '2026-01-02T00:00:00.000Z'),
    ]);
    const all = ob.pending();
    assert.deepEqual(
      all.map((p) => p.deviceUserId),
      ['5', '7', '9'],
    );
    assert.deepEqual(all[0], {
      key: '5|2026-01-01T00:00:00.000Z',
      deviceUserId: '5',
      punchedAt: '2026-01-01T00:00:00.000Z',
      state: 1,
      verifyType: 15,
      source: 'realtime',
      attempts: 0,
    });
    assert.equal(ob.pending(2).length, 2);
  });

  it('markSent removes punches from pending; markAttempt counts attempts', () => {
    ob.add([punch('1', '2026-01-01T00:00:00.000Z'), punch('2', '2026-01-02T00:00:00.000Z')]);
    const [first, second] = ob.pending();
    ob.markAttempt([first.key, second.key]);
    ob.markAttempt([first.key]);
    assert.deepEqual(
      ob.pending().map((p) => p.attempts),
      [2, 1],
    );
    ob.markSent([first.key]);
    assert.equal(ob.pendingCount(), 1);
    assert.equal(ob.pending()[0].key, second.key);
    // A sent punch pulled again is still a duplicate, so it is never re-queued.
    assert.equal(ob.add([punch('1', '2026-01-01T00:00:00.000Z')]), 0);
    assert.equal(ob.pendingCount(), 1);
  });

  it('pruneSent deletes only old sent rows that are no longer on the device', () => {
    const old = '2025-01-01T00:00:00.000Z';
    ob.add([punch('1', old), punch('2', '2025-01-02T00:00:00.000Z'), punch('3', '2025-01-03T00:00:00.000Z')]);
    const keys = ob.pending().map((p) => p.key);
    ob.markSent(keys.slice(0, 2)); // user 3 stays unsent

    // days = -1 puts the cutoff in the future, so every sent row counts as "old enough"
    // (days = 0 would depend on the clock having ticked since markSent).
    // Nothing is pruned before a complete pull has recorded what the device holds.
    assert.equal(ob.pruneSent(-1), 0);

    // The device still holds logs from 2025-01-02 on: only user 1's row may go.
    ob.setMeta(META_DEVICE_OLDEST_PUNCH, '2025-01-02T00:00:00.000Z');
    assert.equal(ob.pruneSent(30), 0, 'rows sent just now are younger than 30 days');
    assert.equal(ob.pruneSent(-1), 1);
    assert.equal(ob.add([punch('1', old)]), 1, 'the pruned row is gone');

    // Unsent rows are never pruned, whatever their age.
    ob.setMeta(META_DEVICE_OLDEST_PUNCH, '2030-01-01T00:00:00.000Z');
    assert.equal(ob.pruneSent(-1), 1, 'only user 2 (sent) goes; users 1 and 3 are unsent');
    assert.deepEqual(
      ob.pending().map((p) => p.deviceUserId),
      ['1', '3'],
    );
  });

  it('stores meta values and survives reopening', () => {
    const file = path.join(dir, 'reopen', 'outbox.db');
    const a = new Outbox(file);
    assert.equal(a.getMeta('last_time_sync'), null);
    a.setMeta('last_time_sync', 'x');
    a.setMeta('last_time_sync', '2026-11-24T00:00:00.000Z');
    a.add([punch('1', '2026-01-01T00:00:00.000Z')]);
    a.close();
    a.close(); // closing twice is harmless

    const b = new Outbox(file);
    assert.equal(b.getMeta('last_time_sync'), '2026-11-24T00:00:00.000Z');
    assert.equal(b.pendingCount(), 1);
    b.close();
  });
});

describe('normalizeRecord', () => {
  it('handles the TCP shape (Date#toString in the process timezone)', () => {
    process.env.TZ = 'Asia/Dhaka';
    const local = new Date(2026, 10, 24, 9, 1, 2); // 09:01:02 in Dhaka = 03:01:02 UTC
    const p = normalizeRecord({ sn: 1, user_id: ' 42 ', record_time: local.toString(), type: 1, state: 0, ip: 'x' });
    assert.deepEqual(p, { deviceUserId: '42', punchedAt: '2026-11-24T03:01:02.000Z', state: 0, verifyType: 1, source: 'pull' });
  });

  it('handles the UDP shape and drops bad records', () => {
    const at = new Date('2026-11-24T03:01:02Z');
    assert.deepEqual(normalizeRecord({ user_id: 7, record_time: at, ip: 'x' }), {
      deviceUserId: '7',
      punchedAt: '2026-11-24T03:01:02.000Z',
      state: null,
      verifyType: null,
      source: 'pull',
    });
    assert.equal(normalizeRecord({ sn: 1, user_id: '', record_time: at.toString(), type: 1, state: 0, ip: 'x' }), null);
    assert.equal(normalizeRecord({ sn: 1, user_id: '1', record_time: 'Invalid Date', type: 1, state: 0, ip: 'x' }), null);
  });
});

describe('errMsg', () => {
  it('digs the message out of nested ZkError objects', () => {
    const sys = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4370'), { code: 'ECONNREFUSED' });
    const nested = { err: { err: sys, ip: '127.0.0.1', command: 'TCP CONNECT' }, ip: '127.0.0.1', command: 'TCP CONNECT' };
    assert.equal(errMsg(nested), 'connect ECONNREFUSED 127.0.0.1:4370 (during TCP CONNECT)');
  });

  it('never returns [object Object]', () => {
    for (const v of [{}, { err: {} }, { foo: 1 }, null, undefined, new AggregateError([new Error('a'), new Error('b')], '')]) {
      assert.doesNotMatch(errMsg(v), /\[object Object\]/);
    }
    assert.equal(errMsg(new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND x') })), 'fetch failed: getaddrinfo ENOTFOUND x');
  });
});
