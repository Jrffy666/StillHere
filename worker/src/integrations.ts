import { z } from 'zod';
import { openAiAvailable } from './ai-runtime';
import type { Trip, WorkerEnv, Notification } from './types';

const Assessment = z.object({risk:z.enum(['normal','attention','urgent']),message:z.string().min(1).max(800)}).strict();
export type AssessmentResult = z.infer<typeof Assessment> & { mode: 'rules'|'openai' };

export async function boundedJson(response: Response, maximum = 64000): Promise<unknown> {
  if (!response.body) throw new Error('Empty response');
  const reader = response.body.getReader(); let count = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      count += value.byteLength; if (count > maximum) throw new Error('Response too large'); chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function ruleAssessment(text: string, explicitHelp = false): AssessmentResult {
  const urgent = explicitHelp || /\b(help|unsafe|danger|threat|weapon|attack|emergency|scared|following|won.t let me|can.t (?:leave|get out))\b|救命|危险|害怕|求助/i.test(text);
  return urgent
    ? {mode:'rules',risk:'urgent',message:'I have recorded your request for help. If you are in immediate danger, call your local emergency number when safe. If possible, move toward a public place and tell me whether you can safely contact someone you trust. Check notification status below; a sent message does not mean someone has responded.'}
    : {mode:'rules',risk:'attention',message:'I am monitoring this trip with the rules-based fallback. Are you comfortable with the current route? Use “I need help” to request escalation, or confirm that you are okay. A route change or missing update alone does not establish danger.'};
}

/** Legacy classifier boundary stays offline. Merely adding a key cannot enable paid calls. */
export async function assess(_env: WorkerEnv, text: string, _risk: Trip['risk']): Promise<AssessmentResult> {
  return ruleAssessment(text);
}

export async function sendNotification(env: WorkerEnv, trip: Trip, notification: Notification): Promise<Pick<Notification,'status'|'channel'|'detail'>> {
  if (trip.demo) return {status:'simulated',channel:'demo',detail:'Demo only: no external message was sent.'};
  if (!trip.notificationConsent || !trip.emergencyContact) return {status:'failed',channel:'none',detail:'No contact notification consent or contact is configured. Contact someone you trust directly.'};
  if (env.NOTIFICATIONS_ENABLED !== 'true' || !env.NOTIFICATION_WEBHOOK_URL || !env.NOTIFICATION_WEBHOOK_SECRET) return {status:'failed',channel:'none',detail:'External notifications are not configured. No message was sent. Contact someone you trust directly.'};
  let target: URL;
  try { target = new URL(env.NOTIFICATION_WEBHOOK_URL); } catch { return {status:'failed',channel:'none',detail:'The server notification provider is misconfigured.'}; }
  if (target.protocol !== 'https:') return {status:'failed',channel:'none',detail:'The notification provider requires HTTPS.'};
  try {
    const response = await fetch(target.toString(), {method:'POST',redirect:'manual',signal:AbortSignal.timeout(5000),
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${env.NOTIFICATION_WEBHOOK_SECRET}`,'Idempotency-Key':notification.id},
      // Only the server-configured receiver is contacted. Shared Uber URLs are never fetched.
      body:JSON.stringify({id:notification.id,tripId:trip.id,recipient:trip.emergencyContact,message:notification.message,location:trip.location,rider:trip.rider.name}),
    });
    await response.body?.cancel();
    // Workerd supports manual/follow redirects. Never forward contact data or the
    // provider credential to a destination supplied by a Location response header.
    if(response.status>=300&&response.status<400)return {status:'failed',channel:'webhook',detail:'The notification provider did not accept the message at its configured address. Contact someone you trust directly.'};
    return response.ok ? {status:'sent',channel:'webhook',detail:'The notification provider accepted the message. Recipient acknowledgement is pending.'}
      : {status:'failed',channel:'webhook',detail:'The notification provider rejected the message. Contact someone you trust directly.'};
  } catch { return {status:'failed',channel:'webhook',detail:'Notification delivery could not be confirmed. Contact someone you trust directly.'}; }
}

export function configuration(env: WorkerEnv) {
  return {
    ai:{provider:openAiAvailable(env)?'openai':'mock',configured:openAiAvailable(env),liveModel:openAiAvailable(env),model:openAiAvailable(env)?env.OPENAI_MODEL:null,noticeVersion:'openai-assistance-v2',detail:openAiAvailable(env)?'OpenAI semantic assistance is available only with current journey consent. Rules remain available.':'OpenAI integration is disabled. Offline rules remain active; no model request is made.'},
    notifications:{provider:env.NOTIFICATIONS_ENABLED === 'true' && env.NOTIFICATION_WEBHOOK_URL && env.NOTIFICATION_WEBHOOK_SECRET ? 'webhook' : 'demo',configured:env.NOTIFICATIONS_ENABLED === 'true' && Boolean(env.NOTIFICATION_WEBHOOK_URL && env.NOTIFICATION_WEBHOOK_SECRET)},
    voice:{provider:'elevenlabs',configured:Boolean(env.ELEVENLABS_API_KEY)},
    // Browser-only legacy proof uses a public endpoint; server RPC URLs may carry API keys.
    chain:{provider:'solana',network:'devnet',configured:Boolean(env.SOLANA_PROGRAM_ID),programId:env.SOLANA_PROGRAM_ID || null,rpcUrl:'https://api.devnet.solana.com'},
    chainV2:{configured:Boolean(env.SOLANA_V2_PROGRAM_ID),programId:env.SOLANA_V2_PROGRAM_ID || null,network:env.SOLANA_NETWORK || 'devnet'},
    uber:{configured:false,mode:'manual-sharing',detail:'Shared URLs are stored as links. This app does not fetch Uber trip telemetry.'},
    storage:{provider:'cloudflare-durable-objects',persistent:true,serverAlarms:true},
  };
}
