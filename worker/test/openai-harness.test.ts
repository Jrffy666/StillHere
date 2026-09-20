import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as openaiProvider from '../src/openai-provider';
import type { OpenAIAssessmentResult } from '../src/openai-provider';
import type { AgentContext, AgentRun } from '../src/agent';
import { AiBudgetLedger } from '../src/ai-budget';
import { tripSnapshotSchema } from '../src/snapshots';
import type { Trip, TripAction, TripSummary, User, WorkerEnv } from '../src/types';

interface Session { token: string; user: User }
interface PaidBudget { requests: number; reservedTokens: number; inputTokens: number; outputTokens: number; totalTokens: number; lastRequestAt: number }
interface StoredFixture {
  trip: Trip; assessmentVersion: number; aiNextCheckInAt: number | null;
  paidAiBudget?: PaidBudget;
}
const apiKey = 'dummy-openai-key-for-mocked-harness-only';
const model = 'gpt-4.1-mini-2025-04-14';
const configuration = { OPENAI_ENABLED: 'true', OPENAI_API_KEY: apiKey, OPENAI_MODEL: model };
const usage = { inputTokens: 120, outputTokens: 50, totalTokens: 170 };
const sourceText = 'We passed the blue cafe three times; I would like someone to stay with me.';
const input = {
  origin: { label: 'Private pickup', lat: 43.472, lng: -80.54 }, destination: { label: 'Private destination', lat: 43.464, lng: -80.52 },
  emergencyContact: { name: 'Private contact', contact: 'test-only-recipient' }, notificationConsent: true,
  shareUrl: 'https://trip.uber.com/private-link-marker', checkInIntervalSeconds: 300,
};

beforeEach(async () => {
  await reset();
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network is forbidden in the OpenAI integration harness.'));
});
afterEach(() => { vi.restoreAllMocks(); });

