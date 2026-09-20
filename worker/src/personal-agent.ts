import { z } from 'zod';
import { contextSchema, type AgentContext } from './agent';
import { semanticAssessmentSchema } from './agent-semantic';
import { prepareOpenAIRequest } from './openai-provider';
import type { Trip } from './types';

export const PERSONAL_AGENT_NOTICE_VERSION = 'personal-agent-v1';
export const PERSONAL_AGENT_CONNECTIVITY_MS = 45_000;
export const PERSONAL_AGENT_RESPONSE_MS = 90_000;
export const PERSONAL_AGENT_MAX_RECEIPTS = 40;
export const PERSONAL_AGENT_TOKEN_PATTERN = /^shpa_[a-f0-9]{64}$/;
const time = z.number().int().nonnegative().safe();
const nullableTime = time.nullable();
const status = z.enum(['requested','approved','connecting','active','revoked','expired','unavailable','ended']);

export const delegationInputSchema = z.discriminatedUnion('action', [
  z.object({action:z.literal('request'),agentName:z.string().trim().min(1).max(40).regex(/^[^\x00-\x1f\x7f]+$/),minutes:z.number().int().min(5).max(120),consent:z.literal(true),noticeVersion:z.literal(PERSONAL_AGENT_NOTICE_VERSION)}).strict(),
  z.object({action:z.literal('approve'),delegationId:z.uuid(),consent:z.literal(true),noticeVersion:z.literal(PERSONAL_AGENT_NOTICE_VERSION)}).strict(),
  z.object({action:z.literal('connect'),delegationId:z.uuid()}).strict(),
  z.object({action:z.literal('revoke'),delegationId:z.uuid()}).strict(),
]);
export const personalAgentOperationSchema = z.enum(['status','accept','updates','heartbeat','assess','release']);
export type PersonalAgentOperation = z.infer<typeof personalAgentOperationSchema>;
export const personalAgentEmptyInputSchema = z.object({}).strict();
export const personalAgentAssessmentInputSchema = z.object({jobId:z.uuid(),assessment:semanticAssessmentSchema}).strict();
export const personalAgentReleaseInputSchema = z.object({reason:z.enum(['stopped','model_unavailable','limit_reached'])}).strict();

export const personalAgentReceiptSchema = z.object({
  id:z.uuid(),jobId:z.uuid(),at:time,assessment:semanticAssessmentSchema,summary:z.string().max(4000),
  actions:z.array(z.object({name:z.enum(['retain_concerns','send_check_in','request_human_relay','schedule_follow_up']),outcome:z.string().max(80),detail:z.string().max(400)}).strict()).max(4),
}).strict();
export type PersonalAgentReceipt = z.infer<typeof personalAgentReceiptSchema>;
export const personalAgentViewSchema = z.object({
  id:z.uuid(),ownerId:z.uuid(),ownerName:z.string().max(60),agentName:z.string().max(40),status,
  createdAt:time,expiresAt:time,riderApprovedAt:nullableTime,connectedAt:nullableTime,lastSeenAt:nullableTime,
  lastProcessedAt:nullableTime,nextResponseDueAt:nullableTime,lastActionAt:nullableTime,endedAt:nullableTime,
  endReason:z.string().max(100).nullable(),connectionIssued:z.boolean(),receipts:z.array(personalAgentReceiptSchema).max(PERSONAL_AGENT_MAX_RECEIPTS),
}).strict();
export type PersonalAgentView = z.infer<typeof personalAgentViewSchema>;
export const personalAgentJobSchema = z.object({id:z.uuid(),revision:z.number().int().nonnegative().safe(),createdAt:time,expiresAt:time,context:contextSchema}).strict();
export type PersonalAgentJob = z.infer<typeof personalAgentJobSchema>;
export const personalAgentConnectionSchema = z.object({
  version:z.literal(1),kind:z.literal('stillhere-agent-connection'),origin:z.url().max(500).refine(value=>{
    const url=new URL(value);return url.origin===value&&!url.username&&!url.password&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));
  }),tripId:z.uuid(),delegationId:z.uuid(),token:z.string().regex(PERSONAL_AGENT_TOKEN_PATTERN),expiresAt:time,
}).strict();
export type PersonalAgentConnection = z.infer<typeof personalAgentConnectionSchema>;
export interface PersonalAgentResponse {delegation:PersonalAgentView;job:PersonalAgentJob|null;receipt?:PersonalAgentReceipt}
export const personalAgentResponseSchema=z.object({delegation:personalAgentViewSchema,job:personalAgentJobSchema.nullable(),receipt:personalAgentReceiptSchema.optional()}).strict();

/** Never copied into Trip or directory responses. Export/restore drops all runtime authority. */
export const personalAgentStateSchema = z.object({
  view:personalAgentViewSchema,tokenDigest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  noticeVersion:z.literal(PERSONAL_AGENT_NOTICE_VERSION),guardianApprovedAt:time,
  assignmentStartedAt:time,assignmentSequence:z.number().int().nonnegative().safe(),
  pending:personalAgentJobSchema.nullable(),authorityContext:contextSchema.nullable(),
  responseDeadline:nullableTime,nextJobAt:nullableTime,
  completed:z.array(z.object({jobId:z.uuid(),assessment:semanticAssessmentSchema,revision:z.number().int().nonnegative().safe(),authorityContext:contextSchema,receipt:personalAgentReceiptSchema}).strict()).max(PERSONAL_AGENT_MAX_RECEIPTS),
  rate:z.object({window:time,count:z.number().int().nonnegative().safe()}).strict(),
}).strict();
export type PersonalAgentState = z.infer<typeof personalAgentStateSchema>;
export const personalAgentLive = (value:PersonalAgentState|undefined) => Boolean(value&&['requested','approved','connecting','active'].includes(value.view.status));
export const personalAgentConnected = (value:PersonalAgentState|undefined) => Boolean(value&&['connecting','active'].includes(value.view.status));

/** Pure preparation only: reuses minimization without making a hosted model call. */
export function personalAgentContext(trip:Trip,ownerId:string,context:AgentContext):AgentContext {
  const eligible={...context,guardMode:'ai' as const,messages:trip.messages.filter(message=>
    message.role==='rider'&&message.senderId===trip.rider.id||message.role==='guardian'&&message.senderId===ownerId)
    .slice(-12).map(({id,at,role,text})=>({id,at,role,text})),unresolvedConcerns:trip.agent?.concerns??[]};
  return contextSchema.parse(prepareOpenAIRequest({model:'gpt-4.1-mini-2025-04-14',context:eligible}).context);
}

/** Ignore wall-clock age increments but reject transitions across the stale boundary. */
export function personalAgentContextChanged(before:AgentContext,after:AgentContext):boolean {
  const fingerprint=(value:AgentContext)=>JSON.stringify({status:value.status,guardMode:value.guardMode,risk:value.risk,
    location:{updatedAt:value.location.updatedAt,stale:value.location.stale},messages:value.messages,
    relayOpen:value.relayOpen,escalationCause:value.escalationCause,unresolvedConcerns:value.unresolvedConcerns??[]});
  return fingerprint(before)!==fingerprint(after);
}
