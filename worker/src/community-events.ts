import { z } from 'zod';
import type { GratitudeKind, Trip } from './types';

export const COMMUNITY_NOTICE_VERSION = 'community-v1' as const;
export const communityReference = z.string().regex(/^[a-f0-9]{64}$/).refine(value=>value!=='0'.repeat(64));
export const communityEventSchema = z.object({
  journeyId:communityReference,sequence:z.number().int().min(0).max(0xffffffff),
  kind:z.enum(['created','assigned','check_in','relay_requested','closed','contribution','gratitude','agent_service']),
  actorId:z.string().regex(/^[a-f0-9]{64}$/),subjectId:communityReference,assignment:z.number().int().min(0).max(0xffffffff),
  observedAt:z.number().int().nonnegative().safe(),value:z.number().int().min(0).max(3),
}).strict().refine(event=>event.actorId!=='0'.repeat(64)||event.kind==='relay_requested'&&event.value===1||event.kind==='agent_service'&&[1,2].includes(event.value));
export type SourceCommunityEvent=z.infer<typeof communityEventSchema>;
export const communityStateSchema=z.object({
  journeyId:communityReference,members:z.record(z.uuid(),communityReference),
  sequence:z.number().int().nonnegative().max(0xffffffff),assignment:z.number().int().nonnegative().max(0xffffffff),
  guardians:z.array(z.object({memberId:communityReference,lastAssignment:z.number().int().positive().max(0xffffffff),checkedIn:z.boolean()}).strict()).max(16),
}).strict();
export type SourceCommunityState=z.infer<typeof communityStateSchema>;
export function randomCommunityReference():string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
}
interface SourceState {
  trip:Trip;community?:SourceCommunityState;
  gratitude?:{id:string;guardianId:string;kind:GratitudeKind;createdAt:number;status:string}[];
}
/** Called synchronously inside the same transaction that persists the authorized business state. */
export function captureCommunityEvents(previous:SourceState|null,next:SourceState):SourceCommunityEvent[] {
  const community=next.community,trip=next.trip;
  if(!community||trip.demo)return [];
  const events:SourceCommunityEvent[]=[],rider=community.members[trip.rider.id];
  if(!rider)throw new Error('Official journey has no rider reference');
  const push=(kind:SourceCommunityEvent['kind'],actorId:string,subjectId:string,value=0,assignment=community.assignment,at=Date.now())=>{
    events.push({journeyId:community.journeyId,sequence:community.sequence++,kind,actorId,subjectId,assignment,observedAt:Math.floor(at/1000),value});
  };
  if(!previous?.community)push('created',rider,rider,0,0,trip.createdAt);
  const before=previous?.trip;
  // End service against the old assignment before a replacement or closure is recorded.
  const priorAgent=before?.personalAgent, nextAgent=trip.personalAgent;
  if(priorAgent?.status==='active'&&(nextAgent?.id!==priorAgent.id||nextAgent.status!=='active'||trip.guardian?.id!==priorAgent.ownerId||['arrived','cancelled'].includes(trip.status))){
    // Account erasure removes the next state's private mapping. Its prior opaque
    // member reference remains the already published subject of the service.
    const owner=previous?.community?.members[priorAgent.ownerId]??community.members[priorAgent.ownerId];
    if(owner&&before?.guardian?.id===priorAgent.ownerId){
      const resumed=nextAgent?.id===priorAgent.id&&nextAgent.endReason==='human_resumed'&&trip.guardian?.id===priorAgent.ownerId&&trip.guardMode==='human'&&!['arrived','cancelled'].includes(trip.status);
      const unavailable=nextAgent?.id===priorAgent.id&&nextAgent.status==='unavailable';
      push('agent_service',resumed?owner:'0'.repeat(64),owner,resumed?3:unavailable?2:1,previous?.community?.assignment??community.assignment);
    }
  }
  if(trip.guardian&&!trip.guardian.simulated&&trip.guardian.id!==before?.guardian?.id){
    const guardian=community.members[trip.guardian.id];
    if(!guardian)throw new Error('Official guardian has not accepted the public record notice');
    community.assignment+=1;
    const existing=community.guardians.find(item=>item.memberId===guardian);
    if(existing)existing.lastAssignment=community.assignment;
    else community.guardians.push({memberId:guardian,lastAssignment:community.assignment,checkedIn:false});
    push('assigned',rider,guardian);
  }
  if(nextAgent?.status==='active'&&(priorAgent?.id!==nextAgent.id||priorAgent.status!=='active')&&!['arrived','cancelled'].includes(trip.status)){
    const owner=community.members[nextAgent.ownerId];
    if(owner&&trip.guardian?.id===nextAgent.ownerId)push('agent_service',owner,owner,0);
  }
  // Only the currently accepted assignment can attest a newly observed check-in.
  // A late aggregate V2 snapshot must never fabricate a former assignment's chronology.
  if(trip.guardian&&!trip.guardian.simulated){
    const current=trip.contributions.find(item=>item.guardian.id===trip.guardian!.id);
    const old=before?.contributions?.find(item=>item.guardian.id===trip.guardian!.id);
    const count=Math.max(0,(current?.checkIns??0)-(old?.checkIns??0));
    const guardian=community.members[trip.guardian.id];
    if(count&&guardian&&(!before||!['arrived','cancelled'].includes(before.status))){
      push('check_in',guardian,guardian);const slot=community.guardians.find(item=>item.memberId===guardian);if(slot)slot.checkedIn=true;
    }
  }
  if(trip.relay&&trip.relay.id!==before?.relay?.id&&trip.guardian){
    const subject=community.members[trip.guardian.id],actor=community.members[trip.relay.requestedBy.id];
    if(subject)push('relay_requested',actor??'0'.repeat(64),subject,actor?0:1);
  }
  const closed=['arrived','cancelled'].includes(trip.status),wasClosed=Boolean(before&&['arrived','cancelled'].includes(before.status));
  if(closed&&!wasClosed){
    const expired=trip.events.at(-1)?.type==='expired';
    push('closed',rider,rider,trip.status==='arrived'?1:expired?3:2);
    if(trip.status==='arrived'){
      for(const item of community.guardians.filter(item=>item.checkedIn)){
        push('contribution',item.memberId,item.memberId,0,item.lastAssignment);
      }
    }
  }
  for(const banner of next.gratitude??[]){
    if((previous?.gratitude??[]).some(item=>item.id===banner.id)||banner.status==='cancelled')continue;
    const recipient=community.members[banner.guardianId];
    if(recipient)push('gratitude',rider,recipient,({companionship:1,thoughtfulness:2,relay:3} as const)[banner.kind],community.guardians.find(item=>item.memberId===recipient)?.lastAssignment??0,banner.createdAt);
  }
  return events;
}
