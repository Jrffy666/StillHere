import type { AgentContext, AgentDecision, AgentRun } from './agent';
import { redactAgentText } from './agent';
import { assistanceEnabled, LIVE_AI_NOTICE_VERSION } from './assistance';
import { renderSemanticQuestion, validateSemanticAssessment } from './agent-semantic';
import { isClosed, type Trip, type WorkerEnv } from './types';

export const MAX_JOURNEY_AI_REQUESTS=12;
export const MAX_JOURNEY_AI_RESERVED_TOKENS=120000;
export const AI_REQUEST_COOLDOWN_MS=10000;
export const isAllowedOpenAIModel=(model:string)=>['gpt-4.1-mini','gpt-4.1-mini-2025-04-14'].includes(model);
export function openAiAvailable(env:WorkerEnv):boolean {
  return env.OPENAI_ENABLED==='true' && Boolean(env.OPENAI_API_KEY?.trim()) && isAllowedOpenAIModel(env.OPENAI_MODEL);
}
export function participantAiConsent(trip:Trip,id:string):boolean {
  const consent=trip.aiConsent?.[id];
  return consent?.accepted===true && consent.noticeVersion===LIVE_AI_NOTICE_VERSION;
}
export function canUseLiveAi(env:WorkerEnv,trip:Trip):boolean {
  return openAiAvailable(env)&&!isClosed(trip)&&trip.guardMode==='ai'&&assistanceEnabled(trip)
    &&trip.assistance?.liveAiConsent===true&&trip.assistance.noticeVersion===LIVE_AI_NOTICE_VERSION
    &&participantAiConsent(trip,trip.rider.id)&&trip.escalation?.cause!=='explicit_help'&&trip.codexDemo?.status!=='pending';
}
export function canUseCodexDemo(trip:Trip):boolean {
  return !isClosed(trip)&&trip.guardMode==='ai'&&assistanceEnabled(trip)&&trip.escalation?.cause!=='explicit_help';
}
export function canUseSemanticRun(env:WorkerEnv,trip:Trip,run:AgentRun):boolean {
  if(!run.semantic)return false;
  if(run.semantic.source!=='codex_local')return canUseLiveAi(env,trip);
  if(!canUseCodexDemo(trip)||run.semantic.expiresAt<=Date.now()||trip.codexDemo?.id!==run.semantic.jobId||trip.codexDemo.status!=='consumed')return false;
  try{validateSemanticAssessment(run.semantic.assessment,{...run.semantic.context,now:Date.now()});return true;}catch{return false;}
}
/** Only explicitly consenting message authors enter the external-provider snapshot. */
export function liveAiContext(trip:Trip,base:AgentContext):AgentContext {
  const messages=trip.messages.filter(message=>(message.role==='rider'&&message.senderId===trip.rider.id
      ||message.role==='guardian'&&message.senderId===trip.guardian?.id)&&participantAiConsent(trip,message.senderId))
    .slice(-12).map(({id,at,role,text})=>({id,at,role,text:redactAgentText(text,800)}));
  return {...base,messages,notifications:base.notifications.map(({id,status})=>({id,status,detail:''})),
    unresolvedConcerns:participantAiConsent(trip,trip.rider.id)?base.unresolvedConcerns?.map(item=>({...item,text:redactAgentText(item.text)}))??[]:[]};
}
/** The model supplies a bounded plan. Execution still uses the existing five scoped tools. */
export function nextSemanticDecision(run:AgentRun,context:AgentContext):AgentDecision {
  const assessment=run.semantic!.assessment,used=(name:string)=>run.steps.some(step=>step.call.name===name);
  if(!used('send_check_in')&&assessment.question.kind!=='none')return {type:'tool',call:{name:'send_check_in',arguments:{text:renderSemanticQuestion(assessment,run.semantic!.context).slice(0,600)}}};
  if(assessment.requestRelay&&!context.relayOpen&&['takeover','rider-message','codex-import'].includes(run.trigger.kind)&&!used('request_human_relay'))return {type:'tool',call:{name:'request_human_relay',arguments:{reason:'The model proposed human coverage from current journey evidence. Rider approval is still required.'}}};
  if(!used('schedule_follow_up'))return {type:'tool',call:{name:'schedule_follow_up',arguments:{delaySeconds:assessment.followUpSeconds}}};
  return {type:'complete',summary:'The proposed semantic assistance plan has finished its permitted local actions.'};
}
