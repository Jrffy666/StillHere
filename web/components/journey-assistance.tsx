'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { api, errorMessage, timeLabel } from '@/lib/api';
import type { Trip } from '@/lib/types';
import type { ActionBody } from '@/components/trip-detail';

export function JourneyAssistance({trip,token,viewerId,busy,act}:{trip:Trip;token:string;viewerId:string;busy:boolean;act:(body:ActionBody)=>Promise<void>}) {
  const cache=useQueryClient();
  const [saving,setSaving]=useState(false),[status,setStatus]=useState('');
  const closed=trip.status==='arrived'||trip.status==='cancelled',rider=trip.rider.id===viewerId;
  const policy=trip.assistance??{automatedCheckIns:true,timeoutContact:false,liveAiConsent:false,noticeVersion:'openai-assistance-v1' as const,updatedAt:0};
  const aiConsent=trip.aiConsent?.[viewerId]?.accepted===true;
  async function changeAiConsent(consent:boolean){
    if(saving||busy)return;setSaving(true);setStatus('');
    try{
      const response=await api<{trip:Trip}>(`/trips/${trip.id}/ai-consent`,token,{consent,noticeVersion:'openai-assistance-v2'});
      await cache.cancelQueries({queryKey:['trip',viewerId,trip.id]});cache.setQueryData(['trip',viewerId,trip.id],response);
      setStatus(consent?'AI processing preference saved. Model assistance also requires the rider’s consent and active automated coverage.':'Future AI processing of your messages is disabled.');
    }catch(error){setStatus(errorMessage(error));}finally{setSaving(false);}
  }
  async function change(key:'automatedCheckIns'|'timeoutContact',value:boolean) {
    if(saving||busy)return;
    setSaving(true);setStatus('');
    try {
      const {updatedAt:_,...settings}=policy;
      const response=await api<{trip:Trip}>(`/trips/${trip.id}/assistance`,token,{...settings,[key]:value});
      await cache.cancelQueries({queryKey:['trip',viewerId,trip.id]});
      cache.setQueryData(['trip',viewerId,trip.id],response);
      setStatus('Preferences saved.');
    } catch(error){setStatus(errorMessage(error));}
    finally{setSaving(false);}
  }
  const concerns=trip.agent?.concerns??[];
  return <details className="simple-details journey-assistance">
    <summary>Automated assistance · {policy.automatedCheckIns?'On':'Off'}{concerns.length?` · ${concerns.length} open concern${concerns.length===1?'':'s'}`:''}</summary>
    <p className="simple-note">{trip.liveAiAvailable?'OpenAI assistance is available with participant consent.':'OpenAI integration is switched off. Offline reminders remain available; no messages are sent to a model.'} Human companions remain responsible for their own check-ins.</p>
    <div className="assistance-options">
      <label htmlFor={`assistance-checkins-${trip.id}`}><Checkbox id={`assistance-checkins-${trip.id}`} checked={policy.automatedCheckIns} disabled={!rider||closed||busy||saving} onCheckedChange={checked=>void change('automatedCheckIns',checked)} /><span>Ask me to check in when my guardian is unavailable.</span></label>
      <label htmlFor={`assistance-contact-${trip.id}`}><Checkbox id={`assistance-contact-${trip.id}`} checked={policy.timeoutContact} disabled={!rider||closed||busy||saving||!policy.automatedCheckIns} onCheckedChange={checked=>void change('timeoutContact',checked)} /><span>After two unanswered automated check-ins, attempt to notify my trusted contact.</span></label>
    </div>
    <div className="assistance-options"><label htmlFor={`assistance-ai-${trip.id}`}><Checkbox id={`assistance-ai-${trip.id}`} checked={aiConsent} disabled={closed||busy||saving||(!trip.liveAiAvailable&&!aiConsent)} onCheckedChange={checked=>void changeAiConsent(checked)} /><span>Allow OpenAI to interpret my journey messages for questions and human handoffs.</span></label></div>
    <p className="simple-note">When enabled, recent messages from consenting participants, saved rider concerns, timestamps and limited journey status are sent to OpenAI. Account, wallet and contact fields and exact coordinates are excluded. Personal details typed into chat may remain. Turning this off stops future processing; it cannot recall data already sent.</p>
    <details><summary>AI data use</summary><p className="simple-note">We request no stored response using store:false. This is not a guarantee of zero provider retention; OpenAI’s standard abuse-monitoring retention may apply. AI interpretations can be wrong. Human controls, help and contribution records remain governed by the application.</p><a className="text-action" href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer">OpenAI data controls</a></details>
    {trip.agent?.fallbackReason&&<p className="simple-note">AI assistance was unavailable or reached a limit. Rules-based reminders and human controls remain available.</p>}
    <p className="simple-note">Contact alerts also require a saved contact, notification consent, and a configured delivery service. “I need help” remains available when reminders are off. Chat wording alone never authorizes a contact alert.</p>
    {status&&<output className="simple-note">{status}</output>}
    {concerns.length>0&&<div className="assistance-concerns"><strong>Needs clarification</strong><p className="simple-note">Possible concerns from rider messages, not verified danger. Only the rider can mark them resolved. Up to eight remain pinned; additional messages stay in conversation history.</p>{concerns.map(concern=><div className="assistance-concern" key={concern.id}><div><p>{concern.text}</p><time dateTime={new Date(concern.observedAt).toISOString()}>{timeLabel(concern.observedAt)}</time></div>{rider&&!closed&&<Button variant="outline" size="sm" disabled={busy||saving} onClick={()=>void act({action:'resolve-concern',requestId:concern.id}).catch(()=>{})}>Resolved</Button>}</div>)}</div>}
    {trip.agent?.semanticHandoff&&<details><summary>AI interpretation & sources</summary><p className="simple-note">An interpretation of participant statements at {timeLabel(trip.agent.semanticHandoff.snapshotAt)}, not verified events. Review the original statements before acting.</p>{trip.agent.semanticHandoff.assessment.findings.map((finding,index)=><div className="assistance-concern" key={index}><div><strong>{finding.kind} · {finding.topic}</strong>{finding.sourceIds.map(id=>{
      const record=trip.agent!.semanticHandoff!;
      const source=record.context.messages.find(message=>`message:${message.id}`===id);
      const concern=record.context.unresolvedConcerns?.find(item=>`concern:${item.id}`===id);
      return <blockquote key={id}><p>{source?.text??concern?.text??'Source unavailable'}</p>{(source||concern)&&<time>{source?.role??'rider'} · {timeLabel(source?.at??concern!.observedAt)}</time>}</blockquote>;
    })}</div></div>)}<p className="simple-note">{trip.agent.semanticHandoff.model} · {trip.agent.semanticHandoff.usage.totalTokens} reported tokens · {trip.agent.semanticHandoff.promptVersion}</p></details>}
    {trip.agent?.handoffSummary&&<details><summary>Last automated handoff</summary><p className="simple-note">Historical snapshot. Check current messages and contact alert status for later changes.</p><p className="assistance-summary">{trip.agent.handoffSummary}</p></details>}
  </details>;
}
