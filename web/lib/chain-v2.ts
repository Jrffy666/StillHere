// Generated from chain/src/v2.ts by npm run sync:chain. Do not edit this copy.
import { Buffer } from 'buffer';
import { Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, type AccountMeta, type Commitment } from '@solana/web3.js';

export const V2_VERSION = 2;
export const MAX_GUARDIANS = 16;
export const V2_POINTS_POOL = 25n;
export const V2_REPUTATION_POOL = 10n;
export const JOURNEY_V2_ACCOUNT_SIZE = 1412;
export const REPUTATION_V2_ACCOUNT_SIZE = 66;
export const CONTRIBUTION_V2_SIZE = 77;
export const V2_INSTRUCTION_DISCRIMINATORS = {"createJourney": [215, 98, 167, 155, 7, 17, 154, 8], "proposeGuardian": [39, 11, 248, 174, 73, 240, 0, 211], "cancelProposal": [106, 74, 128, 146, 19, 65, 39, 23], "acceptGuardian": [130, 141, 66, 69, 80, 183, 54, 186], "checkIn": [209, 253, 4, 217, 250, 241, 207, 50], "completeJourney": [253, 68, 87, 15, 74, 209, 75, 247], "cancelJourney": [87, 135, 70, 127, 96, 128, 96, 2], "claimReward": [149, 95, 181, 242, 94, 90, 158, 162]} as const;
export const JOURNEY_V2_DISCRIMINATOR = [198, 197, 76, 78, 233, 194, 33, 80] as const;
export const REPUTATION_V2_DISCRIMINATOR = [248, 97, 65, 208, 186, 86, 79, 4] as const;
export type JourneyState = 'open' | 'active' | 'completed' | 'cancelled';
export interface JourneyReference { rider: PublicKey; reference: Uint8Array }
export interface RevisionInput extends JourneyReference { expectedRevision: number }
export interface GuardianRevisionInput extends RevisionInput { guardian: PublicKey }
export interface ContributionV2 {
  guardian: PublicKey; checkIns: number; lastCheckInAt: number; startedAt: number; endedAt: number;
  points: bigint; reputation: bigint; claimed: boolean;
}
export interface JourneyV2 extends JourneyReference {
  version: 2; currentGuardian: PublicKey; proposedGuardian: PublicKey; createdAt: number; deadline: number;
  proposalExpiresAt: number; completedAt: number; assignmentRevision: number; sequence: number;
  state: JourneyState; guardianCount: number; bump: number; contributions: ContributionV2[];
}
export interface ReputationV2 { version: 2; guardian: PublicKey; points: bigint; reputation: bigint; completedJourneys: bigint; bump: number }
export function assertJourneyReference(reference: Uint8Array): void {
  if (reference.length !== 32 || reference.every(byte => byte === 0)) throw new Error('Journey reference must be a random nonzero 32-byte value.');
}
export function randomJourneyReference(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
export function journeyReferenceToHex(reference: Uint8Array): string { assertJourneyReference(reference); return Buffer.from(reference).toString('hex'); }
export function journeyReferenceFromHex(value: string): Uint8Array {
  if (!/^[a-f\d]{64}$/i.test(value)) throw new Error('Journey reference must contain 64 hexadecimal characters.');
  const bytes = new Uint8Array(Buffer.from(value, 'hex')); assertJourneyReference(bytes); return bytes;
}
export function deriveJourneyAddress(rider: PublicKey, reference: Uint8Array, programId: PublicKey): PublicKey {
  assertJourneyReference(reference);
  return PublicKey.findProgramAddressSync([Buffer.from('journey'), rider.toBuffer(), Buffer.from(reference)], programId)[0];
}
export function deriveReputationV2Address(guardian: PublicKey, programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('reputation_v2'), guardian.toBuffer()], programId)[0];
}
function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function time(data: DataView, offset: number): number {
  const value = Number(data.getBigInt64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('Timestamp exceeds JavaScript safe integer range.');
  return value;
}
function validate(bytes: Uint8Array, size: number, discriminator: readonly number[]): DataView {
  if (bytes.byteLength !== size || discriminator.some((byte, i) => bytes[i] !== byte) || bytes[8] !== 2) throw new Error('Account does not match the Safety Guard V2 format.');
  return view(bytes);
}
export function decodeJourneyV2(bytes: Uint8Array): JourneyV2 {
  const data = validate(bytes, JOURNEY_V2_ACCOUNT_SIZE, JOURNEY_V2_DISCRIMINATOR);
  const state = (['open', 'active', 'completed', 'cancelled'] as const)[bytes[177]];
  const guardianCount = bytes[178];
  if (!state || guardianCount > MAX_GUARDIANS) throw new Error('Invalid journey state or guardian count.');
  const contributions: ContributionV2[] = [];
  for (let i = 0; i < guardianCount; i++) {
    const offset = 180 + CONTRIBUTION_V2_SIZE * i;
    if (bytes[offset + 76] > 1) throw new Error('Invalid contribution claim flag.');
    contributions.push({ guardian: new PublicKey(bytes.subarray(offset, offset + 32)), checkIns: data.getUint32(offset + 32, true),
      lastCheckInAt: time(data, offset + 36), startedAt: time(data, offset + 44), endedAt: time(data, offset + 52),
      points: data.getBigUint64(offset + 60, true), reputation: data.getBigUint64(offset + 68, true), claimed: bytes[offset + 76] === 1 });
  }
  return { version: 2, rider: new PublicKey(bytes.subarray(9, 41)), reference: new Uint8Array(bytes.subarray(41, 73)),
    currentGuardian: new PublicKey(bytes.subarray(73, 105)), proposedGuardian: new PublicKey(bytes.subarray(105, 137)),
    createdAt: time(data, 137), deadline: time(data, 145), proposalExpiresAt: time(data, 153), completedAt: time(data, 161),
    assignmentRevision: data.getUint32(169, true), sequence: data.getUint32(173, true), state, guardianCount, bump: bytes[179], contributions };
}
export function decodeReputationV2(bytes: Uint8Array): ReputationV2 {
  const data = validate(bytes, REPUTATION_V2_ACCOUNT_SIZE, REPUTATION_V2_DISCRIMINATOR);
  return { version: 2, guardian: new PublicKey(bytes.subarray(9, 41)), points: data.getBigUint64(41, true),
    reputation: data.getBigUint64(49, true), completedJourneys: data.getBigUint64(57, true), bump: bytes[65] };
}
function u32(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error('Revision and sequence must be unsigned 32-bit integers.');
  const bytes = Buffer.alloc(4); view(bytes).setUint32(0, value, true); return bytes;
}
const meta = (pubkey: PublicKey, isSigner = false, isWritable = false): AccountMeta => ({ pubkey, isSigner, isWritable });
/** V2 never defaults to the deployed V1 ID. The caller must configure a separate V2 program. */
export class SafetyGuardV2Client {
  constructor(readonly connection: Connection, readonly programId: PublicKey) {
    if (!programId || programId.equals(PublicKey.default)) throw new Error('An explicit V2 program ID is required.');
  }
  getJourneyAddress(input: JourneyReference): PublicKey { return deriveJourneyAddress(input.rider, input.reference, this.programId); }
  getTaskAddress(input: JourneyReference): PublicKey { return this.getJourneyAddress(input); }
  private tx(name: keyof typeof V2_INSTRUCTION_DISCRIMINATORS, keys: AccountMeta[], args: Uint8Array = new Uint8Array(0)): Transaction {
    return new Transaction().add(new TransactionInstruction({ programId: this.programId, keys, data: Buffer.concat([Buffer.from([...V2_INSTRUCTION_DISCRIMINATORS[name]]), Buffer.from(args)]) }));
  }
  createJourney(input: JourneyReference & { deadline: number }): Transaction {
    assertJourneyReference(input.reference);
    if (!Number.isSafeInteger(input.deadline) || input.deadline <= 0) throw new Error('Deadline must be Unix seconds.');
    const bytes = Buffer.alloc(40); bytes.set(input.reference); view(bytes).setBigInt64(32, BigInt(input.deadline), true);
    return this.tx('createJourney', [meta(input.rider, true, true), meta(this.getJourneyAddress(input), false, true), meta(SystemProgram.programId)], bytes);
  }
  proposeGuardian(input: GuardianRevisionInput): Transaction {
    if (input.guardian.equals(input.rider) || input.guardian.equals(PublicKey.default)) throw new Error('Guardian must differ from rider and zero address.');
    return this.tx('proposeGuardian', [meta(input.rider, true), meta(this.getJourneyAddress(input), false, true)], Buffer.concat([input.guardian.toBuffer(), u32(input.expectedRevision)]));
  }
  private riderAction(name: 'cancelProposal' | 'completeJourney' | 'cancelJourney', input: RevisionInput): Transaction {
    return this.tx(name, [meta(input.rider, true), meta(this.getJourneyAddress(input), false, true)], u32(input.expectedRevision));
  }
  cancelProposal(input: RevisionInput): Transaction { return this.riderAction('cancelProposal', input); }
  completeJourney(input: RevisionInput): Transaction { return this.riderAction('completeJourney', input); }
  cancelJourney(input: RevisionInput): Transaction { return this.riderAction('cancelJourney', input); }
  acceptGuardian(input: GuardianRevisionInput): Transaction {
    return this.tx('acceptGuardian', [meta(input.guardian, true), meta(this.getJourneyAddress(input), false, true)], u32(input.expectedRevision));
  }
  checkIn(input: JourneyReference & { guardian: PublicKey; expectedSequence: number }): Transaction {
    return this.tx('checkIn', [meta(input.guardian, true), meta(this.getJourneyAddress(input), false, true)], u32(input.expectedSequence));
  }
  claimReward(input: JourneyReference & { guardian: PublicKey; payer: PublicKey }): Transaction {
    return this.tx('claimReward', [meta(input.payer, true, true), meta(input.guardian), meta(this.getJourneyAddress(input), false, true),
      meta(deriveReputationV2Address(input.guardian, this.programId), false, true), meta(SystemProgram.programId)]);
  }
  async prepareTransaction(transaction: Transaction, payer: PublicKey, commitment: Commitment = 'confirmed') {
    const latest = await this.connection.getLatestBlockhash(commitment);
    transaction.feePayer = payer; transaction.recentBlockhash = latest.blockhash;
    return { transaction, ...latest };
  }
  async isProgramDeployed(): Promise<boolean> { return Boolean((await this.connection.getAccountInfo(this.programId, 'confirmed'))?.executable); }
  async fetchJourney(input: JourneyReference): Promise<JourneyV2 | null> {
    const account = await this.connection.getAccountInfo(this.getJourneyAddress(input), 'confirmed');
    if (!account) return null;
    if (!account.owner.equals(this.programId)) throw new Error('Journey account has an unexpected program owner.');
    const result = decodeJourneyV2(account.data);
    if (!result.rider.equals(input.rider) || !result.reference.every((byte, i) => byte === input.reference[i])) throw new Error('Journey identity mismatch.');
    return result;
  }
  async fetchReputation(guardian: PublicKey): Promise<ReputationV2 | null> {
    const account = await this.connection.getAccountInfo(deriveReputationV2Address(guardian, this.programId), 'confirmed');
    if (!account) return null;
    if (!account.owner.equals(this.programId)) throw new Error('Reputation account has an unexpected program owner.');
    const result = decodeReputationV2(account.data);
    if (!result.guardian.equals(guardian)) throw new Error('Reputation guardian mismatch.');
    return result;
  }
}
