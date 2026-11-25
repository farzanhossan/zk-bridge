import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ackPacket, decodeAttLog, splitPackets } from '../src/live-events';

process.env.TZ = 'Asia/Dhaka';

// A live punch exactly as a real K40 sent it (2026-11-25): user 2, fingerprint, state 4, 12:33:47 local.
const K40_PUNCH = Buffer.from(
  '5050827d2c000000f40183b30100000032000000000000000000000000000000000000000000000001041a0b190c212f00000000',
  'hex',
);
// The device's ACK_OK reply to CMD_REG_EVENT, captured from the same K40.
const K40_REG_ACK = Buffer.from('5050827d08000000d0075923d3d40300', 'hex');

describe('splitPackets', () => {
  it('reads a real K40 live punch packet', () => {
    const { packets, rest } = splitPackets(K40_PUNCH);
    assert.equal(rest.length, 0);
    assert.equal(packets.length, 1);
    const [p] = packets;
    assert.equal(p.command, 500); // CMD_REG_EVENT
    assert.equal(p.sessionField, 1); // EF_ATTLOG
    assert.equal(p.replyId, 0);
    assert.equal(p.payload.length, 36);
  });

  it('keeps a packet split over two reads until the rest arrives', () => {
    const first = splitPackets(K40_PUNCH.subarray(0, 20));
    assert.equal(first.packets.length, 0);
    const second = splitPackets(Buffer.concat([first.rest, K40_PUNCH.subarray(20)]));
    assert.equal(second.packets.length, 1);
    assert.equal(second.rest.length, 0);
  });

  it('separates several packets in one read', () => {
    const { packets, rest } = splitPackets(Buffer.concat([K40_REG_ACK, K40_PUNCH, K40_PUNCH.subarray(0, 5)]));
    assert.deepEqual(
      packets.map((p) => p.command),
      [2000, 500],
    );
    assert.equal(rest.length, 5);
  });

  it('rejects bytes that are not ZK packets', () => {
    assert.throws(() => splitPackets(Buffer.from('hello, this is not a ZK packet')), /not a ZK packet/);
  });
});

describe('decodeAttLog', () => {
  it('decodes the K40 36-byte record with the same values as the pulled log', () => {
    const [p] = splitPackets(K40_PUNCH).packets;
    const records = decodeAttLog(p.payload);
    assert.equal(records.length, 1);
    const [r] = records;
    assert.equal(r.userId, '2');
    assert.equal(r.verifyType, 1);
    assert.equal(r.state, 4);
    // 12:33:47 in Dhaka; the pulled log had exactly this time, so live and pulled copies dedupe.
    assert.equal(r.at?.toISOString(), '2026-11-25T06:33:47.000Z');
  });

  it('decodes the 10-byte layout with a numeric user ID', () => {
    const d = Buffer.from([7, 0, 15, 1, 26, 11, 25, 9, 1, 2]);
    assert.deepEqual(decodeAttLog(d), [{ userId: '7', verifyType: 15, state: 1, at: new Date('2026-11-25T03:01:02Z') }]);
  });

  it('decodes several 52-byte records in one event', () => {
    const rec = (user: string, sec: number) => {
      const b = Buffer.alloc(52);
      b.write(user, 0, 'ascii');
      b[24] = 1;
      b[25] = 0;
      Buffer.from([26, 11, 25, 9, 0, sec]).copy(b, 26);
      return b;
    };
    const records = decodeAttLog(Buffer.concat([rec('41', 1), rec('42', 2)]));
    assert.deepEqual(
      records.map((r) => [r.userId, r.at?.toISOString()]),
      [
        ['41', '2026-11-25T03:00:01.000Z'],
        ['42', '2026-11-25T03:00:02.000Z'],
      ],
    );
  });

  it('gives no time for an impossible date and throws on an unknown layout', () => {
    const bad = Buffer.alloc(36);
    bad.write('5', 0, 'ascii');
    Buffer.from([26, 13, 1, 0, 0, 0]).copy(bad, 26); // month 13
    assert.equal(decodeAttLog(bad)[0].at, null);
    assert.throws(() => decodeAttLog(Buffer.alloc(20)), /unknown live record layout \(20 bytes\)/);
  });
});

describe('ackPacket', () => {
  it('builds an ACK_OK packet for the event on our session', () => {
    const a = ackPacket(54483, 0);
    assert.equal(a.length, 16);
    const [p] = splitPackets(a).packets;
    assert.equal(p.command, 2000);
    assert.equal(p.sessionField, 54483);
    assert.equal(p.replyId, 0);
    assert.equal(p.payload.length, 0);
  });
});
