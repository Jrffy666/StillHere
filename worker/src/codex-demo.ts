import { z } from 'zod';
import { contextSchema, type AgentContext } from './agent';
import { semanticAssessmentSchema, validateSemanticAssessment } from './agent-semantic';
import { prepareOpenAIRequest } from './openai-provider';
import type { Trip } from './types';

export const CODEX_DEMO_NOTICE_VERSION = 'codex-demo-v1';
export const CODEX_DEMO_TTL_MS = 300_000;

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const validLifetime = (value: { createdAt: number; expiresAt: number }) =>
  value.expiresAt > value.createdAt && value.expiresAt - value.createdAt <= CODEX_DEMO_TTL_MS;

/** These acknowledgements are explicit assertions, not proof that free text is synthetic. */
export const exportInputSchema = z.object({
  consent: z.literal(true),
  syntheticOnly: z.literal(true),
  noticeVersion: z.literal(CODEX_DEMO_NOTICE_VERSION),
}).strict();

/** Durable, private server state. authorityContext must never be included in an export file. */
export const codexDemoJobSchema = z.object({
  id: z.uuid(),
  revision: z.number().int().nonnegative(),
  createdAt: timestamp,
  expiresAt: timestamp,
  context: contextSchema,
  authorityContext: contextSchema,
  status: z.enum(['pending', 'consumed', 'cancelled']),
}).strict().refine(validLifetime, 'A Codex demo job must expire within five minutes.');

export const codexDemoExportSchema = z.object({
  version: z.literal(1),
  kind: z.literal('safety-guard-codex-request'),
  jobId: z.uuid(),
  createdAt: timestamp,
  expiresAt: timestamp,
  context: contextSchema,
}).strict().refine(validLifetime, 'A Codex demo export must expire within five minutes.');

export const resultInputSchema = z.object({
  version: z.literal(1),
  kind: z.literal('safety-guard-codex-result'),
  jobId: z.uuid(),
  assessment: semanticAssessmentSchema,
  execution: z.object({
    tool: z.literal('codex-cli'),
    auth: z.literal('chatgpt'),
    cliVersion: z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/),
    completedAt: timestamp,
    usage: z.object({
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      cachedInputTokens: tokenCount,
    }).strict().refine(usage => usage.cachedInputTokens <= usage.inputTokens, 'Cached input tokens cannot exceed input tokens.').nullable(),
  }).strict(),
}).strict();

export type CodexDemoExportInput = z.infer<typeof exportInputSchema>;
export type CodexDemoJob = z.infer<typeof codexDemoJobSchema>;
export type CodexDemoExportFile = z.infer<typeof codexDemoExportSchema>;
export type CodexDemoResult = z.infer<typeof resultInputSchema>;

/** Preparation only: no provider request, credentials, participant names, or guardian text. */
export function codexDemoContext(trip: Trip, authorityContext: AgentContext): AgentContext {
  const riderContext: AgentContext = {
    ...authorityContext,
    messages: trip.messages
      .filter(message => message.role === 'rider' && message.senderId === trip.rider.id)
      .slice(-12)
      .map(({ id, at, role, text }) => ({ id, at, role, text })),
    unresolvedConcerns: (trip.agent?.concerns ?? []).slice(0, 8)
      .map(({ id, observedAt, receivedAt, text }) => ({ id, observedAt, receivedAt, text })),
  };
  return contextSchema.parse(prepareOpenAIRequest({ model: 'gpt-4.1-mini-2025-04-14', context: riderContext }).context);
}

/** Caller also checks owner, revision, consent, lifecycle, and atomically consumes the job. */
export function validateCodexDemoResult(input: unknown, job: CodexDemoJob, now: number): CodexDemoResult {
  const currentTime = timestamp.parse(now);
  const saved = codexDemoJobSchema.parse(job);
  const result = resultInputSchema.parse(input);
  if (saved.status !== 'pending') throw new Error('CODEX_DEMO_JOB_NOT_PENDING');
  if (currentTime < saved.createdAt || currentTime >= saved.expiresAt) throw new Error('CODEX_DEMO_JOB_EXPIRED');
  if (result.jobId !== saved.id) throw new Error('CODEX_DEMO_JOB_MISMATCH');
  if (result.execution.completedAt < saved.createdAt || result.execution.completedAt > currentTime) {
    throw new Error('CODEX_DEMO_COMPLETION_TIME_INVALID');
  }
  // A future source in the original snapshot must not become valid just by waiting.
  validateSemanticAssessment(result.assessment, saved.context);
  result.assessment = validateSemanticAssessment(result.assessment, { ...saved.context, now: currentTime });
  return result;
}
