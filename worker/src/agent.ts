import { z } from 'zod';

/** Offline protocol shared by the provider, durable runner, and participant UI. */
export interface AgentTrigger {
  id: string;
  kind: 'takeover' | 'rider-message' | 'follow-up' | 'stale-location' | 'notification-failure';
  at: number;
  messageId?: string;
}

const ToolCallSchema = z.discriminatedUnion('name', [
  z.object({ name: z.literal('get_journey_context'), arguments: z.object({}).strict() }).strict(),
  z.object({ name: z.literal('send_check_in'), arguments: z.object({ text: z.string().trim().min(1).max(600) }).strict() }).strict(),
  z.object({ name: z.literal('schedule_follow_up'), arguments: z.object({ delaySeconds: z.number().int().min(30).max(300) }).strict() }).strict(),
  z.object({ name: z.literal('request_human_relay'), arguments: z.object({ reason: z.string().trim().min(1).max(300) }).strict() }).strict(),
  z.object({ name: z.literal('notify_trusted_contact'), arguments: z.object({ reason: z.string().trim().min(1).max(300) }).strict() }).strict(),
]);

export type AgentToolCall = z.infer<typeof ToolCallSchema>;

/** Throws on unsupported tools, unbounded arguments, and extra properties. */
export function parseAgentToolCall(input: unknown): AgentToolCall {
  return ToolCallSchema.parse(input);
}

/** No identity, contact address, wallet, shared URL, or coordinates are exposed. */
export interface AgentContext {
  now: number;
  status: 'open' | 'active' | 'arrived' | 'cancelled';
  guardMode: 'waiting' | 'human' | 'ai';
  risk: 'normal' | 'attention' | 'urgent';
  location: { updatedAt: number; ageSeconds: number; stale: boolean };
  messages: { id: string; at: number; role: 'rider' | 'guardian' | 'agent' | 'system'; text: string }[];
  relayOpen: boolean;
  notifications: { id: string; status: 'queued' | 'sent' | 'failed' | 'acknowledged' | 'simulated'; detail: string }[];
  contactAvailable: boolean;
}

export interface AgentToolResult { ok: boolean; code: string; detail: string; context?: AgentContext }
export interface AgentStep {
  id: string;
  call: AgentToolCall;
  status: 'pending' | 'succeeded' | 'rejected';
  at: number;
  result?: AgentToolResult;
}
export interface AgentRun {
  id: string;
  trigger: AgentTrigger;
  provider: 'mock';
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
  createdAt: number;
  updatedAt: number;
  revision: number;
  steps: AgentStep[];
  summary?: string;
  error?: string;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number;
}
export interface AgentState {
  provider: 'mock';
  liveModel: false;
  runs: AgentRun[];
  followUpAt: number | null;
  handoffSummary: string | null;
}
export type AgentDecision = { type: 'tool'; call: AgentToolCall } | { type: 'complete'; summary: string };

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const identifier = z.string().min(1).max(200);
const contextSchema: z.ZodType<AgentContext> = z.object({
  now: timestamp,
  status: z.enum(['open', 'active', 'arrived', 'cancelled']),
  guardMode: z.enum(['waiting', 'human', 'ai']),
  risk: z.enum(['normal', 'attention', 'urgent']),
  location: z.object({ updatedAt: timestamp, ageSeconds: z.number().nonnegative(), stale: z.boolean() }).strict(),
  messages: z.array(z.object({ id: identifier, at: timestamp, role: z.enum(['rider', 'guardian', 'agent', 'system']), text: z.string().max(2000) }).strict()).max(12),
  relayOpen: z.boolean(),
  notifications: z.array(z.object({ id: identifier, status: z.enum(['queued', 'sent', 'failed', 'acknowledged', 'simulated']), detail: z.string().max(1000) }).strict()).max(20),
  contactAvailable: z.boolean(),
}).strict();
const toolResultSchema = z.object({ ok: z.boolean(), code: z.string().min(1).max(100), detail: z.string().max(1000), context: contextSchema.optional() }).strict();
const stepSchema = z.object({
  id: identifier, call: ToolCallSchema, status: z.enum(['pending', 'succeeded', 'rejected']), at: timestamp, result: toolResultSchema.optional(),
}).strict();
export const agentStateSchema: z.ZodType<AgentState> = z.object({
  provider: z.literal('mock'), liveModel: z.literal(false),
  runs: z.array(z.object({
    id: identifier,
    trigger: z.object({ id: identifier, kind: z.enum(['takeover', 'rider-message', 'follow-up', 'stale-location', 'notification-failure']), at: timestamp, messageId: identifier.optional() }).strict(),
    provider: z.literal('mock'), status: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']),
    createdAt: timestamp, updatedAt: timestamp, revision: z.number().int().nonnegative(),
    steps: z.array(stepSchema).max(8), summary: z.string().max(4000).optional(), error: z.string().max(1000).optional(),
    attempts: z.number().int().min(0).max(3), nextAttemptAt: timestamp, leaseUntil: timestamp,
  }).strict()).max(20),
  followUpAt: timestamp.nullable(), handoffSummary: z.string().max(4000).nullable(),
}).strict();

