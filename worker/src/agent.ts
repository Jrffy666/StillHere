import { z } from 'zod';
import { semanticAssessmentSchema, type SemanticAssessment } from './agent-semantic';
import { redactAgentText } from './agent-text';
export { redactAgentText } from './agent-text';

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

/** A rider concern remains unresolved until the rider explicitly resolves it. */
export interface AgentConcern { id: string; observedAt: number; receivedAt: number; text: string }

/** Structured identifiers are omitted; free text still requires minimization. */
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
  escalationCause?: 'explicit_help' | 'user_authorized_timeout_policy' | 'model_concern' | null;
  notificationAuthorized?: boolean;
  unresolvedConcerns?: AgentConcern[];
}

export interface AgentEvidence {
  id: string;
  source: 'journey_snapshot' | 'message' | 'retained_concern' | 'tool_receipt' | 'notification';
  actor: 'rider' | 'guardian' | 'agent' | 'system';
  observedAt: number | null;
  receivedAt: number | null;
  freshness: 'recent' | 'older' | 'unverified';
  text: string;
}
export interface AgentHandoff {
  version: 1;
  mode: 'offline_rules' | 'openai_assisted';
  snapshotAt: number;
  snapshotSourceId: string;
  status: AgentContext['status'];
  guardMode: AgentContext['guardMode'];
  risk: AgentContext['risk'];
  escalationCause: NonNullable<AgentContext['escalationCause']> | null;
  notificationAuthorized: boolean;
  location: { observedAt: number | null; freshness: 'fresh' | 'stale_or_unverified' };
  sources: AgentEvidence[];
  unresolvedConcerns: (AgentConcern & { sourceId: string })[];
  actions: {
    sourceId: string; tool: AgentToolCall['name']; at: number;
    status: 'succeeded' | 'rejected' | 'unconfirmed'; code: string | null; summary: string;
  }[];
  notifications: { sourceId: string; id: string; status: AgentContext['notifications'][number]['status'] }[];
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
  provider: 'mock' | 'openai';
  semantic?: SemanticRecord;
  semanticAttempt?: {id:string;status:'reserved'|'completed'|'failed'|'discarded';reservedTokens:number;error?:string;usage?:ModelUsage};
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
  provider: 'mock' | 'openai';
  liveModel: boolean;
  semanticHandoff?: SemanticRecord | null;
  fallbackReason?: string | null;
  runs: AgentRun[];
  followUpAt: number | null;
  handoffSummary: string | null;
  concerns?: AgentConcern[];
  structuredHandoff?: AgentHandoff | null;
}
export type AgentDecision = { type: 'tool'; call: AgentToolCall } | { type: 'complete'; summary: string };
export interface ModelUsage {inputTokens:number;outputTokens:number;totalTokens:number}
export interface SemanticRecord {assessment:SemanticAssessment;context:AgentContext;responseId:string;model:string;requestId:string|null;promptVersion:string;usage:ModelUsage;snapshotAt:number}

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const identifier = z.string().min(1).max(200);
const sourceIdentifier = z.string().min(1).max(240);
const concernSchema: z.ZodType<AgentConcern> = z.object({ id: identifier, observedAt: timestamp, receivedAt: timestamp, text: z.string().max(600) }).strict();
const escalationCauseSchema = z.enum(['explicit_help', 'user_authorized_timeout_policy', 'model_concern']).nullable();
const notificationStateSchema = z.enum(['queued', 'sent', 'failed', 'acknowledged', 'simulated']);
export const contextSchema: z.ZodType<AgentContext> = z.object({
  now: timestamp,
  status: z.enum(['open', 'active', 'arrived', 'cancelled']),
  guardMode: z.enum(['waiting', 'human', 'ai']),
  risk: z.enum(['normal', 'attention', 'urgent']),
  location: z.object({ updatedAt: timestamp, ageSeconds: z.number().nonnegative(), stale: z.boolean() }).strict(),
  messages: z.array(z.object({ id: identifier, at: timestamp, role: z.enum(['rider', 'guardian', 'agent', 'system']), text: z.string().max(2000) }).strict()).max(12),
  relayOpen: z.boolean(),
  notifications: z.array(z.object({ id: identifier, status: notificationStateSchema, detail: z.string().max(1000) }).strict()).max(20),
  contactAvailable: z.boolean(),
  escalationCause: escalationCauseSchema.optional(),
  notificationAuthorized: z.boolean().optional(),
  unresolvedConcerns: z.array(concernSchema).max(8).optional(),
}).strict();
export const agentHandoffSchema: z.ZodType<AgentHandoff> = z.object({
  version: z.literal(1), mode: z.enum(['offline_rules','openai_assisted']), snapshotAt: timestamp, snapshotSourceId: sourceIdentifier,
  status: z.enum(['open', 'active', 'arrived', 'cancelled']), guardMode: z.enum(['waiting', 'human', 'ai']),
  risk: z.enum(['normal', 'attention', 'urgent']), escalationCause: escalationCauseSchema, notificationAuthorized: z.boolean(),
  location: z.object({ observedAt: timestamp.nullable(), freshness: z.enum(['fresh', 'stale_or_unverified']) }).strict(),
  sources: z.array(z.object({
    id: sourceIdentifier, source: z.enum(['journey_snapshot', 'message', 'retained_concern', 'tool_receipt', 'notification']),
    actor: z.enum(['rider', 'guardian', 'agent', 'system']), observedAt: timestamp.nullable(), receivedAt: timestamp.nullable(),
    freshness: z.enum(['recent', 'older', 'unverified']), text: z.string().max(600),
  }).strict()).max(49),
  unresolvedConcerns: z.array(z.object({ id: identifier, observedAt: timestamp, receivedAt: timestamp, text: z.string().max(600), sourceId: sourceIdentifier }).strict()).max(8),
  actions: z.array(z.object({
    sourceId: sourceIdentifier, tool: z.enum(['get_journey_context', 'send_check_in', 'schedule_follow_up', 'request_human_relay', 'notify_trusted_contact']),
    at: timestamp, status: z.enum(['succeeded', 'rejected', 'unconfirmed']), code: z.string().max(100).nullable(), summary: z.string().max(600),
  }).strict()).max(8),
  notifications: z.array(z.object({ sourceId: sourceIdentifier, id: identifier, status: notificationStateSchema }).strict()).max(20),
}).strict().superRefine((handoff, validation) => {
  const byId = new Map(handoff.sources.map(source => [source.id, source]));
  const invalid = (message: string) => validation.addIssue({ code: 'custom', message });
  if (byId.size !== handoff.sources.length) invalid('Evidence source IDs must be unique.');
  const snapshot = byId.get(handoff.snapshotSourceId);
  if (snapshot?.source !== 'journey_snapshot' || snapshot.observedAt !== handoff.snapshotAt) invalid('Snapshot must reference its supplied server evidence.');
  for (const concern of handoff.unresolvedConcerns) {
    const source = byId.get(concern.sourceId);
    if (source?.source !== 'retained_concern' || source.actor !== 'rider' || source.observedAt !== concern.observedAt || source.receivedAt !== concern.receivedAt || source.text !== concern.text) invalid('Unresolved concern must match its supplied rider evidence.');
  }
  for (const action of handoff.actions) {
    const source = byId.get(action.sourceId);
    if (source?.source !== 'tool_receipt' || source.observedAt !== action.at || source.text !== action.summary) invalid('Action must match its execution evidence.');
  }
  for (const notice of handoff.notifications) {
    if (byId.get(notice.sourceId)?.source !== 'notification') invalid('Notification must reference its supplied server evidence.');
  }
});
const toolResultSchema = z.object({ ok: z.boolean(), code: z.string().min(1).max(100), detail: z.string().max(1000), context: contextSchema.optional() }).strict();
const stepSchema = z.object({
  id: identifier, call: ToolCallSchema, status: z.enum(['pending', 'succeeded', 'rejected']), at: timestamp, result: toolResultSchema.optional(),
}).strict();
export const modelUsageSchema=z.object({inputTokens:z.number().int().nonnegative().max(1000000),outputTokens:z.number().int().nonnegative().max(1000000),totalTokens:z.number().int().nonnegative().max(2000000)}).strict();
export const semanticRecordSchema:z.ZodType<SemanticRecord>=z.object({assessment:semanticAssessmentSchema,context:contextSchema,responseId:identifier,model:z.string().max(100),requestId:identifier.nullable(),promptVersion:z.string().max(100),usage:modelUsageSchema,snapshotAt:timestamp}).strict();
export const agentStateSchema: z.ZodType<AgentState> = z.object({
  provider: z.enum(['mock','openai']), liveModel: z.boolean(),
  semanticHandoff:semanticRecordSchema.nullable().optional(),fallbackReason:z.string().max(200).nullable().optional(),
  runs: z.array(z.object({
    id: identifier,
    trigger: z.object({ id: identifier, kind: z.enum(['takeover', 'rider-message', 'follow-up', 'stale-location', 'notification-failure']), at: timestamp, messageId: identifier.optional() }).strict(),
    provider: z.enum(['mock','openai']), status: z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']),
    semantic:semanticRecordSchema.optional(),semanticAttempt:z.object({id:identifier,status:z.enum(['reserved','completed','failed','discarded']),reservedTokens:z.number().int().nonnegative().max(33200),error:z.string().max(200).optional(),usage:modelUsageSchema.optional()}).strict().optional(),
    createdAt: timestamp, updatedAt: timestamp, revision: z.number().int().nonnegative(),
    steps: z.array(stepSchema).max(8), summary: z.string().max(4000).optional(), error: z.string().max(1000).optional(),
    attempts: z.number().int().min(0).max(3), nextAttemptAt: timestamp, leaseUntil: timestamp,
  }).strict()).max(20),
  followUpAt: timestamp.nullable(), handoffSummary: z.string().max(4000).nullable(),
  concerns: z.array(concernSchema).max(8).optional(), structuredHandoff: agentHandoffSchema.nullable().optional(),
}).strict().refine(state => state.liveModel === (state.provider === 'openai'), 'Provider and live-model labels must agree.');

