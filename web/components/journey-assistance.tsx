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
    <p className="simple-note">Offline reminders only. OpenAI is not connected. Human companions remain responsible for their own check-ins.</p>
    <div className="assistance-options">
      <label htmlFor={`assistance-checkins-${trip.id}`}><Checkbox id={`assistance-checkins-${trip.id}`} checked={policy.automatedCheckIns} disabled={!rider||closed||busy||saving} onCheckedChange={checked=>void change('automatedCheckIns',checked)} /><span>Ask me to check in when my guardian is unavailable.</span></label>
      <label htmlFor={`assistance-contact-${trip.id}`}><Checkbox id={`assistance-contact-${trip.id}`} checked={policy.timeoutContact} disabled={!rider||closed||busy||saving||!policy.automatedCheckIns} onCheckedChange={checked=>void change('timeoutContact',checked)} /><span>After two unanswered automated check-ins, attempt to notify my trusted contact.</span></label>
    </div>
    <p className="simple-note">Contact alerts also require a saved contact, notification consent, and a configured delivery service. “I need help” remains available when reminders are off. Chat wording alone never authorizes a contact alert.</p>
    {status&&<output className="simple-note">{status}</output>}
    {concerns.length>0&&<div className="assistance-concerns"><strong>Needs clarification</strong><p className="simple-note">Possible concerns from rider messages, not verified danger. Only the rider can mark them resolved. Up to eight remain pinned; additional messages stay in conversation history.</p>{concerns.map(concern=><div className="assistance-concern" key={concern.id}><div><p>{concern.text}</p><time dateTime={new Date(concern.observedAt).toISOString()}>{timeLabel(concern.observedAt)}</time></div>{rider&&!closed&&<Button variant="outline" size="sm" disabled={busy||saving} onClick={()=>void act({action:'resolve-concern',requestId:concern.id}).catch(()=>{})}>Resolved</Button>}</div>)}</div>}
    {trip.agent?.handoffSummary&&<details><summary>Last automated handoff</summary><p className="simple-note">Historical snapshot. Check current messages and contact alert status for later changes.</p><p className="assistance-summary">{trip.agent.handoffSummary}</p></details>}
  </details>;
}
