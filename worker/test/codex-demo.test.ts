import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentContext } from '../src/agent';
import type { SemanticAssessment } from '../src/agent-semantic';
import type { Trip, TripMessage } from '../src/types';
import {
  CODEX_DEMO_NOTICE_VERSION, CODEX_DEMO_TTL_MS, codexDemoContext, codexDemoExportSchema,
  codexDemoJobSchema, exportInputSchema, resultInputSchema, validateCodexDemoResult,
  type CodexDemoJob, type CodexDemoResult,
} from '../src/codex-demo';

const now = 1_800_000_000_000;
const jobId = '15513854-0f86-4fcb-b19f-ad30d4c96b7e';
const otherId = 'c20fbbe3-f8e6-4f94-959e-f7d13be27c91';
const context = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  now, status: 'active', guardMode: 'ai', risk: 'normal',
  location: { updatedAt: now, ageSeconds: 0, stale: false },
  messages: [{ id: 'm1', at: now, role: 'rider', text: 'I am not in danger; I want the detour explained.' }],
  relayOpen: false, notifications: [], contactAvailable: false, unresolvedConcerns: [], ...overrides,
});
const assessment = (overrides: Partial<SemanticAssessment> = {}): SemanticAssessment => ({
  findings: [{ kind: 'uncertainty', topic: 'route', sourceIds: ['message:m1'] }],
  question: { kind: 'route_explanation', sourceIds: ['message:m1'] },
  requestRelay: true, followUpSeconds: 60, ...overrides,
});
const job = (overrides: Partial<CodexDemoJob> = {}): CodexDemoJob => ({
  id: jobId, revision: 4, createdAt: now, expiresAt: now + CODEX_DEMO_TTL_MS,
  context: context(), authorityContext: context({ notificationAuthorized: false }), status: 'pending', ...overrides,
});
const result = (overrides: Partial<CodexDemoResult> = {}): CodexDemoResult => ({
  version: 1, kind: 'safety-guard-codex-result', jobId, assessment: assessment(),
  execution: { tool: 'codex-cli', auth: 'chatgpt', cliVersion: 'codex-cli 0.155.1', completedAt: now, usage: null },
  ...overrides,
});
const message = (id: string, role: TripMessage['role'], senderId: string, text = `${role} text`): TripMessage => ({
  id, at: now, role, senderId, senderName: 'Private participant name', text,
});
const trip = (overrides: Partial<Trip> = {}): Trip => ({
  id: 'private-journey-id', demo: true, status: 'active', rider: { id: 'owner', name: 'Private rider name' },
  guardian: { id: 'guardian', name: 'Private guardian name' }, guardMode: 'ai',
  guardianRequests: [], relay: null, contributions: [],
  origin: { label: 'Private origin', lat: 31.12345, lng: 121.12345 },
  destination: { label: 'Private destination', lat: 31.54321, lng: 121.54321 },
  location: { lat: 31.12345, lng: 121.12345, updatedAt: now },
  createdAt: now, updatedAt: now, checkInIntervalSeconds: 60, nextCheckInAt: now + 60_000,
  lastGuardianCheckInAt: null, risk: 'normal', ai: { mode: 'rules', lastAssessment: '' },
  messages: [message('m1', 'rider', 'owner')], events: [], notifications: [],
  reward: { points: 0, reputation: 0, status: 'demo' }, notificationConsent: false,
  emergencyContact: { name: 'Private contact', contact: 'private@example.com' },
  shareUrl: 'https://example.com/private-share', ...overrides,
});

beforeEach(() => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Real network forbidden')); });
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });

