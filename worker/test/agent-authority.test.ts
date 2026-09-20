import { env, SELF, runInDurableObject, runDurableObjectAlarm, evictDurableObject, reset } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agentProvider from '../src/agent';
import type { AgentRun, AgentStep, AgentToolCall } from '../src/agent';
import type { Trip, TripAction, TripSummary, User, WorkerEnv } from '../src/types';

interface Session { token: string; user: User }
interface Policy {
  automatedCheckIns: boolean;
  timeoutContact: boolean;
  liveAiConsent: boolean;
  noticeVersion: 'openai-assistance-v1';
}
interface StoredFixture {
  trip: Trip;
  assessmentVersion: number;
  aiNextCheckInAt: number | null;
  aiMissedCheckIns: number;
  automatedEscalationSent: boolean;
  staleAlerted: boolean;
  lastNotificationAt: number;
  notificationJobs: Record<string, { attempts: number; retryAt: number; inFlightUntil: number }>;
  providerBudget?: { decisions: number; inputChars: number; runs: Record<string, { decisions: number; inputChars: number }> };
}

const defaultPolicy: Policy = {
  automatedCheckIns: true, timeoutContact: false, liveAiConsent: false,
  noticeVersion: 'openai-assistance-v1',
};
const input = {
  origin: { label: 'Private pickup', lat: 43.472, lng: -80.54 },
  destination: { label: 'Private destination', lat: 43.464, lng: -80.52 },
  emergencyContact: { name: 'Private contact', contact: 'test-only-recipient' },
  notificationConsent: true, checkInIntervalSeconds: 30,
};