const recentWindowMs = 300_000;
const concernPattern = /\b(route|detour|lost|uncomfortable|worried|strange|wrong|not sure|uneasy)\b|路线|绕路|不对|不安|担心|迷路|不确定|不舒服|不太放心|ruta|desv[ií]o|inquiet|d[ée]tour/i;
const urgentPattern = /\b(help|unsafe|danger|threat|weapon|attack|emergency|scared|following|won.t let me|can.t (?:leave|get out))\b|救命|危险|害怕|求助|需要帮助|无法下车|不能下车|ayuda|peligro|au secours/i;
const okayPattern = /\b(i(?:['’]m| am) (?:okay|ok|fine)|all (?:good|fine)|feel safe)\b|我没事|我很好|一切正常|没问题|estoy bien|tout va bien/i;

function recentRiderMessages(context: AgentContext) {
  return context.messages
    .filter(message => message.role === 'rider' && Number.isFinite(message.at) && message.at <= context.now && context.now - message.at <= recentWindowMs)
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
}

function locationUncertain(context: AgentContext): boolean {
  return context.location.stale || !Number.isFinite(context.location.updatedAt) || context.location.updatedAt > context.now;
}

function notificationStatus(context: AgentContext): string {
  const latest = context.notifications.at(-1);
  if (!latest) return '';
  switch (latest.status) {
    case 'queued': return 'A contact notification is queued; delivery is not confirmed.';
    case 'sent': return 'The provider accepted a contact notification; recipient acknowledgement is pending.';
    case 'failed': return 'Contact notification delivery was not confirmed. Contact someone you trust directly if you can.';
    case 'acknowledged': return 'A contact notification was acknowledged; this does not confirm that help is on the way.';
    case 'simulated': return 'The contact notification is simulated; no external message was sent.';
  }
}

function buildPlan(trigger: AgentTrigger, context: AgentContext): AgentToolCall[] {
  // Array order, stale reassurance, and future timestamps cannot override a newer concern.
  // Only rider messages are evidence; text never selects a tool, recipient, or URL.
  const recent = recentRiderMessages(context);
  const latest = recent[0];
  const tied = latest ? recent.filter(message => message.at === latest.at) : [];
  const concern = tied.some(message => concernPattern.test(message.text));
  const urgent = context.risk === 'urgent' || tied.some(message => urgentPattern.test(message.text));
  const reassurance = !concern && !urgent && tied.some(message => okayPattern.test(message.text));
  const uncertainty = locationUncertain(context);

  let prompt: string;
  if (trigger.kind === 'notification-failure') {
    prompt = `${notificationStatus(context) || 'Contact notification delivery was not confirmed. Can you safely contact someone you trust directly?'} This run will not resend the notification.`;
  } else if (urgent) {
    prompt = 'Your request for help remains active. If you are in immediate danger, contact your local emergency service when safe. Can you safely contact someone you trust?';
  } else if (concern) {
    prompt = 'Your latest message suggests uncertainty about the journey. What has changed, and do you feel comfortable with the current route? Use “I need help” if you need escalation.';
  } else if (uncertainty || trigger.kind === 'stale-location') {
    prompt = 'The location update is missing or out of date. This alone does not establish danger. Are you okay, and can you share a fresh update when safe?';
  } else if (reassurance) {
    prompt = 'Your latest check-in says you are okay. Monitoring and any existing concern remain active. Tell us if something changes.';
  } else {
    prompt = trigger.kind === 'follow-up'
      ? 'This is a scheduled check-in while a human guardian is unavailable. Are you okay, or would you like help?'
      : 'A human guardian is unavailable. Are you comfortable with the journey? You can request help at any time.';
  }
  const delivery = trigger.kind === 'notification-failure' ? '' : notificationStatus(context);
  const freshness = uncertainty && (concern || urgent || trigger.kind === 'notification-failure')
    ? ' Location is out of date or unverified; it does not establish danger.' : '';
  const text = `Offline mock guardian: ${prompt}${freshness}${delivery ? ` ${delivery}` : ''}`;
  const calls: AgentToolCall[] = [parseAgentToolCall({ name: 'send_check_in', arguments: { text } })];
  // Notification failure is a bounded status update, never a second notification loop.
  if ((trigger.kind === 'takeover' || trigger.kind === 'rider-message') && !context.relayOpen) {
    calls.push({ name: 'request_human_relay', arguments: { reason: 'Offline mock: a human guardian is unavailable. Request a replacement; rider approval is still required.' } });
  }
  // Consent and urgency must also be rechecked by the executor immediately before effect.
  // An existing notification owns delivery/retry; the provider never duplicates it.
  if (trigger.kind !== 'notification-failure' && context.risk === 'urgent' && context.contactAvailable && context.notifications.length === 0) {
    calls.push({ name: 'notify_trusted_contact', arguments: { reason: 'Offline mock: an urgent request remains active. Start the consented contact workflow and report its actual result.' } });
  }
  calls.push({ name: 'schedule_follow_up', arguments: { delaySeconds: urgent ? 30 : 60 } });
  return calls;
}

function completionSummary(steps: AgentStep[], context: AgentContext): string {
  const effects = steps.filter(step => step.call.name !== 'get_journey_context');
  const succeeded = effects.filter(step => step.status === 'succeeded' && step.result?.ok).length;
  const rejected = effects.length - succeeded;
  const contact = effects.find(step => step.call.name === 'notify_trusted_contact');
  const contactDetail = contact
    ? ` Contact workflow ${contact.status === 'succeeded' && contact.result?.ok ? 'accepted' : 'not confirmed'}: ${contact.result?.detail.slice(0, 180) ?? 'No result recorded.'} Recipient response is not established by this run.`
    : ` ${notificationStatus(context) || 'No contact notification was recorded at this snapshot.'}`;
  const relay = effects.find(step => step.call.name === 'request_human_relay');
  const relayDetail = relay
    ? `Relay workflow ${relay.status === 'succeeded' && relay.result?.ok ? 'accepted' : 'did not succeed'}: ${relay.result?.detail.slice(0, 180) ?? 'No result recorded.'}`
    : context.relayOpen ? 'A relay request was open at the snapshot.' : 'No open relay was recorded at the snapshot.';
  const latest = recentRiderMessages(context)[0];
  const riderDetail = latest
    ? ` Latest recent rider text (${new Date(latest.at).toISOString()}): ${JSON.stringify(latest.text.slice(0, 160))}.`
    : ' No recent rider message was available.';
  return `Offline mock run, context snapshot ${new Date(context.now).toISOString()}. Recorded risk: ${context.risk}. Location: ${locationUncertain(context) ? 'stale or unverified' : 'fresh at snapshot'}.${riderDetail} ${relayDetail}${contactDetail} ${succeeded} tool action${succeeded === 1 ? '' : 's'} succeeded${rejected ? `; ${rejected} did not succeed` : ''}.`.slice(0, 1200);
}

/**
 * A deterministic test provider, not an LLM or a claim of real-world reasoning.
 * Persist each call and its actual result before invoking this function again.
 * The durable executor owns authorization, freshness, deduplication, and retries.
 */
export async function nextMockDecision(trigger: AgentTrigger, steps: AgentStep[]): Promise<AgentDecision> {
  if (steps.some(step => step.status === 'pending')) throw new Error('Resolve the pending agent tool call before requesting another decision.');
  const contextSteps = steps.filter(step => step.call.name === 'get_journey_context');
  if (!contextSteps.length) return { type: 'tool', call: { name: 'get_journey_context', arguments: {} } };
  const contextStep = contextSteps.at(-1)!;
  const context = contextStep.status === 'succeeded' && contextStep.result?.ok ? contextStep.result.context : undefined;
  if (!context) return { type: 'complete', summary: 'Offline mock run stopped: journey context could not be read. No further action was attempted.' };
  if (context.status !== 'active' || context.guardMode !== 'ai') {
    return { type: 'complete', summary: 'Offline mock run stopped: this journey is no longer under automated guarding.' };
  }
  const attempted = new Set(steps.map(step => step.call.name));
  const call = buildPlan(trigger, context).find(candidate => !attempted.has(candidate.name));
  return call ? { type: 'tool', call } : { type: 'complete', summary: completionSummary(steps, context) };
}