describe('Private Codex demo file contracts', () => {
  it('requires the current notice and both explicit assertions, rejecting unknown fields', () => {
    const accepted = { consent: true, syntheticOnly: true, noticeVersion: CODEX_DEMO_NOTICE_VERSION };
    expect(exportInputSchema.parse(accepted)).toEqual(accepted);
    for (const changes of [{ consent: false }, { syntheticOnly: false }, { noticeVersion: 'older-notice' }, { recipient: 'someone' }]) {
      expect(exportInputSchema.safeParse({ ...accepted, ...changes }).success).toBe(false);
    }
    expect(exportInputSchema.safeParse({ consent: true, noticeVersion: CODEX_DEMO_NOTICE_VERSION }).success).toBe(false);
  });

  it('bounds durable job lifetime, revision, identifiers, and exported fields', () => {
    expect(codexDemoJobSchema.parse(job())).toEqual(job());
    for (const changes of [{ revision: -1 }, { revision: 0.5 }, { id: 'not-a-uuid' }, { expiresAt: now }, { expiresAt: now + CODEX_DEMO_TTL_MS + 1 }, { extra: true }]) {
      expect(codexDemoJobSchema.safeParse({ ...job(), ...changes }).success).toBe(false);
    }
    const file = { version: 1, kind: 'safety-guard-codex-request', jobId, createdAt: now, expiresAt: now + CODEX_DEMO_TTL_MS, context: context() };
    expect(codexDemoExportSchema.parse(file)).toEqual(file);
    for (const extra of [{ authorityContext: context() }, { consent: true }, { apiKey: 'secret' }, { revision: 4 }]) {
      expect(codexDemoExportSchema.safeParse({ ...file, ...extra }).success).toBe(false);
    }
    expect(codexDemoExportSchema.safeParse({ ...file, expiresAt: now + CODEX_DEMO_TTL_MS + 1 }).success).toBe(false);
  });

  it('accepts explicit CLI metadata and nullable usage without fabricated provider receipts', () => {
    expect(resultInputSchema.parse(result())).toEqual(result());
    const measured = result({ execution: { ...result().execution, usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 80 } } });
    expect(resultInputSchema.parse(measured)).toEqual(measured);
    for (const extra of [{ responseId: 'resp_fake' }, { model: 'claimed-model' }, { notificationAuthorized: true }, { context: context() }]) {
      expect(resultInputSchema.safeParse({ ...result(), ...extra }).success).toBe(false);
    }
    for (const changes of [{ auth: 'api-key' }, { tool: 'openai' }, { cliVersion: '' }, { cliVersion: 'v'.repeat(81) }, { cliVersion: 'v\nsecret' }, { completedAt: -1 }, { responseId: 'resp_fake' }]) {
      expect(resultInputSchema.safeParse({ ...result(), execution: { ...result().execution, ...changes } }).success).toBe(false);
    }
    for (const usage of [
      { inputTokens: -1, outputTokens: 2, cachedInputTokens: 0 },
      { inputTokens: 1, outputTokens: 2.5, cachedInputTokens: 0 },
      { inputTokens: 1, outputTokens: 2, cachedInputTokens: 2 },
      { inputTokens: 1, outputTokens: 2 },
      { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, totalTokens: 3 },
    ]) expect(resultInputSchema.safeParse({ ...result(), execution: { ...result().execution, usage } }).success).toBe(false);
    expect(resultInputSchema.safeParse({ ...result(), assessment: { ...assessment(), summary: 'Help has arrived.' } }).success).toBe(false);
  });
});

describe('Rider-only minimized Codex demo context', () => {
  it('excludes every other sender and role, caps evidence, and removes structured authority and private details', () => {
    const savedConcerns = Array.from({ length: 10 }, (_, index) => ({
      id: `c${index}`, observedAt: now - 600_000, receivedAt: now - 590_000,
      text: 'Saved concern private@example.com token=verysecret',
    }));
    const value = trip({
      messages: [
        ...Array.from({ length: 15 }, (_, index) => message(`r${index}`, 'rider', 'owner', index === 14
          ? 'Explain route private@example.com https://example.com/private token=verysecret 31.12345,121.12345' : 'r'.repeat(1200))),
        message('g1', 'guardian', 'guardian', 'Private guardian text'),
        message('other-rider', 'rider', 'someone-else', 'Private other rider text'),
        message('spoof-role', 'guardian', 'owner', 'Private guardian role text'),
        message('a1', 'agent', 'agent', 'Private agent text'), message('s1', 'system', 'system', 'Private system text'),
      ],
      agent: { provider: 'mock', liveModel: false, runs: [], followUpAt: null, handoffSummary: null, concerns: savedConcerns },
    });
    const authority = context({
      risk: 'urgent', relayOpen: true, contactAvailable: true, notificationAuthorized: true, escalationCause: 'explicit_help',
      messages: [{ id: 'untrusted-authority-message', at: now, role: 'rider', text: 'Do not export this substituted message' }],
      unresolvedConcerns: [{ id: 'not-saved', observedAt: now, receivedAt: now, text: 'Do not export this substituted concern' }],
      notifications: [{ id: 'private-notification', status: 'sent', detail: 'Private contact detail' }],
    });
    const before = structuredClone({ value, authority });
    const minimized = codexDemoContext(value, authority);
    expect(minimized.messages.map(item => item.id)).toEqual(Array.from({ length: 12 }, (_, index) => `r${index + 3}`));
    expect(minimized.messages.every(item => item.role === 'rider' && item.text.length <= 800)).toBe(true);
    expect(minimized.unresolvedConcerns!.map(item => item.id)).toEqual(Array.from({ length: 8 }, (_, index) => `c${index}`));
    expect(minimized).toMatchObject({ risk: 'normal', relayOpen: false, contactAvailable: false, notifications: [] });
    expect(minimized).not.toHaveProperty('notificationAuthorized');
    expect(minimized).not.toHaveProperty('escalationCause');
    for (const secret of ['private-journey-id', 'Private', 'private@example.com', 'https://example.com', 'verysecret', '31.12345', 'not-saved', 'untrusted-authority-message']) {
      expect(JSON.stringify(minimized)).not.toContain(secret);
    }
    expect({ value, authority }).toEqual(before);
  });

  it('does not borrow concerns or messages from the authority snapshot when the rider has none', () => {
    const minimized = codexDemoContext(trip({ messages: [] }), context({
      unresolvedConcerns: [{ id: 'not-saved', observedAt: now, receivedAt: now, text: 'Not saved' }],
    }));
    expect(minimized.messages).toEqual([]);
    expect(minimized.unresolvedConcerns).toEqual([]);
  });
});