beforeEach(async () => { await reset(); });
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
async function create(rider: Session): Promise<Trip> {
  const response = await request('/api/trips', rider, input);
  expect(response.status).toBe(201);
  return (await response.json<{ trip: Trip }>()).trip;
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
async function setPolicy(trip: Trip, rider: Session, changes: Partial<Policy>): Promise<Trip> {
  const response = await request(`/api/trips/${trip.id}/assistance`, rider, { ...defaultPolicy, ...changes });
  expect(response.status).toBe(200);
  return (await response.json<{ trip: Trip }>()).trip;
}
async function apply(trip: Trip, guardian: Session, requestId: string): Promise<string> {
  const response = await request(`/api/trips/${trip.id}/actions`, guardian, { action: 'accept', requestId });
  expect(response.status).toBe(200);
  return (await response.json<{ trip: TripSummary }>()).trip.application!.id;
}
async function fixture() {
  const rider = await session('Rider'), guardian = await session('Guardian');
  const trip = await create(rider);
  const requestId = await apply(trip, guardian, trip.id);
  await act(trip, rider, { action: 'approve-guardian', requestId });
  return { rider, guardian, trip };
}

// Recreate restart/retry boundaries in persisted state, without waiting on clocks.
async function mutate(trip: Trip, change: (stored: StoredFixture) => void) {
  await runInDurableObject(env.TRIPS.getByName(trip.id), async (_instance, state) => {
    const stored = JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM trip_state').one().data) as StoredFixture;
    change(stored);
    state.storage.sql.exec('UPDATE trip_state SET data = ?', JSON.stringify(stored));
    // Tests invoke wake() explicitly. A near-term real alarm can consume this
    // injected work before the request whose cancellation behavior is tested.
    await state.storage.setAlarm(Date.now() + 60 * 60_000);
  });
}
async function persisted(trip: Trip): Promise<StoredFixture> {
  return runInDurableObject(env.TRIPS.getByName(trip.id), async (_instance, state) =>
    JSON.parse(state.storage.sql.exec<{ data: string }>('SELECT data FROM trip_state').one().data) as StoredFixture);
}
async function wake(trip: Trip, restart = true) {
  const stub = env.TRIPS.getByName(trip.id);
  if (restart) await evictDurableObject(stub);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
}
function queuedRun(stored: StoredFixture, steps: AgentStep[] = []): AgentRun {
  const now = Date.now();
  return {
    id: crypto.randomUUID(), trigger: { id: crypto.randomUUID(), kind: 'takeover', at: now },
    provider: 'mock', status: 'queued', createdAt: now, updatedAt: now,
    revision: stored.assessmentVersion, steps, attempts: 0, nextAttemptAt: now - 1, leaseUntil: 0,
  };
}
async function dueTimeout(trip: Trip, notificationConsent = true) {
  await mutate(trip, stored => {
    stored.aiMissedCheckIns = 1;
    stored.aiNextCheckInAt = Date.now() - 1;
    stored.automatedEscalationSent = false;
    stored.trip.notificationConsent = notificationConsent;
    stored.trip.location.updatedAt = Date.now();
    stored.trip.agent!.followUpAt = null;
  });
}
async function withBindings(trip: Trip, overrides: Partial<WorkerEnv>, operation: () => Promise<void>) {
  const stub = env.TRIPS.getByName(trip.id);
  const previous = await runInDurableObject(stub, async instance => {
    const bindings = (instance as unknown as { env: WorkerEnv }).env;
    const values = Object.fromEntries(Object.keys(overrides).map(key => [key, bindings[key as keyof WorkerEnv]]));
    Object.assign(bindings, overrides);
    return values;
  });
  try { await operation(); }
  finally {
    await runInDurableObject(stub, async instance => {
      const bindings = (instance as unknown as { env: WorkerEnv }).env;
      for (const key of Object.keys(overrides)) {
        if (previous[key] === undefined) delete (bindings as unknown as Record<string, unknown>)[key];
        else Object.assign(bindings, { [key]: previous[key] });
      }
    });
  }
}

describe('Rider-controlled assistance and escalation authority', () => {
  it('defaults to offline check-ins without timeout contact or live-model consent', async () => {
    const rider = await session('Rider'), trip = await create(rider);
    expect(trip.assistance).toMatchObject(defaultPolicy);
    expect(trip.assistance!.updatedAt).toEqual(expect.any(Number));
    expect(trip.escalation).toBeFalsy();
  });

  it('persists live-model consent as a future choice without enabling a provider or network call', async () => {
    const { rider, trip } = await fixture();
    await withBindings(trip, { OPENAI_API_KEY: 'test-only-unused-openai-key' }, async () => {
      const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external calls allowed.'));
      const changed = await setPolicy(trip, rider, { liveAiConsent: true });
      expect(changed.assistance).toMatchObject({ ...defaultPolicy, liveAiConsent: true });
      expect(changed.assistance!.updatedAt).toBeGreaterThan(0);
      await act(trip, rider, { action: 'takeover' });
      const current = await act(trip, rider, { action: 'message', text: 'The route feels unfamiliar.' });
      expect(current.agent).toMatchObject({ provider: 'mock', liveModel: false });
      expect(current.ai.mode).toBe('rules');
      expect(network).not.toHaveBeenCalled();
    });
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await read(trip, rider)).assistance).toMatchObject({ ...defaultPolicy, liveAiConsent: true });
  });

  it('requires authentication and rejects malformed or unrecognized policy fields atomically', async () => {
    const { rider, trip } = await fixture();
    const path = `/api/trips/${trip.id}/assistance`;
    expect((await request(path, undefined, defaultPolicy)).status).toBe(401);
    const invalid = [
      {},
      { ...defaultPolicy, automatedCheckIns: 'false' },
      { ...defaultPolicy, timeoutContact: null },
      { ...defaultPolicy, liveAiConsent: 1 },
      { ...defaultPolicy, noticeVersion: 'unrecognized-notice' },
      { ...defaultPolicy, recipient: 'attacker@example.invalid' },
      { ...defaultPolicy, updatedAt: 1 },
    ];
    for (const body of invalid) expect((await request(path, rider, body)).status).toBe(400);
    expect((await read(trip, rider)).assistance).toMatchObject(defaultPolicy);
  });

  it('denies policy changes to current, pending, and replaced guardians without leaking trip data', async () => {
    const { rider, guardian, trip } = await fixture();
    const candidate = await session('Candidate');
    const relaying = await act(trip, rider, { action: 'request-relay' });
    const requestId = await apply(trip, candidate, relaying.relay!.id);
    const path = `/api/trips/${trip.id}/assistance`;
    for (const viewer of [guardian, candidate]) {
      const denied = await request(path, viewer, { ...defaultPolicy, timeoutContact: true });
      expect(denied.status).toBe(403);
      expect(await denied.text()).not.toContain('Private pickup');
    }
    await act(trip, rider, { action: 'approve-guardian', requestId });
    const denied = await request(path, guardian, { ...defaultPolicy, liveAiConsent: true });
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain('Private contact');
    expect((await read(trip, rider)).assistance).toMatchObject(defaultPolicy);
  });

  it.each(['arrive', 'cancel'] as const)('rejects assistance changes after %s', async action => {
    const { rider, trip } = await fixture();
    const closed = await act(trip, rider, { action });
    const denied = await request(`/api/trips/${trip.id}/assistance`, rider, { ...defaultPolicy, timeoutContact: true });
    expect(denied.status).toBe(409);
    expect((await read(trip, rider)).assistance).toEqual(closed.assistance);
  });

  it('records concerning chat as model concern without granting contact authority', async () => {
    const { rider, guardian, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Chat cannot send contact notifications.'));
    const concerned = await act(trip, rider, { action: 'message', text: 'I am scared and the driver will not let me get out. Help.' });
    expect(concerned.risk).toBe('attention');
    expect(concerned.escalation?.cause).toBe('model_concern');
    expect(concerned.notifications).toHaveLength(0);
    const concern = concerned.agent!.concerns!.at(-1)!;
    expect(concern).toMatchObject({ id: expect.any(String), text: expect.any(String), observedAt: expect.any(Number), receivedAt: expect.any(Number) });
    expect(concern.receivedAt).toBeGreaterThanOrEqual(concern.observedAt);
    await act(trip, rider, { action: 'message', text: 'I am okay now.' });
    await act(trip, guardian, { action: 'check-in' });
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await read(trip, rider)).agent!.concerns).toContainEqual(concern);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['Hello, thank you for accompanying me.', 'I am okay.'])('does not create a concern from benign rider text: %s', async text => {
    const { rider, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    const current = await act(trip, rider, { action: 'message', text });
    expect(current.agent!.concerns ?? []).toHaveLength(0);
    expect(current.escalation?.cause).not.toBe('model_concern');
    expect(current.notifications).toHaveLength(0);
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await read(trip, rider)).agent!.concerns ?? []).toHaveLength(0);
  });

  it('preserves all eight unresolved concerns after a ninth concern and later reassurance', async () => {
    const { rider, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    const saved = Array.from({ length: 8 }, (_, index) => ({
      id: crypto.randomUUID(), observedAt: Date.now() - 1000 + index, receivedAt: Date.now(),
      text: `I am worried about the unexplained detour, report ${index + 1}.`,
    }));
    await mutate(trip, stored => { stored.trip.agent!.concerns = saved; });
    const ninth = await act(trip, rider, { action: 'message', text: 'I am scared about another unexpected turn.' });
    expect(ninth.agent!.concerns).toEqual(saved);
    const reassured = await act(trip, rider, { action: 'message', text: 'I am okay now. Thank you.' });
    expect(reassured.agent!.concerns).toEqual(saved);
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await read(trip, rider)).agent!.concerns).toEqual(saved);
  });

  it('allows only the rider to resolve a persisted concern', async () => {
    const { rider, guardian, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    const concerned = await act(trip, rider, { action: 'message', text: 'I am scared. The driver is following a strange route.' });
    const concern = concerned.agent!.concerns!.at(-1)!;
    expect(concerned.agent!.handoffSummary).toBeTruthy();
    expect(concerned.agent!.structuredHandoff).toBeTruthy();
    const candidate = await session('Candidate');
    for (const viewer of [guardian, candidate]) {
      expect((await request(`/api/trips/${trip.id}/actions`, viewer, { action: 'resolve-concern', requestId: concern.id })).status).toBe(403);
    }
    expect((await read(trip, rider)).agent!.concerns).toContainEqual(concern);
    const resolved = await act(trip, rider, { action: 'resolve-concern', requestId: concern.id });
    expect(resolved.agent!.concerns!.some(item => item.id === concern.id)).toBe(false);
    expect(resolved.agent!.handoffSummary).toBeNull();
    expect(resolved.agent!.structuredHandoff).toBeNull();
    expect(resolved.events.some(event => event.detail.includes(concern.id))).toBe(true);
    await evictDurableObject(env.TRIPS.getByName(trip.id));
    expect((await read(trip, rider)).agent!.concerns!.some(item => item.id === concern.id)).toBe(false);
  });

  it('handles explicit help deterministically when automated check-ins are disabled', async () => {
    const { rider, trip } = await fixture();
    await setPolicy(trip, rider, { automatedCheckIns: false });
    const provider = vi.spyOn(agentProvider, 'nextMockDecision').mockRejectedValue(new Error('An assistance provider must not gate explicit help.'));
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No live provider configured.'));
    const current = await act(trip, rider, { action: 'help', text: 'Please contact my trusted person.' });
    expect(current.risk).toBe('urgent');
    expect(current.escalation?.cause).toBe('explicit_help');
    expect(current.ai.mode).toBe('rules');
    expect(current.notifications).toHaveLength(1);
    expect(current.notifications[0].status).toBe('failed');
    expect(current.notifications[0].detail).toMatch(/not configured|no message was sent/i);
    expect(provider).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    const checkedIn = await act(trip, rider, { action: 'check-in' });
    expect(checkedIn.risk).toBe('urgent');
    expect(checkedIn.escalation).toEqual(current.escalation);
    expect(checkedIn.notifications.map(notice => notice.id)).toEqual(current.notifications.map(notice => notice.id));
  });

  it.each([
    { timeoutContact: false, notificationConsent: false },
    { timeoutContact: false, notificationConsent: true },
    { timeoutContact: true, notificationConsent: false },
    { timeoutContact: true, notificationConsent: true },
  ])('requires both timeout policy and contact consent: %o', async ({ timeoutContact, notificationConsent }) => {
    const { rider, trip } = await fixture();
    await setPolicy(trip, rider, { timeoutContact });
    await act(trip, rider, { action: 'takeover' });
    await dueTimeout(trip, notificationConsent);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No configured external provider.'));
    await wake(trip);
    const current = await read(trip, rider);
    if (timeoutContact && notificationConsent) {
      expect(current.escalation?.cause).toBe('user_authorized_timeout_policy');
      expect(current.notifications).toHaveLength(1);
    } else {
      expect(current.notifications).toHaveLength(0);
    }
    expect(network).not.toHaveBeenCalled();
  });

  it('cancels persisted runs and all scheduled follow-ups when automation is disabled', async () => {
    const { rider, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    let runId = '';
    await mutate(trip, stored => {
      const run = queuedRun(stored); runId = run.id;
      stored.trip.agent!.runs.push(run);
      stored.trip.agent!.followUpAt = Date.now() - 1;
      stored.aiNextCheckInAt = Date.now() - 1;
    });
    const disabled = await setPolicy(trip, rider, { automatedCheckIns: false });
    expect(disabled.agent!.runs.find(run => run.id === runId)!.status).toBe('cancelled');
    expect(disabled.agent!.followUpAt).toBeNull();
    const provider = vi.spyOn(agentProvider, 'nextMockDecision');
    await wake(trip);
    const current = await read(trip, rider);
    expect(current.agent!.runs.find(run => run.id === runId)!.steps).toHaveLength(0);
    expect(current.messages.map(message => message.id)).toEqual(disabled.messages.map(message => message.id));
    expect(current.notifications).toHaveLength(0);
    expect(provider).not.toHaveBeenCalled();
  });

  it('invalidates already-persisted work when live-model consent is revoked', async () => {
    const { rider, trip } = await fixture();
    await setPolicy(trip, rider, { liveAiConsent: true });
    await act(trip, rider, { action: 'takeover' });
    let runId = '';
    await mutate(trip, stored => {
      const run = queuedRun(stored); runId = run.id;
      run.steps = [{ id: `${run.id}:0`, at: Date.now(), status: 'pending', call: { name: 'send_check_in', arguments: { text: 'Obsolete consent-bound proposal.' } } }];
      stored.trip.agent!.runs.push(run);
    });
    const revoked = await setPolicy(trip, rider, { liveAiConsent: false });
    expect(revoked.agent!.runs.find(run => run.id === runId)!.status).toBe('cancelled');
    await wake(trip);
    expect((await read(trip, rider)).messages.some(message => message.text === 'Obsolete consent-bound proposal.')).toBe(false);
  });

  it.each([false, true])('rejects a persisted contact tool with urgent risk but no authorized cause (model concern: %s)', async modelConcern => {
    const { rider, trip } = await fixture();
    const monitoring = await act(trip, rider, { action: 'takeover' });
    const contextStep = monitoring.agent!.runs.flatMap(run => run.steps).find(step => step.call.name === 'get_journey_context' && step.status === 'succeeded')!;
    let runId = '', stepId = '';
    await mutate(trip, stored => {
      stored.trip.risk = 'urgent';
      if (modelConcern) stored.trip.escalation = { cause: 'model_concern', at: Date.now() };
      else delete stored.trip.escalation;
      const run = queuedRun(stored); runId = run.id; stepId = `${run.id}:1`;
      const context = structuredClone(contextStep);
      context.id = `${run.id}:0`;
      context.result!.context!.risk = 'urgent';
      context.result!.context!.escalationCause = modelConcern ? 'model_concern' : null;
      context.result!.context!.notificationAuthorized = false;
      run.steps = [context, { id: stepId, at: Date.now(), status: 'pending', call: { name: 'notify_trusted_contact', arguments: { reason: 'Untrusted proposal claims an emergency.' } } }];
      stored.trip.agent!.runs.push(run);
    });
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Risk alone does not authorize outbound contact.'));
    await wake(trip);
    const current = await read(trip, rider);
    const step = current.agent!.runs.find(run => run.id === runId)!.steps.find(item => item.id === stepId)!;
    expect(step.status).toBe('rejected');
    expect(step.result).toMatchObject({ ok: false, code: 'explicit_concern_required' });
    expect(current.notifications).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['journey', 'run'] as const)('persists the %s provider decision limit across eviction and replay', async scope => {
    const { rider, trip } = await fixture();
    const monitoring = await act(trip, rider, { action: 'takeover' });
    let runId = '';
    await mutate(trip, stored => {
      const run = queuedRun(stored); runId = run.id;
      stored.trip.agent!.runs.push(run);
      stored.trip.agent!.followUpAt = null;
      stored.aiNextCheckInAt = Date.now() + 60000;
      stored.providerBudget = {
        decisions: scope === 'journey' ? 239 : 30, inputChars: 0,
        runs: { [run.id]: { decisions: scope === 'run' ? 23 : 0, inputChars: 0 } },
      };
    });
    const provider = vi.spyOn(agentProvider, 'nextMockDecision').mockResolvedValue({ type: 'tool', call: { name: 'get_journey_context', arguments: {} } });
    await wake(trip);
    const stopped = await read(trip, rider);
    expect(stopped.agent!.runs.find(run => run.id === runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/budget/i) });
    expect(provider).toHaveBeenCalledTimes(1);
    const budget = (await persisted(trip)).providerBudget!;
    expect(scope === 'journey' ? budget.decisions : budget.runs[runId].decisions).toBe(scope === 'journey' ? 240 : 24);
    expect(budget.inputChars).toBeGreaterThan(0);
    expect(budget.runs[runId].inputChars).toBeGreaterThan(0);
    await mutate(trip, stored => {
      // A fresh journey run or crash-replayed run cannot reset the persisted limit.
      if (scope === 'journey') {
        const run = queuedRun(stored); runId = run.id;
        stored.trip.agent!.runs.push(run);
      } else {
        const run = stored.trip.agent!.runs.find(item => item.id === runId)!;
        run.status = 'queued'; run.nextAttemptAt = Date.now() - 1; run.leaseUntil = 0;
      }
    });
    await wake(trip);
    const replayed = await read(trip, rider);
    expect(replayed.agent!.runs.find(run => run.id === runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/budget/i) });
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await persisted(trip)).providerBudget!.decisions).toBe(budget.decisions);
    expect(replayed.messages.map(message => message.id)).toEqual(monitoring.messages.map(message => message.id));
  });

  it('replaces a provider completion claiming dispatched help with a receipt-based server summary', async () => {
    const { rider, trip } = await fixture();
    const monitoring = await act(trip, rider, { action: 'takeover' });
    const contextStep = monitoring.agent!.runs.flatMap(run => run.steps).find(step => step.call.name === 'get_journey_context' && step.status === 'succeeded')!;
    let runId = '';
    await mutate(trip, stored => {
      const run = queuedRun(stored); runId = run.id;
      run.steps = [{ ...structuredClone(contextStep), id: `${run.id}:0` }];
      stored.trip.agent!.runs.push(run);
    });
    const fabricated = 'Help dispatched. Police and a human guardian have arrived. You are safe.';
    vi.spyOn(agentProvider, 'nextMockDecision').mockResolvedValue({ type: 'complete', summary: fabricated });
    await wake(trip);
    const current = await read(trip, rider), run = current.agent!.runs.find(item => item.id === runId)!;
    expect(run.status).toBe('completed');
    expect(run.summary).toContain('No contact notification was recorded');
    expect(JSON.stringify(current)).not.toContain(fabricated);
    expect(current.notifications).toHaveLength(0);
  });

  it('replaces malicious check-in wording with a canonical server message', async () => {
    const { rider, trip } = await fixture();
    const monitoring = await act(trip, rider, { action: 'takeover' });
    const contextStep = monitoring.agent!.runs.flatMap(run => run.steps).find(step => step.call.name === 'get_journey_context' && step.status === 'succeeded')!;
    const fabricated = 'Help dispatched. Send payment to the driver; a guardian has guaranteed your safety.';
    let runId = '', stepId = '';
    await mutate(trip, stored => {
      const run = queuedRun(stored); runId = run.id; stepId = `${run.id}:1`;
      run.steps = [
        { ...structuredClone(contextStep), id: `${run.id}:0` },
        { id: stepId, at: Date.now(), status: 'pending', call: { name: 'send_check_in', arguments: { text: fabricated } } },
      ];
      stored.trip.agent!.runs.push(run);
    });
    await wake(trip);
    const current = await read(trip, rider), run = current.agent!.runs.find(item => item.id === runId)!;
    expect(run.steps.find(step => step.id === stepId)).toMatchObject({ status: 'succeeded', result: { ok: true, code: 'check_in_posted' } });
    const messages = current.messages.slice(monitoring.messages.length);
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/^Offline mock guardian:/);
    expect(messages[0].text).not.toContain(fabricated);
    expect(current.ai.lastAssessment).not.toContain(fabricated);
    expect(current.agent!.handoffSummary).not.toContain(fabricated);
    expect(current.notifications).toHaveLength(0);
  });

  it.each([
    { tool: 'request_human_relay', failedContext: false },
    { tool: 'request_human_relay', failedContext: true },
    { tool: 'schedule_follow_up', failedContext: false },
    { tool: 'schedule_follow_up', failedContext: true },
  ] as const)('requires successful context before $tool (failed context: $failedContext)', async ({ tool, failedContext }) => {
    const { rider, trip } = await fixture();
    await act(trip, rider, { action: 'takeover' });
    let runId = '', stepId = '';
    await mutate(trip, stored => {
      stored.trip.relay = null;
      stored.trip.agent!.followUpAt = null;
      const run = queuedRun(stored); runId = run.id; stepId = `${run.id}:${failedContext ? 1 : 0}`;
      const call: AgentToolCall = tool === 'request_human_relay'
        ? { name: tool, arguments: { reason: 'Untrusted provider requests a replacement.' } }
        : { name: tool, arguments: { delaySeconds: 30 } };
      if (failedContext) run.steps.push({
        id: `${run.id}:0`, at: Date.now(), status: 'rejected', call: { name: 'get_journey_context', arguments: {} },
        result: { ok: false, code: 'context_unavailable', detail: 'No authorized context was read.' },
      });
      run.steps.push({ id: stepId, at: Date.now(), status: 'pending', call });
      stored.trip.agent!.runs.push(run);
    });
    vi.spyOn(agentProvider, 'nextMockDecision').mockResolvedValue({ type: 'complete', summary: 'No further proposal.' });
    await wake(trip);
    const current = await read(trip, rider), run = current.agent!.runs.find(item => item.id === runId)!;
    expect(run.steps.find(step => step.id === stepId)).toMatchObject({ status: 'rejected', result: { ok: false, code: 'context_required' } });
    expect(current.relay).toBeNull();
    expect(current.agent!.followUpAt).toBeNull();
    expect(current.notifications).toHaveLength(0);
  });

  it.each(['contact-consent', 'timeout-policy', 'rider-check-in', 'guardian-resume'] as const)('rechecks %s before retrying an already failed notification', async revocation => {
    const { rider, guardian, trip } = await fixture();
    await setPolicy(trip, rider, { timeoutContact: true });
    await act(trip, rider, { action: 'takeover' });
    await withBindings(trip, {
      NOTIFICATIONS_ENABLED: 'true', NOTIFICATION_WEBHOOK_URL: 'https://notification.example.test/send',
      NOTIFICATION_WEBHOOK_SECRET: 'test-only-fake-secret',
    }, async () => {
      const network = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
      await dueTimeout(trip);
      await wake(trip, false);
      const initial = await read(trip, rider);
      expect(initial.notifications).toHaveLength(1);
      expect(initial.notifications[0]).toMatchObject({ status: 'failed', channel: 'webhook' });
      expect(network).toHaveBeenCalledTimes(1);
      const noticeId = initial.notifications[0].id;
      if (revocation === 'timeout-policy') await setPolicy(trip, rider, { timeoutContact: false });
      if (revocation === 'rider-check-in') await act(trip, rider, { action: 'check-in' });
      if (revocation === 'guardian-resume') await act(trip, guardian, { action: 'resume' });
      await mutate(trip, stored => {
        if (revocation === 'contact-consent') stored.trip.notificationConsent = false;
        const job = stored.notificationJobs[noticeId];
        if (job) { job.retryAt = Date.now() - 1; job.inFlightUntil = 0; }
      });
      await wake(trip, false);
      expect(network).toHaveBeenCalledTimes(1);
      expect((await read(trip, rider)).notifications.map(notice => notice.id)).toEqual([noticeId]);
    });
  });
});