async function request(path: string, session?: Session, body?: unknown) {
  return SELF.fetch(`https://guard.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function session(name: string): Promise<Session> {
  const response = await request('/api/session', undefined, { name });
  expect(response.status).toBe(201);
  const value = await response.json<Session>();
  await env.USERS.getByName(value.user.id).acceptCommunityNotice('community-v1');
  return value;
}
async function act(trip: Trip, user: Session, action: TripAction): Promise<Trip> {
  const response = await request(`/api/trips/${trip.id}/actions`, user, action);
  expect(response.status).toBe(200);
  return (await response.json<{ trip: Trip }>()).trip;
}
async function read(trip: Trip, user: Session): Promise<Trip> {
  const response = await request(`/api/trips/${trip.id}`, user);
  expect(response.status).toBe(200);
  return (await response.json<{ trip: Trip }>()).trip;
}
async function consent(trip: Trip, user: Session, accepted = true): Promise<Trip> {
  const response = await request(`/api/trips/${trip.id}/ai-consent`, user, { consent: accepted, noticeVersion: 'openai-assistance-v2' });
  expect(response.status).toBe(200);
  return (await response.json<{ trip: Trip }>()).trip;
}
async function approve(trip: Trip, rider: Session, guardian: Session, requestId: string): Promise<Trip> {
  const response = await request(`/api/trips/${trip.id}/actions`, guardian, { action: 'accept', requestId });
  expect(response.status).toBe(200);
  const pending = (await response.json<{ trip: TripSummary }>()).trip;
  return act(trip, rider, { action: 'approve-guardian', requestId: pending.application!.id });
}
async function fixture() {
  const rider = await session('Rider'), guardian = await session('Guardian');
  const response = await request('/api/trips', rider, input);
  expect(response.status).toBe(201);
  const trip = (await response.json<{ trip: Trip }>()).trip;
  await approve(trip, rider, guardian, trip.id);
  await act(trip, rider, { action: 'message', text: sourceText });
  return { rider, guardian, trip };
}
async function mutate(trip: Trip, change: (stored: StoredFixture) => void) {
  await runInDurableObject(env.TRIPS.getByName(trip.id), async (_instance, state) => {
    const stored = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM trip_state').one().data) as StoredFixture;
    change(stored);
    state.storage.sql.exec('UPDATE trip_state SET data = ?', JSON.stringify(stored));
    await state.storage.setAlarm(Date.now() + 100);
  });
}
async function persisted(trip: Trip): Promise<StoredFixture> {
  return runInDurableObject(env.TRIPS.getByName(trip.id), (_instance, state) =>
    JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM trip_state').one().data) as StoredFixture);
}
async function withConfiguration(trip: Trip, overrides: Partial<WorkerEnv>, operation: () => Promise<void>) {
  const changes = { ...configuration, ...overrides }, stub = env.TRIPS.getByName(trip.id);
  const previous = await runInDurableObject(stub, instance => {
    const bindings = (instance as unknown as { env: WorkerEnv }).env;
    const values = Object.fromEntries(Object.keys(changes).map(key => [key, bindings[key as keyof WorkerEnv]]));
    Object.assign(bindings, changes);
    return values;
  });
  try { await operation(); }
  finally {
    await runInDurableObject(stub, instance => {
      const bindings = (instance as unknown as { env: WorkerEnv }).env;
      for (const key of Object.keys(changes)) {
        if (previous[key] === undefined) delete (bindings as unknown as Record<string, unknown>)[key];
        else Object.assign(bindings, { [key]: previous[key] });
      }
    });
  }
}
function outcome(context: AgentContext): OpenAIAssessmentResult {
  const source = context.messages.filter(message => message.role === 'rider').at(-1);
  const sourceIds = source ? [`message:${source.id}`] : [];
  return {
    assessment: {
      findings: source ? [{ kind: 'concern', topic: 'route', sourceIds }] : [],
      question: { kind: source ? 'route_explanation' : 'companionship', sourceIds },
      requestRelay: true, followUpSeconds: 60,
    },
    responseId: 'resp_harness', model, requestId: 'req_harness', promptVersion: openaiProvider.OPENAI_PROMPT_VERSION, usage,
  };
}
function mockedAssessment() {
  return vi.spyOn(openaiProvider, 'runOpenAIAssessmentWithDeadline').mockImplementation(async options => outcome(options.context));
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Consented OpenAI execution inside a durable journey', () => {
  it.each([
    { label: 'disabled deployment', overrides: { OPENAI_ENABLED: 'false' }, choice: 'v2', available: false },
    { label: 'missing key', overrides: { OPENAI_API_KEY: '' }, choice: 'v2', available: false },
    { label: 'unapproved model', overrides: { OPENAI_MODEL: 'unapproved-model' }, choice: 'v2', available: false },
    { label: 'no rider consent', overrides: {}, choice: 'none', available: true },
    { label: 'legacy v1 choice', overrides: {}, choice: 'v1', available: true },
    { label: 'guardian consent only', overrides: {}, choice: 'guardian', available: true },
  ])('never dispatches a model request with $label', async ({ overrides, choice, available }) => {
    const { rider, guardian, trip } = await fixture();
    const provider = mockedAssessment();
    if (choice === 'v2') await consent(trip, rider);
    if (choice === 'guardian') await consent(trip, guardian);
    if (choice === 'v1') {
      expect((await request(`/api/trips/${trip.id}/assistance`, rider, {
        automatedCheckIns: true, timeoutContact: false, liveAiConsent: true, noticeVersion: 'openai-assistance-v1',
      })).status).toBe(200);
    }
    await withConfiguration(trip, overrides, async () => {
      expect((await read(trip, rider)).liveAiAvailable).toBe(available);
      const current = await act(trip, rider, { action: 'takeover' });
      expect(current.agent).toMatchObject({ provider: 'mock', liveModel: false });
      expect(current.messages.some(message => message.automatedBy === 'openai')).toBe(false);
      expect(provider).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('binds strict v2 consent to the authenticated current participant and rejects closed journeys', async () => {
    const { rider, guardian, trip } = await fixture();
    const path = `/api/trips/${trip.id}/ai-consent`, body = { consent: true, noticeVersion: 'openai-assistance-v2' };
    expect((await request(path, undefined, body)).status).toBe(401);
    expect((await request(path, await session('Outsider'), body)).status).toBe(403);
    for (const invalid of [{ consent: true, noticeVersion: 'openai-assistance-v1' }, { ...body, consent: 'true' }, { ...body, userId: rider.user.id }]) {
      expect((await request(path, guardian, invalid)).status).toBe(400);
    }
    const guardianChoice = await consent(trip, guardian);
    expect(guardianChoice.aiConsent?.[guardian.user.id]).toMatchObject({ accepted: true, noticeVersion: 'openai-assistance-v2' });
    expect(guardianChoice.assistance?.liveAiConsent).toBe(false);
    const riderChoice = await consent(trip, rider);
    expect(riderChoice.assistance).toMatchObject({ liveAiConsent: true, noticeVersion: 'openai-assistance-v2' });
    expect(riderChoice.aiConsent?.[rider.user.id]?.accepted).toBe(true);
    await act(trip, rider, { action: 'cancel' });
    expect((await request(path, rider, body)).status).toBe(409);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes one mocked Responses request after durable reservation, stores usage, and renders cited assistance without new authority', async () => {
    const { rider, guardian, trip } = await fixture();
    const privateCoordinates = '37.123456, -122.123456', privateWallet = '23f7UAfNbQCGdfQbJV3Tois98dETDfXnAXgjE5qTH5gb';
    await act(trip, rider, { action: 'message', text: `${sourceText} Coordinates ${privateCoordinates}; wallet ${privateWallet}.` });
    await consent(trip, rider);
    let beforeDispatch: StoredFixture | undefined;
    let sentMessages: Array<{ sourceId: string; text: string }> = [];
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      beforeDispatch = await persisted(trip);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ model, store: false, stream: false, parallel_tool_calls: false });
      const snapshot = JSON.parse(body.input[0].content);
      sentMessages = snapshot.messages;
      const source = snapshot.messages.filter((item: { role: string }) => item.role === 'rider').at(-1);
      expect(JSON.stringify(snapshot)).not.toContain(input.emergencyContact.contact);
      expect(JSON.stringify(snapshot)).not.toContain(input.origin.label);
      expect(JSON.stringify(snapshot)).not.toContain(privateCoordinates);
      expect(JSON.stringify(snapshot)).not.toContain(privateWallet);
      return Response.json({
        id: 'resp_harness', model, status: 'completed', error: null, incomplete_details: null,
        usage: { input_tokens: 120, output_tokens: 50, total_tokens: 170 },
        output: [{ type: 'function_call', id: 'fc_harness', call_id: 'call_harness', status: 'completed', name: 'propose_journey_assistance', arguments: JSON.stringify({
          findings: [{ kind: 'concern', topic: 'route', sourceIds: [source.sourceId] }],
          question: { kind: 'route_explanation', sourceIds: [source.sourceId] }, requestRelay: true, followUpSeconds: 60,
        }) }],
      }, { headers: { 'x-request-id': 'req_harness' } });
    });
    await withConfiguration(trip, {}, async () => {
      const current = await act(trip, rider, { action: 'takeover' });
      expect(fetch).toHaveBeenCalledTimes(1);
      const reservedRun = beforeDispatch!.trip.agent!.runs.find(run => run.semanticAttempt?.status === 'reserved')!;
      expect(reservedRun).toBeDefined();
      expect(reservedRun.steps[0]).toMatchObject({ call: { name: 'get_journey_context' }, status: 'succeeded' });
      expect(beforeDispatch!.paidAiBudget).toMatchObject({ requests: 1, inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(beforeDispatch!.paidAiBudget!.reservedTokens).toBeGreaterThan(1200);
      const run = current.agent!.runs.find(item => item.semantic)!;
      expect(run).toMatchObject({ provider: 'openai', status: 'completed', semanticAttempt: { status: 'completed', usage }, semantic: { responseId: 'resp_harness', model, usage } });
      expect(run.semantic!.context.messages.map(message => ({ sourceId: `message:${message.id}`, text: message.text })))
        .toEqual(sentMessages.map(({ sourceId, text }) => ({ sourceId, text })));
      expect(JSON.stringify(run.semantic!.context)).not.toContain(privateCoordinates);
      expect(JSON.stringify(run.semantic!.context)).not.toContain(privateWallet);
      const question = current.messages.find(message => message.automatedBy === 'openai')!;
      expect(question.text).toContain('AI check-in:');
      expect(question.text).toContain('Quoted rider source [message:');
      expect(question.text).toContain(sourceText);
      expect(question.text).toContain('not a verified fact');
      expect(current.agent!.semanticHandoff).toBeTruthy();
      expect(current.agent!.concerns).toHaveLength(1);
      expect(current.notifications).toHaveLength(0);
      expect(current.escalation?.cause).not.toBe('explicit_help');
      expect(current.guardian?.id).toBe(guardian.user.id);
      expect(current.contributions).toHaveLength(1);
      expect(current.contributions[0]).toMatchObject({ checkIns: 0, rewardStatus: 'pending' });
      expect(current.lastGuardianCheckInAt).toBeNull();
      const stored = await persisted(trip);
      expect(stored.paidAiBudget).toMatchObject({ requests: 1, ...usage });
      const backup = await env.TRIPS.getByName(trip.id).exportSnapshot();
      const parsed = tripSnapshotSchema.safeParse(backup);
      expect(parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues)).toBe(true);
      expect(JSON.stringify(backup)).not.toContain(apiKey);
      expect(JSON.stringify(current)).not.toContain(apiKey);
      expect((await request(`/api/trips/${trip.id}/actions`, await session('Candidate'), { action: 'check-in' })).status).toBe(403);
    });
  });

  it('includes only messages authored by the current rider and individually consenting current guardian', async () => {
    const { rider, guardian: former, trip } = await fixture();
    await consent(trip, former);
    await act(trip, former, { action: 'message', text: 'FORMER_GUARDIAN_PRIVATE_MARKER' });
    const relay = await act(trip, rider, { action: 'request-relay' });
    const guardian = await session('Replacement');
    await approve(trip, rider, guardian, relay.relay!.id);
    await act(trip, guardian, { action: 'message', text: 'CURRENT_GUARDIAN_PRIVATE_MARKER' });
    expect((await request(`/api/trips/${trip.id}/ai-consent`, former, { consent: true, noticeVersion: 'openai-assistance-v2' })).status).toBe(403);
    await mutate(trip, stored => {
      for (const role of ['agent', 'system'] as const) stored.trip.messages.push({
        id: crypto.randomUUID(), at: Date.now(), senderId: 'server', senderName: 'Server', role, text: `${role.toUpperCase()}_PRIVATE_MARKER`,
      });
    });
    await consent(trip, rider);
    const provider = mockedAssessment();
    await withConfiguration(trip, {}, async () => {
      await act(trip, rider, { action: 'takeover' });
      const first = JSON.stringify(provider.mock.calls[0][0].context.messages);
      expect(first).toContain(sourceText);
      for (const marker of ['FORMER_GUARDIAN_PRIVATE_MARKER', 'CURRENT_GUARDIAN_PRIVATE_MARKER', 'AGENT_PRIVATE_MARKER', 'SYSTEM_PRIVATE_MARKER']) expect(first).not.toContain(marker);
      await consent(trip, guardian);
      await mutate(trip, stored => { stored.paidAiBudget!.lastRequestAt = Date.now() - 10_001; });
      await act(trip, rider, { action: 'message', text: 'Please keep me company while we continue.' });
      expect(provider).toHaveBeenCalledTimes(2);
      const second = JSON.stringify(provider.mock.calls[1][0].context.messages);
      expect(second).toContain('CURRENT_GUARDIAN_PRIVATE_MARKER');
      expect(second).not.toContain('FORMER_GUARDIAN_PRIVATE_MARKER');
      await consent(trip, guardian, false);
      await mutate(trip, stored => { stored.paidAiBudget!.lastRequestAt = Date.now() - 10_001; });
      await act(trip, rider, { action: 'message', text: 'Thank you for being here.' });
      expect(provider).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(provider.mock.calls[2][0].context.messages)).not.toContain('CURRENT_GUARDIAN_PRIVATE_MARKER');
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it.each(['requests', 'reserved-tokens', 'cooldown'] as const)('enforces the journey %s limit before calling the paid adapter', async limit => {
    const { rider, trip } = await fixture();
    await consent(trip, rider);
    await mutate(trip, stored => {
      stored.paidAiBudget = { requests: limit === 'requests' ? 12 : 1, reservedTokens: limit === 'reserved-tokens' ? 120_000 : 1000,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, lastRequestAt: limit === 'cooldown' ? Date.now() : 0 };
    });
    const provider = mockedAssessment();
    await withConfiguration(trip, {}, async () => {
      const current = await act(trip, rider, { action: 'takeover' });
      expect(provider).not.toHaveBeenCalled();
      expect(current.agent!.fallbackReason).toBe('AI_JOURNEY_BUDGET_OR_COOLDOWN');
      expect(current.agent).toMatchObject({ provider: 'mock', liveModel: false });
      expect(current.messages.some(message => message.text.startsWith('Offline mock guardian:'))).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('does not spend again during cooldown and permits a fresh run after the cooldown', async () => {
    const { rider, trip } = await fixture();
    await consent(trip, rider);
    const provider = mockedAssessment();
    await withConfiguration(trip, {}, async () => {
      await act(trip, rider, { action: 'takeover' });
      await act(trip, rider, { action: 'message', text: 'Please continue to accompany me.' });
      expect(provider).toHaveBeenCalledTimes(1);
      await mutate(trip, stored => { stored.paidAiBudget!.lastRequestAt = Date.now() - 10_001; });
      await act(trip, rider, { action: 'message', text: 'I would like another check-in.' });
      expect(provider).toHaveBeenCalledTimes(2);
      expect((await persisted(trip)).paidAiBudget!.requests).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('falls back before model dispatch when the shared governance budget is exhausted', async () => {
    const { rider, trip } = await fixture();
    await consent(trip, rider);
    await runInDurableObject(env.GOVERNANCE.getByName('governance-v1'), (_instance, state) => {
      const ledger = new AiBudgetLedger(state.storage);
      for (let index = 0; index < 50; index++) expect(ledger.reserve(crypto.randomUUID(), 1).allowed).toBe(true);
    });
    const provider = mockedAssessment();
    await withConfiguration(trip, {}, async () => {
      const current = await act(trip, rider, { action: 'takeover' });
      expect(provider).not.toHaveBeenCalled();
      expect(current.agent!.fallbackReason).toBe('AI_GLOBAL_BUDGET');
      expect(current.agent!.runs.some(run => run.semanticAttempt?.error === 'AI_GLOBAL_BUDGET')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('records a failed paid attempt, continues offline, and never retries that attempt after restart', async () => {
    const { rider, trip } = await fixture();
    await consent(trip, rider);
    const provider = vi.spyOn(openaiProvider, 'runOpenAIAssessmentWithDeadline').mockRejectedValue(new openaiProvider.OpenAIProviderError('OPENAI_UNAVAILABLE', usage));
    let runId = '';
    await withConfiguration(trip, {}, async () => {
      const current = await act(trip, rider, { action: 'takeover' });
      const run = current.agent!.runs.find(item => item.semanticAttempt)!; runId = run.id;
      expect(run.semanticAttempt).toMatchObject({ status: 'failed', error: 'OPENAI_UNAVAILABLE', usage });
      expect(run.status).toBe('completed');
      expect(current.agent).toMatchObject({ provider: 'mock', liveModel: false });
      expect(current.messages.some(message => message.text.startsWith('Offline mock guardian:'))).toBe(true);
      expect((await persisted(trip)).paidAiBudget).toMatchObject({ requests: 1, ...usage });
    });
    await mutate(trip, stored => {
      const run = stored.trip.agent!.runs.find(item => item.id === runId)!;
      run.status = 'queued'; run.nextAttemptAt = Date.now() - 1; run.leaseUntil = 0;
    });
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    await withConfiguration(trip, {}, async () => {
      expect(await runDurableObjectAlarm(env.TRIPS.getByName(trip.id))).toBe(true);
      expect(provider).toHaveBeenCalledTimes(1);
      expect((await read(trip, rider)).agent!.runs.find(run => run.id === runId)!.semantic).toBeUndefined();
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('never redispatches an uncertain persisted reservation after eviction', async () => {
    const { rider, trip } = await fixture();
    const monitoring = await act(trip, rider, { action: 'takeover' });
    await consent(trip, rider);
    const context = monitoring.agent!.runs.flatMap(run => run.steps).find(step => step.call.name === 'get_journey_context' && step.status === 'succeeded')!;
    const requestId = crypto.randomUUID();
    let runId = '';
    await mutate(trip, stored => {
      const now = Date.now(); runId = crypto.randomUUID();
      const run: AgentRun = {
        id: runId, trigger: { id: crypto.randomUUID(), kind: 'takeover', at: now }, provider: 'mock', status: 'queued',
        createdAt: now, updatedAt: now, revision: stored.assessmentVersion, attempts: 0, nextAttemptAt: now - 1, leaseUntil: 0,
        steps: [{ ...structuredClone(context), id: `${runId}:0` }],
        semanticAttempt: { id: requestId, status: 'reserved', reservedTokens: 10_000 },
      };
      stored.trip.agent!.runs.push(run);
      stored.paidAiBudget = { requests: 1, reservedTokens: 10_000, inputTokens: 0, outputTokens: 0, totalTokens: 0, lastRequestAt: now - 20_000 };
    });
    await runInDurableObject(env.GOVERNANCE.getByName('governance-v1'), (_instance, state) => {
      expect(new AiBudgetLedger(state.storage).reserve(requestId, 10_000).allowed).toBe(true);
    });
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    const provider = mockedAssessment();
    await withConfiguration(trip, {}, async () => {
      expect(await runDurableObjectAlarm(env.TRIPS.getByName(trip.id))).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      const current = await read(trip, rider), run = current.agent!.runs.find(item => item.id === runId)!;
      expect(run.semantic).toBeUndefined();
      expect(run.semanticAttempt).toMatchObject({ status: 'failed', error: 'AI_INTERRUPTED' });
      expect((await persisted(trip)).paidAiBudget).toMatchObject({ requests: 1, reservedTokens: 10_000, totalTokens: 0 });
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it.each(['revoke', 'resume', 'help', 'lease-expired'] as const)('discards a late semantic response after %s', async change => {
    const { rider, guardian, trip } = await fixture();
    await consent(trip, rider);
    const late = deferred<OpenAIAssessmentResult>();
    const provider = vi.spyOn(openaiProvider, 'runOpenAIAssessmentWithDeadline').mockImplementation(() => {
      return late.promise; // Deliberately ignores AbortSignal to exercise the durable freshness check.
    });
    await withConfiguration(trip, {}, async () => {
      const pending = act(trip, rider, { action: 'takeover' });
      // Poll from this test's I/O context instead of resuming a promise resolved
      // inside TripRoom and accidentally inheriting that object's I/O context.
      await vi.waitFor(() => { expect(provider).toHaveBeenCalledTimes(1); });
      const options = provider.mock.calls[0][0];
      if (change === 'revoke') await consent(trip, rider, false);
      if (change === 'resume') await act(trip, guardian, { action: 'resume' });
      if (change === 'help') await act(trip, rider, { action: 'help' });
      if (change === 'lease-expired') await mutate(trip, stored => {
        const run = stored.trip.agent!.runs.find(item => item.semanticAttempt?.status === 'reserved')!;
        run.leaseUntil = Date.now() - 1;
      });
      late.resolve(outcome(options.context));
      await pending;
      const current = await read(trip, rider);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(current.agent!.runs.some(run => run.semantic)).toBe(false);
      expect(current.agent!.runs.some(run => run.semanticAttempt?.status === 'discarded')).toBe(true);
      expect(current.messages.some(message => message.automatedBy === 'openai')).toBe(false);
      if (change === 'help') expect(current).toMatchObject({ risk: 'urgent', escalation: { cause: 'explicit_help' } });
      else expect(current.notifications).toHaveLength(0);
      if (change === 'resume') expect(current.guardMode).toBe('human');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