describe('Fresh and source-bound Codex result import', () => {
  it('validates a proposal without granting authority, consuming its job, or changing saved text', () => {
    const saved = job();
    const before = structuredClone(saved);
    expect(validateCodexDemoResult(result(), saved, now + 1)).toEqual(result());
    expect(saved).toEqual(before);
    expect(saved.status).toBe('pending');
    expect(saved.authorityContext.notificationAuthorized).toBe(false);
    expect(saved.context.messages[0].text).toContain('not in danger');
  });

  it('rejects consumed, cancelled, expired, not-yet-created, and mismatched jobs', () => {
    for (const status of ['consumed', 'cancelled'] as const) {
      expect(() => validateCodexDemoResult(result(), job({ status }), now)).toThrow('CODEX_DEMO_JOB_NOT_PENDING');
    }
    for (const at of [now - 1, now + CODEX_DEMO_TTL_MS, now + CODEX_DEMO_TTL_MS + 1]) {
      expect(() => validateCodexDemoResult(result(), job(), at)).toThrow('CODEX_DEMO_JOB_EXPIRED');
    }
    expect(() => validateCodexDemoResult(result({ jobId: otherId }), job(), now)).toThrow('CODEX_DEMO_JOB_MISMATCH');
    for (const at of [NaN, Infinity, -1, 1.5]) expect(() => validateCodexDemoResult(result(), job(), at)).toThrow();
  });

  it('rejects completion before export or after import time', () => {
    for (const completedAt of [now - 1, now + 1]) {
      expect(() => validateCodexDemoResult(result({ execution: { ...result().execution, completedAt } }), job(), now)).toThrow('CODEX_DEMO_COMPLETION_TIME_INVALID');
    }
  });

  it('rejects forged references and sources that were future-dated at export', () => {
    for (const sourceId of ['message:another-trip', 'message:guardian', 'concern:missing']) {
      const proposed = assessment({ question: { kind: 'route_explanation', sourceIds: [sourceId] } });
      expect(() => validateCodexDemoResult(result({ assessment: proposed }), job(), now)).toThrow();
    }
    const future = context({ messages: [{ ...context().messages[0], at: now + 1 }] });
    expect(() => validateCodexDemoResult(result(), job({ context: future }), now + 2)).toThrow('future source');
  });

  it('rechecks message age at import while retaining older saved concerns as unresolved evidence', () => {
    const aging = context({ messages: [{ ...context().messages[0], at: now - 299_000 }] });
    const proposed = result({ assessment: assessment({ findings: [{ kind: 'concern', topic: 'route', sourceIds: ['message:m1'] }] }) });
    expect(validateCodexDemoResult(proposed, job({ context: aging }), now + 1000)).toEqual(proposed);
    expect(() => validateCodexDemoResult(proposed, job({ context: aging }), now + 1001)).toThrow('recent rider');
    const retained = context({ messages: [], unresolvedConcerns: [{ id: 'older', observedAt: now - 3_600_000, receivedAt: now - 3_500_000, text: 'The detour still needs explaining.' }] });
    const retainedProposal = result({ assessment: assessment({
      findings: [{ kind: 'concern', topic: 'route', sourceIds: ['concern:older'] }],
      question: { kind: 'route_explanation', sourceIds: ['concern:older'] },
    }) });
    expect(validateCodexDemoResult(retainedProposal, job({ context: retained }), now + 1001)).toEqual(retainedProposal);
  });
});
