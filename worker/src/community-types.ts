import { z } from 'zod';
import type { CommunityEventInput } from '../../chain/src/community';

export type { CommunityEventInput } from '../../chain/src/community';
export const communityRef = z.string().regex(/^[0-9a-f]{64}$/).refine(value => !/^0+$/.test(value));
export const communityEventSchema = z.object({
  journeyId: communityRef, sequence: z.number().int().min(0).max(0xffffffff),
  kind: z.enum(['created','assigned','check_in','relay_requested','closed','contribution','gratitude','agent_service']),
  actorId: z.string().regex(/^[0-9a-f]{64}$/), subjectId: communityRef, assignment: z.number().int().min(0).max(0xffffffff),
  observedAt: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), value: z.number().int().min(0).max(3),
}).strict().refine(event=>event.actorId!=='0'.repeat(64)||(event.kind==='relay_requested'&&event.value===1)||(event.kind==='agent_service'&&[1,2].includes(event.value)), 'Only declared automated relay or agent-end events can omit a human actor.');
export type CommunityStatus = 'pending' | 'submitted' | 'finalized' | 'retry';
export interface CommunityRecordView {
  id: string; event: CommunityEventInput; points: number; reputation: number;
  status: CommunityStatus; evidence: 'platform_attested'; network: 'devnet' | 'localnet';
  programId: string | null; issuer:string|null; recordAddress: string | null; signature: string | null;
  finalizedAt: number | null; error: string | null; withdrawn: boolean;
  withdrawal:CommunityCorrectionView|null;
}
export interface CommunityTotals {points:number;reputation:number;contributions:number;banners:number;history:number}
export interface CommunityMemberLedger {
  memberId:string|null; evidence:'platform_attested'; network:'devnet'|'localnet'; programId:string|null; configured:boolean;
  finalized:CommunityTotals; pending:CommunityTotals; withdrawn:number;
  records:CommunityRecordView[];nextCursor:string|null;
}
export interface CommunityCorrectionView {
  journeyId:string;targetSequence:number;reason:1|2|3|4;sequence:number;observedAt:number;
  status:CommunityStatus;recordAddress:string|null;signature:string|null;finalizedAt:number|null;error:string|null;authority:string|null;
}
export const correctionSchema=z.object({journeyId:communityRef,targetSequence:z.number().int().min(0).max(0xffffffff),reason:z.union([z.literal(1),z.literal(2),z.literal(3),z.literal(4)])}).strict();
export type CommunityCorrectionInput=z.infer<typeof correctionSchema>;
export interface CommunityCorrectionPreparation {correction:CommunityCorrectionView;transaction:string;admin:string;expiresAt:number}
export interface CommunityChainConfiguration {configured:boolean;network:'devnet'|'localnet';programId:string|null;issuer:string|null;sponsor:string|null}
export interface CommunityChainResult {
  recordAddress:string; signature:string|null; finalizedAt:number|null; status:'submitted'|'finalized';points:number;reputation:number;
}
export interface CommunitySignedSubmission {signature:string;transaction:string;lastValidBlockHeight:number;expiresAt:number}
export interface CommunityStoredRecord extends CommunityRecordView {
  attempts:number;nextAttemptAt:number;leaseUntil:number;revision:number;indexedRevision:number;
  submission:CommunitySignedSubmission|null;
}
export const communityRecordId=(event:Pick<CommunityEventInput,'journeyId'|'sequence'>)=>`${event.journeyId}:${event.sequence}`;
export const emptyCommunityTotals=():CommunityTotals=>({points:0,reputation:0,contributions:0,banners:0,history:0});
