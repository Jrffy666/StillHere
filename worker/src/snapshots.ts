import { z } from 'zod';
import { agentStateSchema } from './agent';
import { assistanceSchema, escalationSchema, aiConsentSchema } from './assistance';
import { communityStateSchema, communityEventSchema } from './community-events';
const time=z.number().int().nonnegative().safe();
const count=z.number().int().nonnegative().safe();
const wallet=z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const person=z.object({id:z.string().min(1).max(100),name:z.string().max(60),simulated:z.boolean().optional(),wallet:wallet.nullable().optional()}).strict();
const place=z.object({label:z.string().max(160),lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180)}).strict();
const rewardStatus=z.enum(['pending','credited','ineligible','demo']);
const contribution=z.object({guardian:person,checkIns:count,startedAt:time,endedAt:time.nullable(),points:count.max(25),reputation:count.max(10),rewardStatus}).strict();
export const tripSnapshotSchema=z.object({
  community:communityStateSchema.optional(),communityEvents:z.array(communityEventSchema).max(50000).optional(),
  gratitude:z.array(z.object({id:z.uuid(),guardianId:z.uuid(),kind:z.enum(['companionship','thoughtfulness','relay']),createdAt:time,
    status:z.enum(['pending','recorded','cancelled']),nextAttemptAt:time,inFlightUntil:time}).strict()).max(10000).optional(),
  chainApplications:z.record(z.uuid(),z.object({candidate:person,revoked:z.boolean()}).strict()).optional(),
  schemaVersion:z.literal(2),chainSequence:count.optional(),chainSlot:count.optional(),closedAt:time.optional(),
  rewardEligible:z.boolean(),staleAlerted:z.boolean(),lastNotificationAt:time,monitoringStartedAt:time.nullable(),indexVersion:count,indexedVersion:count,
  assessmentVersion:count,aiNextCheckInAt:time.nullable(),aiMissedCheckIns:count,automatedEscalationSent:z.boolean(),
  providerBudget:z.object({decisions:count,inputChars:count,runs:z.record(z.string().max(100),z.object({decisions:count,inputChars:count}).strict())}).strict().optional(),
  paidAiBudget:z.object({requests:count,reservedTokens:count,inputTokens:count,outputTokens:count,totalTokens:count,lastRequestAt:time}).strict().optional(),
  notificationJobs:z.record(z.string().max(100),z.object({attempts:count,retryAt:time,inFlightUntil:time}).strict()),
  trip:z.object({
    agent:agentStateSchema.optional(),
    assistance:assistanceSchema.optional(),escalation:escalationSchema.optional(),
    aiConsent:z.record(z.string().max(100),aiConsentSchema).optional(),liveAiAvailable:z.boolean().optional(),
    id:z.uuid(),demo:z.boolean(),chainEnabled:z.boolean().optional(),privacyExpiresAt:time.nullable().optional(),
    status:z.enum(['open','active','arrived','cancelled']),rider:person,guardian:person.nullable(),guardMode:z.enum(['waiting','human','ai']),
    guardianRequests:z.array(z.object({id:z.uuid(),kind:z.enum(['initial','relay']),candidate:person,createdAt:time,expiresAt:time}).strict()).max(5),
    relay:z.object({id:z.uuid(),requestedBy:person,requestedAt:time,expiresAt:time}).strict().nullable(),contributions:z.array(contribution).max(10000),
    origin:place,destination:place,location:z.object({lat:z.number().min(-90).max(90),lng:z.number().min(-180).max(180),updatedAt:time}).strict(),
    createdAt:time,updatedAt:time,checkInIntervalSeconds:z.number().int().min(30).max(300),nextCheckInAt:time.nullable(),lastGuardianCheckInAt:time.nullable(),
    risk:z.enum(['normal','attention','urgent']),ai:z.object({mode:z.enum(['rules','openai']),lastAssessment:z.string().max(5000)}).strict(),
    messages:z.array(z.object({id:z.uuid(),at:time,senderId:z.string().max(100),senderName:z.string().max(60),role:z.enum(['rider','guardian','agent','system']),text:z.string().max(5000),automatedBy:z.enum(['rules','openai']).optional()}).strict()).max(150),
    events:z.array(z.object({id:z.uuid(),at:time,type:z.string().max(100),title:z.string().max(200),detail:z.string().max(5000)}).strict()).max(200),
    notifications:z.array(z.object({id:z.uuid(),at:time,cause:escalationSchema.shape.cause.optional(),status:z.enum(['queued','sent','failed','acknowledged','simulated']),channel:z.enum(['webhook','demo','none']),message:z.string().max(5000),detail:z.string().max(5000)}).strict()).max(1000),
    reward:z.object({points:count.max(25),reputation:count.max(10),status:rewardStatus}).strict(),
    shareUrl:z.url().max(1500).optional(),emergencyContact:z.object({name:z.string().max(80),contact:z.string().max(160)}).strict().optional(),notificationConsent:z.boolean(),
  }).strict(),
}).strict().refine(value=>{
  const banners=value.gratitude??[];
  return new Set(banners.map(item=>item.id)).size===banners.length
    && new Set(banners.map(item=>item.guardianId)).size===banners.length
    && (!banners.length||!value.trip.demo&&(value.trip.status==='arrived'||value.trip.status==='cancelled'))
    && banners.every(item=>item.guardianId!==value.trip.rider.id&&value.trip.contributions.some(contribution=>
      contribution.guardian.id===item.guardianId&&!contribution.guardian.simulated&&contribution.checkIns>0));
},'Gratitude must belong to distinct checked-in guardians of an ended real journey.').refine(value=>{
  if(!value.community)return !value.communityEvents?.length;
  const events=value.communityEvents;
  return !value.trip.demo&&Boolean(events?.length)&&events!.length===value.community.sequence
    && events!.every((event,index)=>event.journeyId===value.community!.journeyId&&event.sequence===index&&(!index||event.observedAt>=events![index-1].observedAt))
    && events![0].kind==='created'&&events![0].actorId===value.community.members[value.trip.rider.id]
    && events!.filter(event=>event.kind==='assigned').length===value.community.assignment;
},'Official community snapshots must preserve their complete ordered publication intents.');

