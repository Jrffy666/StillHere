'use client';
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { api, errorMessage, timeLabel } from '@/lib/api';
import type { Trip } from '@/lib/types';

const command = 'npm run codex:demo -- --input "$env:USERPROFILE\\Downloads\\safety-guard-request.json" --output ".dev/codex-demo-result.json" --confirm-synthetic';

/** A deliberate file handoff, never a public proxy to a personal Codex session. */
export function CodexDemo({trip,token,viewerId,busy}:{trip:Trip;token:string;viewerId:string;busy:boolean}) {
  const cache=useQueryClient();
  const [consent,setConsent]=useState(false),[saving,setSaving]=useState(false),[status,setStatus]=useState('');
  const [result,setResult]=useState<unknown>(null),[preview,setPreview]=useState('');
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[]);
  if(trip.rider.id!==viewerId)return null;
  const closed=trip.status==='arrived'||trip.status==='cancelled';
  const eligible=!closed&&trip.guardMode==='ai'&&trip.assistance?.automatedCheckIns!==false&&trip.escalation?.cause!=='explicit_help';
  const pending=trip.codexDemo?.status==='pending';
  const fresh=pending&&trip.codexDemo!.expiresAt>now;
  async function update(response:{trip:Trip}) {
    await cache.cancelQueries({queryKey:['trip',viewerId,trip.id]});
    cache.setQueryData(['trip',viewerId,trip.id],response);
  }
  async function exportRequest() {
    if(saving||busy||!consent||!eligible)return;
    setSaving(true);setStatus('');setResult(null);setPreview('');
    try {
      const response=await api<{request:unknown;trip:Trip}>(`/trips/${trip.id}/codex-demo/export`,token,{consent:true,syntheticOnly:true,noticeVersion:'codex-demo-v1'});
      await update({trip:response.trip});
      const url=URL.createObjectURL(new Blob([JSON.stringify(response.request,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='safety-guard-request.json';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      setStatus('Request downloaded. Review it, run Codex locally, then select the result file below.');
    } catch(error){setStatus(errorMessage(error));}finally{setSaving(false);}
  }
  async function readResult(file:File|undefined) {
    setResult(null);setPreview('');setStatus('');
    if(!file)return;
    try {
      if(file.size>16384)throw new Error('Choose a result JSON file smaller than 16 KB.');
      const text=await file.text();
      const parsed:unknown=JSON.parse(text);
      if(typeof parsed!=='object'||parsed===null||!('kind' in parsed)||parsed.kind!=='safety-guard-codex-result'||!('jobId' in parsed)||parsed.jobId!==trip.codexDemo?.id)throw new Error('This is not the result for the current request. Export a new request if it has expired.');
      setResult(parsed);setPreview(JSON.stringify(parsed,null,2));
      setStatus('Review this local result before applying it. The server checks sources and current journey permissions again.');
    } catch(error){setStatus(errorMessage(error));}
  }
  async function submit(kind:'import'|'cancel') {
    if(saving||busy)return;setSaving(true);setStatus('');
    try {
      const response=await api<{trip:Trip}>(`/trips/${trip.id}/codex-demo/${kind}`,token,kind==='import'?result:{jobId:trip.codexDemo?.id});
      await update(response);setResult(null);setPreview('');setConsent(false);
      setStatus(kind==='import'?'Result accepted. The guarded harness will record any permitted action in this journey.':'Pending request cancelled. Its result can no longer be applied.');
    } catch(error){setStatus(errorMessage(error));}finally{setSaving(false);}
  }
  return <details className="codex-demo">
    <summary>Local Codex demo</summary>
    <p className="simple-note">Use your own signed-in Codex CLI for a manual rehearsal. Export → run locally → review and import. This does not activate the OpenAI API or continuous AI monitoring.</p>
    <div className="assistance-options"><label htmlFor={`codex-consent-${trip.id}`}><Checkbox id={`codex-consent-${trip.id}`} checked={consent} disabled={saving||busy||!eligible} onCheckedChange={setConsent}/><span>This journey contains only fictional demo data. I agree to export my recent messages and saved concerns for processing through my own Codex account.</span></label></div>
    <p className="simple-note">Guardian messages, account and contact fields, and exact location fields are excluded. Review the downloaded file for personal details before running it. Your Codex account&apos;s data controls and usage limits apply.</p>
    {!eligible&&!closed&&<p className="simple-note">Available during automated coverage with check-ins enabled and no active request for help.</p>}
    <div className="codex-actions"><Button size="sm" variant="outline" disabled={!consent||!eligible||busy||saving} onClick={()=>void exportRequest()}>{pending?'Replace request':'Export request'}</Button>{pending&&<Button size="sm" variant="ghost" disabled={busy||saving} onClick={()=>void submit('cancel')}>Cancel request</Button>}</div>
    {pending&&<>
      <p className="simple-note">{fresh?`Import before ${timeLabel(trip.codexDemo!.expiresAt)}. New journey activity may invalidate this request.`:'Request expired. Export a new one to continue.'}</p>
      <details><summary>Run on this computer</summary><p className="simple-note">Open PowerShell in the Safety Guard project folder. After reviewing the downloaded file, run:</p><pre className="codex-code">{command}</pre><p className="simple-note">If your browser renamed the download, update the input filename. Select <code>.dev/codex-demo-result.json</code> after the command finishes.</p></details>
      <label className="codex-file-label" htmlFor={`codex-result-${trip.id}`}>Choose local result JSON</label>
      <Input key={trip.codexDemo!.id} id={`codex-result-${trip.id}`} type="file" accept=".json,application/json" disabled={!fresh||!eligible||saving||busy} onChange={event=>void readResult(event.target.files?.[0])}/>
      {preview&&<details open><summary>Review proposed result</summary><pre className="codex-code">{preview}</pre><p className="simple-note">Uploaded by you; model provenance and reported usage are not independently verified. Import does not grant authority to send contact alerts or award community recognition.</p><Button size="sm" disabled={!result||!fresh||!eligible||saving||busy} onClick={()=>void submit('import')}>Apply reviewed result</Button></details>}
    </>}
    {status&&<output className="simple-note" aria-live="polite">{status}</output>}
  </details>;
}