const recentWindowMs = 300_000;
const concernPattern = /\b(route|detour|lost|uncomfortable|worried|strange|wrong|not sure|uneasy)\b|路线|绕路|不对|不安|担心|迷路|不确定|不舒服|不太放心|ruta|desv[ií]o|inquiet|d[ée]tour/i;
const urgentPattern = /\b(help|unsafe|danger|threat|weapon|attack|emergency|scared|following|won.t let me|can.t (?:leave|get out))\b|救命|危险|害怕|求助|需要帮助|无法下车|不能下车|ayuda|peligro|au secours/i;
const okayPattern = /\b(i(?:['’]m| am) (?:okay|ok|fine)|all (?:good|fine)|feel safe)\b|我没事|我很好|一切正常|没问题|estoy bien|tout va bien/i;

/** A bounded heuristic for retaining possible concerns, never proof of danger or contact authority. */
export function hasAgentConcern(text: string): boolean {
  const remaining = text.slice(0, 2000)
    .replace(/\b(?:do not|don['’]t|does not|doesn['’]t|no longer|never|not)\s+(?:need|want)\s+(?:any\s+)?help\b/gi, ' ')
    .replace(/\b(?:not|never|no longer)\s+(?:currently\s+)?(?:in\s+)?(?:any\s+)?(?:danger|unsafe|scared|worried|uneasy|uncomfortable|lost|wrong|strange)\b/gi, ' ')
    .replace(/\bno\s+(?:danger|threat|weapon|attack|emergency)\b/gi, ' ')
    .replace(/(?:没有|并无)(?:危险|威胁)|(?:并不|不)(?:害怕|担心)|不需要(?:求助|帮助)/g, ' ')
    .replace(/\bno\s+(?:necesito\s+ayuda|hay\s+peligro)\b|\bpas\s+en\s+danger\b/gi, ' ');
  if (/\b(?:not|don['’]t feel|do not feel)\s+(?:okay|ok|fine|safe|comfortable)\b|\bno estoy seguro\b|\b(?:changed|different|unfamiliar)\s+route\b/i.test(remaining)) return true;
  // Merely mentioning a route is not a concern. More specific terms remain available to the shared patterns.
  const specific = remaining.replace(/\b(?:route|ruta)\b|路线/gi, ' ');
  return concernPattern.test(specific) || urgentPattern.test(specific);
}

function recentRiderMessages(context: AgentContext) {
  return context.messages
    .filter(message => message.role === 'rider' && Number.isFinite(message.at) && message.at <= context.now && context.now - message.at <= recentWindowMs)
    .sort((left, right) => right.at - left.at || left.id.localeCompare(right.id));
}

function locationUncertain(context: AgentContext): boolean {
  return context.location.stale || !Number.isFinite(context.location.updatedAt) || context.location.updatedAt <= 0 || context.location.updatedAt > context.now;
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

/** Fixed server wording: a provider cannot invent delivery, assignment, or safety claims. */
export function renderAgentCheckIn(trigger: AgentTrigger, context: AgentContext): string {
  // Array order, stale reassurance, and future timestamps cannot override a newer concern.
  // Only rider messages are evidence; text never selects a tool, recipient, or URL.
  const recent = recentRiderMessages(context);
  const latest = recent[0];
  const tied = latest ? recent.filter(message => message.at === latest.at) : [];
  const concern = Boolean(context.unresolvedConcerns?.length) || tied.some(message => concernPattern.test(message.text));
  const urgent = context.risk === 'urgent' || tied.some(message => urgentPattern.test(message.text));
  const reassurance = !concern && !urgent && tied.some(message => okayPattern.test(message.text));
  const uncertainty = locationUncertain(context);

  let prompt: string;
  if (trigger.kind === 'notification-failure') {
    prompt = `${notificationStatus(context) || 'Contact notification delivery was not confirmed. Can you safely contact someone you trust directly?'} This run will not resend the notification.`;
  } else if (context.escalationCause === 'explicit_help') {
    prompt = 'Your request for help remains active. If you are in immediate danger, contact your local emergency service when safe. Can you safely contact someone you trust?';
  } else if (context.escalationCause === 'user_authorized_timeout_policy') {
    prompt = 'The response deadline in your authorized timeout policy was reached. This does not establish danger. Are you okay, and can you contact someone you trust if needed?';
  } else if (urgent) {
    prompt = 'An offline rule flagged possible concern; it cannot establish danger or a request for help. What has changed, and do you need help?';
  } else if (concern) {
    prompt = context.unresolvedConcerns?.length
      ? 'An earlier rider concern is still unresolved. What has changed, and do you feel comfortable with the current route? Only your explicit resolve action clears saved concerns.'
      : 'An offline rule found possible uncertainty in your latest message. What has changed, and do you feel comfortable with the current route? Use “I need help” if you need escalation.';
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
  return `Offline mock guardian: ${prompt}${freshness}${delivery ? ` ${delivery}` : ''}`;
}

function buildPlan(trigger: AgentTrigger, context: AgentContext): AgentToolCall[] {
  const text = renderAgentCheckIn(trigger, context);
  const calls: AgentToolCall[] = [parseAgentToolCall({ name: 'send_check_in', arguments: { text } })];
  // Notification failure is a bounded status update, never a second notification loop.
  if ((trigger.kind === 'takeover' || trigger.kind === 'rider-message') && !context.relayOpen) {
    calls.push({ name: 'request_human_relay', arguments: { reason: 'Offline mock: a human guardian is unavailable. Request a replacement; rider approval is still required.' } });
  }
  // Consent and urgency must also be rechecked by the executor immediately before effect.
  // An existing notification owns delivery/retry; the provider never duplicates it.
  if (trigger.kind !== 'notification-failure' && context.notificationAuthorized === true && context.risk === 'urgent' && context.contactAvailable && context.notifications.length === 0) {
    calls.push({ name: 'notify_trusted_contact', arguments: { reason: 'Offline mock: the server reports a currently authorized contact workflow. Check that authorization again and report its actual result.' } });
  }
  calls.push({ name: 'schedule_follow_up', arguments: { delaySeconds: context.risk === 'urgent' ? 30 : 60 } });
  return calls;
}

function evidenceFreshness(at: number | null, now: number): AgentEvidence['freshness'] {
  return at === null || !Number.isFinite(at) || at > now ? 'unverified' : now - at <= recentWindowMs ? 'recent' : 'older';
}

/** Only allowlisted executor result codes establish an effect; arbitrary result prose is ignored. */
function receiptSummary(step: AgentStep): string {
  if (step.status === 'pending' || !step.result) return 'No completed execution receipt; the action is unconfirmed.';
  if (step.status !== 'succeeded' || !step.result.ok) return 'The action did not succeed; no completed effect is established.';
  const summaries: Partial<Record<AgentToolCall['name'], Record<string, string>>> = {
    send_check_in: { check_in_posted: 'An automated check-in was posted; reading it is unconfirmed.' },
    schedule_follow_up: { follow_up_scheduled: 'A server follow-up was scheduled.' },
    request_human_relay: {
      demo_relay: 'A relay request was simulated; no real guardian was recruited.',
      relay_already_open: 'Recruitment was already open; rider approval is still required.',
      relay_requested: 'Recruitment was opened; no guardian was approved or granted private access.',
    },
    notify_trusted_contact: {
      notification_already_exists: 'An existing notification owns delivery; no additional notification was queued.',
      notification_queued: 'A contact notification was queued; delivery and recipient response are unconfirmed.',
      notification_rate_limited: 'No additional notification was queued because a recent notification covers this interval.',
    },
  };
  return summaries[step.call.name]?.[step.result.code] ?? 'The executor reported success; this result code does not establish a specific effect.';
}

/** Build from supplied source records and server receipts, never from a proposed model summary. */
export function buildAgentHandoff(steps: AgentStep[], context: AgentContext): AgentHandoff {
  const snapshotStep = steps.filter(step => step.call.name === 'get_journey_context' && step.status === 'succeeded' && step.result?.ok).at(-1);
  // A completion render may use fresh server state after the original read. Do not
  // attribute that newer evidence to a receipt containing a different snapshot.
  const matchesRead = snapshotStep?.result?.context && JSON.stringify(snapshotStep.result.context) === JSON.stringify(context);
  const snapshotSourceId = snapshotStep && matchesRead ? `snapshot:${snapshotStep.id}` : `snapshot:${context.now}`;
  const sources: AgentEvidence[] = [{
    id: snapshotSourceId, source: 'journey_snapshot', actor: 'system', observedAt: context.now, receivedAt: context.now,
    freshness: 'recent', text: `Server snapshot: journey ${context.status}, coverage ${context.guardMode}, recorded risk ${context.risk}. These fields do not establish real-world safety.`,
  }];
  const messages = [...new Map(context.messages.slice(-12).map(message => [message.id, message])).values()];
  for (const message of messages) sources.push({
    id: `message:${message.id}`, source: 'message', actor: message.role, observedAt: message.at, receivedAt: null,
    freshness: evidenceFreshness(message.at, context.now), text: redactAgentText(message.text),
  });
  const unresolvedConcerns = [...new Map((context.unresolvedConcerns ?? []).map(concern => [concern.id, concern])).values()].slice(0, 8).map(concern => ({
    ...concern, text: redactAgentText(concern.text), sourceId: `concern:${concern.id}`,
  }));
  for (const concern of unresolvedConcerns) sources.push({
    id: concern.sourceId, source: 'retained_concern', actor: 'rider', observedAt: concern.observedAt, receivedAt: concern.receivedAt,
    freshness: evidenceFreshness(concern.observedAt, context.now), text: concern.text,
  });
  const effectSteps = [...new Map(steps.filter(step => step.call.name !== 'get_journey_context').map(step => [step.id, step])).values()].slice(-8);
  const actions: AgentHandoff['actions'] = effectSteps.map(step => ({
    sourceId: `tool:${step.id}`, tool: step.call.name, at: step.at,
    status: !step.result || step.status === 'pending' ? 'unconfirmed' : step.status === 'succeeded' && step.result.ok ? 'succeeded' : 'rejected',
    code: step.result?.code ?? null, summary: receiptSummary(step),
  }));
  for (const action of actions) sources.push({
    id: action.sourceId, source: 'tool_receipt', actor: 'system', observedAt: action.at, receivedAt: null,
    freshness: evidenceFreshness(action.at, context.now), text: action.summary,
  });
  const notifications = [...new Map(context.notifications.slice(-20).map(notice => [notice.id, notice])).values()].map(notice => ({ sourceId: `notification:${notice.id}`, id: notice.id, status: notice.status }));
  for (const notice of notifications) sources.push({
    id: notice.sourceId, source: 'notification', actor: 'system', observedAt: null, receivedAt: null, freshness: 'unverified',
    text: notificationStatus({ ...context, notifications: [{ id: notice.id, status: notice.status, detail: '' }] }),
  });
  return {
    version: 1, mode: 'offline_rules', snapshotAt: context.now, snapshotSourceId,
    status: context.status, guardMode: context.guardMode, risk: context.risk,
    escalationCause: context.escalationCause ?? null, notificationAuthorized: context.notificationAuthorized === true,
    location: { observedAt: Number.isFinite(context.location.updatedAt) && context.location.updatedAt > 0 ? context.location.updatedAt : null, freshness: locationUncertain(context) ? 'stale_or_unverified' : 'fresh' },
    sources, unresolvedConcerns, actions, notifications,
  };
}

/** Server-only factual rendering; no provider-authored summary or tool argument is accepted. */
export function renderAgentSummary(steps: AgentStep[], context: AgentContext): string {
  const handoff = buildAgentHandoff(steps, context);
  const succeeded = handoff.actions.filter(action => action.status === 'succeeded').length;
  const rejected = handoff.actions.filter(action => action.status === 'rejected').length;
  const pending = handoff.actions.filter(action => action.status === 'unconfirmed').length;
  const contact = handoff.actions.find(action => action.tool === 'notify_trusted_contact');
  const relay = handoff.actions.find(action => action.tool === 'request_human_relay');
  const contactDetail = contact
    ? `Contact workflow ${contact.status === 'succeeded' ? 'receipt recorded' : 'not confirmed'} [${contact.sourceId}]: ${contact.summary}`
    : notificationStatus(context) || 'No contact notification was recorded at this snapshot.';
  const relayDetail = relay ? `Relay [${relay.sourceId}]: ${relay.summary}`
    : context.relayOpen ? 'A relay request was open at the snapshot; guardian approval is not established.' : 'No open relay was recorded at the snapshot.';
  const concerns = handoff.unresolvedConcerns.length
    ? ` Unresolved rider concerns (only explicit rider resolution clears them): ${handoff.unresolvedConcerns.map(concern => `[${concern.sourceId}; observed ${new Date(concern.observedAt).toISOString()}; received ${new Date(concern.receivedAt).toISOString()}] ${JSON.stringify(redactAgentText(concern.text, 80))}`).join('; ')}.`
    : ' No unresolved rider concern was stored in this snapshot.';
  const latest = recentRiderMessages(context)[0];
  const riderDetail = latest ? ` Recent rider claim [message:${latest.id}; ${new Date(latest.at).toISOString()}]: ${JSON.stringify(redactAgentText(latest.text, 80))}.` : ' No recent rider message was available.';
  return `Offline mock run (rule inference, no LLM), context snapshot ${new Date(context.now).toISOString()} [${handoff.snapshotSourceId}]. Recorded risk: ${context.risk}. Location: ${locationUncertain(context) ? 'stale or unverified' : 'fresh at snapshot'}.${concerns}${riderDetail} ${relayDetail} ${contactDetail} ${succeeded} tool action${succeeded === 1 ? '' : 's'} succeeded${rejected ? `; ${rejected} did not succeed` : ''}${pending ? `; ${pending} unconfirmed` : ''}.`.slice(0, 4000);
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
  // The provider's bounded proposal is not the canonical participant-facing summary.
  return call ? { type: 'tool', call } : { type: 'complete', summary: renderAgentSummary(steps, context).slice(0, 1200) };
}
