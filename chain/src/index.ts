import { Buffer } from 'buffer';
import {
  Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction,
  type AccountMeta, type Commitment,
} from '@solana/web3.js';

/** Development source ID. Deploy the program and use the resulting ID before sending transactions. */
export const DEFAULT_PROGRAM_ID = new PublicKey('Fg6PaFpoGXkYsidMpWxTWqkZqZH7bGQjR67FvBPMR6Dz');
export const REWARD_POINTS = 10n;
export const TASK_ACCOUNT_SIZE = 150;
export const REPUTATION_ACCOUNT_SIZE = 57;
export const INSTRUCTION_DISCRIMINATORS = {
  createTask: [194, 80, 6, 180, 232, 127, 48, 171],
  acceptTask: [222, 196, 79, 165, 120, 30, 38, 120],
  checkIn: [209, 253, 4, 217, 250, 241, 207, 50],
  completeTask: [109, 167, 192, 41, 129, 108, 220, 196],
  cancelTask: [69, 228, 134, 187, 134, 105, 238, 48],
} as const;
const TASK_DISCRIMINATOR = [138, 174, 116, 129, 156, 153, 32, 161];
const REPUTATION_DISCRIMINATOR = [55, 148, 90, 71, 68, 183, 193, 28];
export type TaskState = 'pending' | 'active' | 'completed' | 'cancelled';
export interface GuardTask {
  rider: PublicKey;
  guardian: PublicKey;
  tripId: Uint8Array;
  createdAt: number;
  deadline: number;
  acceptedAt: number;
  lastCheckInAt: number;
  completedAt: number;
  checkInCount: number;
  state: TaskState;
  bump: number;
}
export interface GuardianReputation {
  guardian: PublicKey;
  points: bigint;
  completedTasks: bigint;
  bump: number;
}
export interface TaskReference { rider: PublicKey; tripId: Uint8Array }
export interface GuardianTaskReference extends TaskReference { guardian: PublicKey }
export interface CreateTaskInput extends GuardianTaskReference { deadline: number }

export function assertTripId(tripId: Uint8Array): void {
  if (tripId.length !== 32 || tripId.every(byte => byte === 0)) {
    throw new Error('Trip ID must be a nonzero 32-byte random value.');
  }
}
/** Never derive this from a rider name, address, phone, or Uber URL. */
export function randomTripId(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
export function tripIdToHex(tripId: Uint8Array): string {
  assertTripId(tripId);
  return Buffer.from(tripId).toString('hex');
}
export function tripIdFromHex(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error('Trip ID must contain exactly 64 hex characters.');
  const bytes = new Uint8Array(Buffer.from(value, 'hex'));
  assertTripId(bytes);
  return bytes;
}
export function deriveTaskAddress(rider: PublicKey, tripId: Uint8Array, programId = DEFAULT_PROGRAM_ID): PublicKey {
  assertTripId(tripId);
  return PublicKey.findProgramAddressSync([Buffer.from('task'), rider.toBuffer(), Buffer.from(tripId)], programId)[0];
}
export function deriveReputationAddress(guardian: PublicKey, programId = DEFAULT_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('reputation'), guardian.toBuffer()], programId)[0];
}

function validateData(data: Uint8Array, size: number, discriminator: number[]): Uint8Array {
  if (data.byteLength !== size || discriminator.some((byte, index) => data[index] !== byte)) {
    throw new Error('Account does not match the Safety Guard wire format.');
  }
  return data;
}
function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}
function readTime(view: DataView, offset: number): number {
  const value = view.getBigInt64(offset, true);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error('Timestamp exceeds JavaScript safe integer range.');
  return number;
}
export function decodeTask(data: Uint8Array): GuardTask {
  const buffer = validateData(data, TASK_ACCOUNT_SIZE, TASK_DISCRIMINATOR);
  const view = viewOf(buffer);
  const state = (['pending', 'active', 'completed', 'cancelled'] as const)[buffer[148]];
  if (!state) throw new Error('Unknown task state.');
  return {
    rider: new PublicKey(buffer.subarray(8, 40)), guardian: new PublicKey(buffer.subarray(40, 72)),
    tripId: new Uint8Array(buffer.subarray(72, 104)), createdAt: readTime(view, 104),
    deadline: readTime(view, 112), acceptedAt: readTime(view, 120),
    lastCheckInAt: readTime(view, 128), completedAt: readTime(view, 136),
    checkInCount: view.getUint32(144, true), state, bump: buffer[149],
  };
}
export function decodeReputation(data: Uint8Array): GuardianReputation {
  const buffer = validateData(data, REPUTATION_ACCOUNT_SIZE, REPUTATION_DISCRIMINATOR);
  const view = viewOf(buffer);
  return {
    guardian: new PublicKey(buffer.subarray(8, 40)), points: view.getBigUint64(40, true),
    completedTasks: view.getBigUint64(48, true), bump: buffer[56],
  };
}
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta => ({ pubkey, isSigner, isWritable });

