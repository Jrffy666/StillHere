import { assessInMemory } from './codex-demo';
import { validateSemanticAssessment, type SemanticAssessment } from '../worker/src/agent-semantic';
import type { PersonalAgentJob, PersonalAgentResponse } from '../worker/src/personal-agent';
import { PersonalAgentError, failure, type PersonalAgentTransport } from './personal-agent-client';

export const POLL_MS = 5000;
export const HEARTBEAT_MS = 10_000;
export interface WatchOptions { maxTurns?: number; maxMinutes?: number; signal?: AbortSignal }
export interface WatchDependencies {
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  assess?: (job: PersonalAgentJob, signal: AbortSignal) => Promise<SemanticAssessment>;
  onEvent?: (event: { kind: 'connected' | 'completed' | 'stale' | 'stopped'; turns: number }) => void;
  heartbeatMs?: number;
  pollMs?: number;
}
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new PersonalAgentError('STILLHERE_STOPPED')); return; }
    const abort = () => { clearTimeout(timer); reject(new PersonalAgentError('STILLHERE_STOPPED')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function checkResponse(response: PersonalAgentResponse): void {
  if (!['connecting', 'active'].includes(response.delegation.status)) failure('STILLHERE_DELEGATION_ENDED');
}
/** Retries only the identical proposal, never inference; an uncertain final submission stops the runner. */
export async function submitAssessment(client: PersonalAgentTransport, job: PersonalAgentJob, assessment: SemanticAssessment,
  signal: AbortSignal, sleep = wait, now = Date.now): Promise<PersonalAgentResponse> {
  const body = { jobId: job.id, assessment };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (now() >= job.expiresAt) failure('STILLHERE_JOB_EXPIRED');
    try {
      const response = await client.call('assess', body, signal);
      if (response.receipt?.jobId !== job.id) failure('STILLHERE_RECEIPT_MISSING');
      checkResponse(response);
      return response;
    } catch (error) {
      if (!(error instanceof PersonalAgentError) || !error.retryable || attempt === 2) throw error;
      await sleep(1000, signal);
    }
  }
  return failure('STILLHERE_SUBMISSION_UNCERTAIN');
}
/** Finite owner-operated runtime. Heartbeats indicate connectivity, never model progress. */
export async function watchPersonalAgent(client: PersonalAgentTransport, options: WatchOptions = {}, dependencies: WatchDependencies = {}) {
  const maxTurns = options.maxTurns ?? 12;
  const maxMinutes = options.maxMinutes ?? 20;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 60
    || !Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 120) failure('STILLHERE_INVALID_LIMITS');
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? wait;
  const assess = dependencies.assess ?? (async (job, signal) => (await assessInMemory({ context: job.context,
    expiresAt: job.expiresAt, processingApproved: true }, { signal })).assessment);
  const deadline = Math.min(client.expiresAt, now() + maxMinutes * 60_000);
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const totalTimer = setTimeout(() => controller.abort(), Math.max(1, deadline - now()));
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending: Promise<void> | undefined;
  let updateTimer: ReturnType<typeof setInterval> | undefined;
  let updatePending: Promise<void> | undefined;
  let heartbeatFailure: unknown;
  let currentJob: PersonalAgentJob | null = null;
  let inferenceAbort: AbortController | undefined;
  let stale = false;
  let turns = 0;
  let releaseReason: 'stopped' | 'model_unavailable' | 'limit_reached' = 'model_unavailable';
  const seen = new Set<string>();
  try {
    let response = await client.call('accept', {}, signal);
    checkResponse(response);
    dependencies.onEvent?.({ kind: 'connected', turns });
    heartbeatTimer = setInterval(() => {
      if (heartbeatPending || signal.aborted) return;
      heartbeatPending = (async () => {
        try {
          const update = await client.call('heartbeat', {}, signal);
          checkResponse(update);
        } catch (error) { heartbeatFailure = error; controller.abort(); }
      })().finally(() => { heartbeatPending = undefined; });
    }, dependencies.heartbeatMs ?? HEARTBEAT_MS);
    updateTimer = setInterval(() => {
      if (updatePending || !currentJob || signal.aborted) return;
      const expectedJobId = currentJob.id;
      updatePending = (async () => {
        try {
          const update = await client.call('updates', {}, signal);
          checkResponse(update);
          if (currentJob?.id === expectedJobId && update.job?.id !== expectedJobId) { stale = true; inferenceAbort?.abort(); }
        } catch (error) { heartbeatFailure = error; controller.abort(); }
      })().finally(() => { updatePending = undefined; });
    }, dependencies.pollMs ?? POLL_MS);
    while (turns < maxTurns && now() < deadline && !signal.aborted) {
      checkResponse(response);
      const job = response.job;
      if (!job) {
        await sleep(Math.min(POLL_MS, deadline - now()), signal);
        response = await client.call('updates', {}, signal);
        continue;
      }
      if (now() >= job.expiresAt) failure('STILLHERE_JOB_EXPIRED');
      if (seen.has(job.id)) failure('STILLHERE_JOB_REPEATED');
      seen.add(job.id);
      currentJob = job;
      stale = false;
      inferenceAbort = new AbortController();
      const inferenceSignal = AbortSignal.any([signal, inferenceAbort.signal]);
      const jobTimer = setTimeout(() => inferenceAbort?.abort(), Math.max(1, Math.min(job.expiresAt, deadline) - now()));
      let assessment: SemanticAssessment;
      try {
        turns++;
        assessment = await assess(job, inferenceSignal);
        assessment = validateSemanticAssessment(assessment, job.context);
        assessment = validateSemanticAssessment(assessment, { ...job.context, now: now() });
      } catch (error) {
        if (!stale || signal.aborted) throw error;
        dependencies.onEvent?.({ kind: 'stale', turns });
        response = await client.call('updates', {}, signal);
        continue;
      } finally { clearTimeout(jobTimer); currentJob = null; inferenceAbort = undefined; }
      if (signal.aborted) failure('STILLHERE_STOPPED');
      if (now() >= job.expiresAt || now() >= deadline) failure('STILLHERE_JOB_EXPIRED');
      response = await client.call('updates', {}, signal);
      checkResponse(response);
      if (response.job?.id !== job.id || stale) { dependencies.onEvent?.({ kind: 'stale', turns }); continue; }
      response = await submitAssessment(client, job, assessment, signal, sleep, now);
      dependencies.onEvent?.({ kind: 'completed', turns });
    }
    if (heartbeatFailure) throw heartbeatFailure;
    releaseReason = options.signal?.aborted ? 'stopped' : 'limit_reached';
    return { turns, reason: releaseReason };
  } catch (error) {
    if (options.signal?.aborted) { releaseReason = 'stopped'; return { turns, reason: releaseReason }; }
    if (now() >= deadline) { releaseReason = 'limit_reached'; return { turns, reason: releaseReason }; }
    throw heartbeatFailure ?? error;
  } finally {
    clearInterval(heartbeatTimer);
    clearInterval(updateTimer);
    clearTimeout(totalTimer);
    controller.abort();
    inferenceAbort?.abort();
    await heartbeatPending;
    await updatePending;
    try { await client.call('release', { reason: releaseReason }, AbortSignal.timeout(3000)); } catch { /* Server deadlines remain authoritative if disconnected. */ }
    dependencies.onEvent?.({ kind: 'stopped', turns });
  }
}
