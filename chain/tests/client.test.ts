import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  SafetyGuardClient, DEFAULT_PROGRAM_ID, INSTRUCTION_DISCRIMINATORS,
  deriveTaskAddress, deriveReputationAddress, randomTripId, tripIdFromHex,
  tripIdToHex, decodeTask, decodeReputation,
} from '../src/index.ts';

const rider = Keypair.generate().publicKey;
const guardian = Keypair.generate().publicKey;
const tripId = new Uint8Array(32).fill(42);
const client = new SafetyGuardClient(new Connection('http://127.0.0.1:8899'));

test('instruction discriminators agree with Anchor SHA-256 convention', () => {
  for (const [method, name] of Object.entries({ createTask: 'create_task', acceptTask: 'accept_task', checkIn: 'check_in', completeTask: 'complete_task', cancelTask: 'cancel_task' })) {
    assert.deepEqual(Buffer.from(INSTRUCTION_DISCRIMINATORS[method as keyof typeof INSTRUCTION_DISCRIMINATORS]), createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
  }
});

test('PDA seeds bind tasks to rider and random ID and reputation to guardian', () => {
  const [expected] = PublicKey.findProgramAddressSync([Buffer.from('task'), rider.toBuffer(), Buffer.from(tripId)], DEFAULT_PROGRAM_ID);
  assert.ok(deriveTaskAddress(rider, tripId).equals(expected));
  assert.ok(!deriveTaskAddress(guardian, tripId).equals(expected));
  assert.ok(!deriveReputationAddress(guardian).equals(deriveReputationAddress(rider)));
  assert.ok(!PublicKey.isOnCurve(expected.toBytes()));
});

test('create wire format contains only random ID and Unix deadline', () => {
  const ix = client.createTask({ rider, guardian, tripId, deadline: 1_900_000_000 }).instructions[0];
  assert.equal(ix.data.length, 48);
  assert.deepEqual(ix.data.subarray(8, 40), Buffer.from(tripId));
  assert.equal(ix.data.readBigInt64LE(40), 1_900_000_000n);
  assert.equal(ix.keys.length, 4);
  assert.ok(ix.keys[0].pubkey.equals(rider) && ix.keys[0].isSigner && ix.keys[0].isWritable);
  assert.ok(ix.keys[3].pubkey.equals(SystemProgram.programId));
});

test('required signer follows the actor and completion targets designated reputation', () => {
  for (const tx of [client.acceptTask({ rider, guardian, tripId }), client.checkIn({ rider, guardian, tripId })]) {
    assert.ok(tx.instructions[0].keys[0].pubkey.equals(guardian));
    assert.equal(tx.instructions[0].keys[0].isSigner, true);
  }
  const ix = client.completeTask({ rider, guardian, tripId }).instructions[0];
  assert.ok(ix.keys[0].pubkey.equals(rider) && ix.keys[0].isSigner);
  assert.ok(ix.keys[2].pubkey.equals(deriveReputationAddress(guardian)));
  assert.equal(client.cancelTask({ rider, tripId }).instructions[0].keys[0].isSigner, true);
});

test('invalid IDs, guardian addresses and timestamps fail before wallet approval', () => {
  for (const value of ['', 'aa', 'gg'.repeat(32), '00'.repeat(32)]) assert.throws(() => tripIdFromHex(value));
  assert.throws(() => deriveTaskAddress(rider, new Uint8Array(31)));
  assert.throws(() => client.createTask({ rider, guardian: rider, tripId, deadline: 123 }));
  assert.throws(() => client.createTask({ rider, guardian: PublicKey.default, tripId, deadline: 123 }));
  assert.throws(() => client.createTask({ rider, guardian, tripId, deadline: 1.25 }));
  const generated = randomTripId();
  assert.deepEqual(tripIdFromHex(tripIdToHex(generated)), generated);
});

test('decode accounts at exact Rust Borsh offsets, keeping counters as bigint', () => {
  const task = Buffer.alloc(150);
  createHash('sha256').update('account:GuardTask').digest().copy(task, 0, 0, 8);
  rider.toBuffer().copy(task, 8); guardian.toBuffer().copy(task, 40); Buffer.from(tripId).copy(task, 72);
  task.writeBigInt64LE(100n, 104); task.writeBigInt64LE(200n, 112);
  task.writeBigInt64LE(110n, 120); task.writeBigInt64LE(120n, 128); task.writeBigInt64LE(150n, 136);
  task.writeUInt32LE(2, 144); task[148] = 2; task[149] = 254;
  const decoded = decodeTask(task);
  assert.equal(decoded.state, 'completed'); assert.equal(decoded.checkInCount, 2);
  assert.equal(decoded.completedAt, 150); assert.ok(decoded.rider.equals(rider));
  const reputation = Buffer.alloc(57);
  createHash('sha256').update('account:Reputation').digest().copy(reputation, 0, 0, 8);
  guardian.toBuffer().copy(reputation, 8);
  reputation.writeBigUInt64LE(9_007_199_254_740_999n, 40); reputation.writeBigUInt64LE(20n, 48); reputation[56] = 253;
  assert.equal(decodeReputation(reputation).points, 9_007_199_254_740_999n);
  assert.throws(() => decodeTask(reputation));
  task[148] = 9; assert.throws(() => decodeTask(task));
});

test('fetch rejects an account owned by a different program', async () => {
  const fake = { getAccountInfo: async () => ({ owner: SystemProgram.programId, data: Buffer.alloc(150) }) } as unknown as Connection;
  await assert.rejects(new SafetyGuardClient(fake).fetchTask({ rider, tripId }), /owner/);
});

test('portable decoders respect sliced Uint8Array offsets and integer signedness', () => {
  const taskStorage = new Uint8Array(220).fill(255);
  const taskBytes = taskStorage.subarray(37, 187);
  taskBytes.fill(0);
  taskBytes.set(createHash('sha256').update('account:GuardTask').digest().subarray(0, 8));
  const taskView = new DataView(taskBytes.buffer, taskBytes.byteOffset, taskBytes.byteLength);
  taskView.setBigInt64(104, -123n, true);
  taskView.setBigInt64(112, 1_900_000_000n, true);
  taskView.setUint32(144, 0xffff_ffff, true);
  taskBytes[148] = 1;
  const decoded = decodeTask(taskBytes);
  assert.equal(decoded.createdAt, -123);
  assert.equal(decoded.deadline, 1_900_000_000);
  assert.equal(decoded.checkInCount, 0xffff_ffff);
  assert.equal(decoded.state, 'active');
  taskView.setBigInt64(104, 9_007_199_254_740_992n, true);
  assert.throws(() => decodeTask(taskBytes), /safe integer/);

  const reputationStorage = new Uint8Array(100).fill(255);
  const reputationBytes = reputationStorage.subarray(17, 74);
  reputationBytes.fill(0);
  reputationBytes.set(createHash('sha256').update('account:Reputation').digest().subarray(0, 8));
  const reputationView = new DataView(reputationBytes.buffer, reputationBytes.byteOffset, reputationBytes.byteLength);
  reputationView.setBigUint64(40, 18_446_744_073_709_551_615n, true);
  reputationView.setBigUint64(48, 32n, true);
  assert.equal(decodeReputation(reputationBytes).points, 18_446_744_073_709_551_615n);
  assert.equal(decodeReputation(reputationBytes).completedTasks, 32n);
});