/** Builds unsigned transactions. Private keys and wallet permission stay with the caller. */
export class SafetyGuardClient {
  constructor(readonly connection: Connection, readonly programId = DEFAULT_PROGRAM_ID) {}

  private transaction(name: keyof typeof INSTRUCTION_DISCRIMINATORS, keys: AccountMeta[], args = Buffer.alloc(0)): Transaction {
    return new Transaction().add(new TransactionInstruction({
      programId: this.programId, keys,
      data: Buffer.concat([Buffer.from(INSTRUCTION_DISCRIMINATORS[name]), args]),
    }));
  }
  createTask(input: CreateTaskInput): Transaction {
    assertTripId(input.tripId);
    if (input.rider.equals(input.guardian)) throw new Error('Rider and guardian must use different wallets.');
    if (input.guardian.equals(PublicKey.default)) throw new Error('Guardian cannot be the zero public key.');
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0) throw new Error('Deadline must be a Unix timestamp in seconds.');
    const args = Buffer.alloc(40);
    args.set(input.tripId);
    viewOf(args).setBigInt64(32, BigInt(input.deadline), true);
    return this.transaction('createTask', [
      meta(input.rider, true, true), meta(input.guardian),
      meta(deriveTaskAddress(input.rider, input.tripId, this.programId), false, true), meta(SystemProgram.programId),
    ], args);
  }
  acceptTask(input: GuardianTaskReference): Transaction {
    return this.transaction('acceptTask', [
      meta(input.guardian, true), meta(deriveTaskAddress(input.rider, input.tripId, this.programId), false, true),
    ]);
  }
  checkIn(input: GuardianTaskReference): Transaction {
    return this.transaction('checkIn', [
      meta(input.guardian, true), meta(deriveTaskAddress(input.rider, input.tripId, this.programId), false, true),
    ]);
  }
  completeTask(input: GuardianTaskReference): Transaction {
    return this.transaction('completeTask', [
      meta(input.rider, true, true), meta(deriveTaskAddress(input.rider, input.tripId, this.programId), false, true),
      meta(deriveReputationAddress(input.guardian, this.programId), false, true), meta(SystemProgram.programId),
    ]);
  }
  cancelTask(input: TaskReference): Transaction {
    return this.transaction('cancelTask', [
      meta(input.rider, true), meta(deriveTaskAddress(input.rider, input.tripId, this.programId), false, true),
    ]);
  }
  async prepareTransaction(transaction: Transaction, payer: PublicKey, commitment: Commitment = 'confirmed') {
    const latest = await this.connection.getLatestBlockhash(commitment);
    transaction.feePayer = payer;
    transaction.recentBlockhash = latest.blockhash;
    return { transaction, ...latest };
  }
  async isProgramDeployed(): Promise<boolean> {
    return Boolean((await this.connection.getAccountInfo(this.programId, 'confirmed'))?.executable);
  }
  async fetchTask(input: TaskReference): Promise<GuardTask | null> {
    const account = await this.connection.getAccountInfo(deriveTaskAddress(input.rider, input.tripId, this.programId), 'confirmed');
    if (!account) return null;
    if (!account.owner.equals(this.programId)) throw new Error('Task account has an unexpected owner.');
    const task = decodeTask(account.data);
    if (!task.rider.equals(input.rider) || tripIdToHex(task.tripId) !== tripIdToHex(input.tripId)) throw new Error('Task identity mismatch.');
    return task;
  }
  async fetchReputation(guardian: PublicKey): Promise<GuardianReputation | null> {
    const account = await this.connection.getAccountInfo(deriveReputationAddress(guardian, this.programId), 'confirmed');
    if (!account) return null;
    if (!account.owner.equals(this.programId)) throw new Error('Reputation account has an unexpected owner.');
    const reputation = decodeReputation(account.data);
    if (!reputation.guardian.equals(guardian)) throw new Error('Reputation guardian mismatch.');
    return reputation;
  }
}