const member=z.object({person,wallet}).strict();
const chainContribution=z.object({wallet,checkIns:count,startedAt:time,endedAt:time,points:count.max(25),reputation:count.max(10),claimed:z.boolean()}).strict();
export const chainSnapshotSchema=z.object({
  tripId:z.uuid(),reference:z.string().regex(/^[a-f0-9]{64}$/),programId:wallet,network:z.enum(['devnet','localnet']),rider:member,members:z.array(member).max(100),
  proposal:z.object({applicationId:z.uuid(),member}).strict().nullable(),
  snapshot:z.object({address:wallet,state:z.enum(['uncreated','open','active','completed','cancelled']),currentGuardian:wallet.nullable(),proposedGuardian:wallet.nullable(),
    proposalExpiresAt:time,revision:count.max(0xffffffff),sequence:count.max(0xffffffff),deadline:time,slot:count,contributions:z.array(chainContribution).max(16)}).strict(),
  intents:z.array(z.object({id:z.uuid(),actorId:z.uuid(),wallet,operation:z.enum(['create','propose','cancel-proposal','accept','check-in','complete','cancel','claim']),
    status:z.enum(['prepared','submitted','confirmed','failed','expired']),createdAt:time,expiresAt:time,transaction:z.string().max(5000),message:z.string().max(5000),
    blockhash:wallet,lastValidBlockHeight:count,signature:z.string().max(100).nullable(),signedTransaction:z.string().max(5000).nullable(),error:z.string().max(1000).nullable()}).strict()).max(32),
  updatedAt:time,lastError:z.string().max(1000).nullable(),preparingUntil:time.optional(),
}).strict();
