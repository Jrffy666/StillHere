import type { Person } from './types';

export type ChainOperation = 'create' | 'propose' | 'cancel-proposal' | 'accept' | 'check-in' | 'complete' | 'cancel' | 'claim';
export type ChainTxStatus = 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'expired';
export interface ChainContribution {
  wallet: string; checkIns: number; startedAt: number; endedAt: number; points: number; reputation: number; claimed: boolean;
}
export interface ChainSnapshot {
  address: string; state: 'uncreated' | 'open' | 'active' | 'completed' | 'cancelled';
  currentGuardian: string | null; proposedGuardian: string | null; proposalExpiresAt: number;
  revision: number; sequence: number; deadline: number; slot: number; contributions: ChainContribution[];
}
export interface ChainIntent {
  id: string; actorId: string; wallet: string; operation: ChainOperation; status: ChainTxStatus;
  createdAt: number; expiresAt: number; transaction: string; message: string;
  blockhash: string; lastValidBlockHeight: number; signature: string | null;
  signedTransaction: string | null; error: string | null;
}
export interface ChainMember { person: Person; wallet: string }
export interface ChainBinding {
  tripId: string; reference: string; programId: string; network: 'devnet' | 'localnet';
  rider: ChainMember; members: ChainMember[]; proposal: {applicationId:string; member:ChainMember} | null;
  snapshot: ChainSnapshot; intents: ChainIntent[]; updatedAt: number; lastError: string | null;
  preparingUntil?: number;
}
export interface ChainView {
  version: 2; reference: string; programId: string; network: string; riderWallet: string;
  snapshot: ChainSnapshot; updatedAt: number; lastError: string | null;
  wallet: string | null; canAccept: boolean; canClaim: boolean;
  intents: Array<Pick<ChainIntent, 'id' | 'operation' | 'status' | 'signature' | 'error' | 'createdAt'>>;
}
