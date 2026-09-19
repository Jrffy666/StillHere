import { z } from 'zod';
import { nextMockDecision, parseAgentToolCall } from './agent';
import type { AgentDecision, AgentStep, AgentTrigger } from './agent';

export const AGENT_PROVIDER_DEADLINE_MS = 8_000;
export const AGENT_PROVIDER_LEASE_MS = 15_000;
export const AGENT_PROVIDER_MAX_INPUT_CHARS = 32_000;
export const AGENT_PROVIDER_MAX_OUTPUT_CHARS = 8_000;

export interface AgentProviderInput {
  trigger: AgentTrigger;
  steps: AgentStep[];
  signal: AbortSignal;
}

/** Decision-only capability: no executor, application bindings, credentials, or fetch callback. */
export interface AgentProvider {
  readonly id: 'mock' | 'openai';
  readonly live: boolean;
  decide(input: AgentProviderInput): Promise<unknown>;
}

export interface ProviderDecisionOptions {
  provider: AgentProvider;
  trigger: AgentTrigger;
  steps: AgentStep[];
  signal?: AbortSignal;
  timeoutMs?: number;
  maximumInputChars?: number;
  maximumOutputChars?: number;
}

export type AgentProviderErrorCode =
  | 'LIVE_PROVIDER_DISABLED'
  | 'PROVIDER_ABORTED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_INVALID_LIMIT'
  | 'PROVIDER_INVALID_INPUT'
  | 'PROVIDER_INPUT_TOO_LARGE'
  | 'PROVIDER_INVALID_OUTPUT'
  | 'PROVIDER_OUTPUT_TOO_LARGE'
  | 'PROVIDER_FAILED';

export class AgentProviderError extends Error {
  constructor(readonly code: AgentProviderErrorCode) {
    super(code);
    this.name = 'AgentProviderError';
  }
}

const decisionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tool'), call: z.unknown() }).strict(),
  z.object({ type: z.literal('complete'), summary: z.string().max(1200).trim().min(1) }).strict(),
]);

function limit(value: number | undefined, ceiling: number): number {
  const resolved = value ?? ceiling;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > ceiling) {
    throw new AgentProviderError('PROVIDER_INVALID_LIMIT');
  }
  return resolved;
}

function serialize(value: unknown, invalidCode: 'PROVIDER_INVALID_INPUT' | 'PROVIDER_INVALID_OUTPUT'): string {
  try {
    const encoded = JSON.stringify(value);
    if (typeof encoded !== 'string') throw new Error('Not JSON serializable');
    return encoded;
  } catch {
    throw new AgentProviderError(invalidCode);
  }
}

function parseDecision(output: unknown, maximumOutputChars: number): AgentDecision {
  const encoded = serialize(output, 'PROVIDER_INVALID_OUTPUT');
  if (encoded.length > maximumOutputChars) throw new AgentProviderError('PROVIDER_OUTPUT_TOO_LARGE');
  try {
    const decision = decisionSchema.parse(output);
    return decision.type === 'tool'
      ? { type: 'tool', call: parseAgentToolCall(decision.call) }
      : decision;
  } catch {
    throw new AgentProviderError('PROVIDER_INVALID_OUTPUT');
  }
}

/**
 * Offline, bounded provider invocation. Character limits are UTF-16 serialized
 * character estimates, not measured tokens or billing/token accounting.
 * The durable runner separately owns persisted cumulative budgets and renews
 * its lease before every decision; the deadline must remain below that lease.
 * Cancellation actively aborts cooperative adapters and discards late results
 * from adapters that ignore the signal. It cannot terminate synchronous code.
 */
export async function runProviderDecision(options: ProviderDecisionOptions): Promise<AgentDecision> {
  const { provider, signal } = options;
  if (provider.live) throw new AgentProviderError('LIVE_PROVIDER_DISABLED');
  if (signal?.aborted) throw new AgentProviderError('PROVIDER_ABORTED');
  const timeoutMs = limit(options.timeoutMs, AGENT_PROVIDER_DEADLINE_MS);
  const maximumInputChars = limit(options.maximumInputChars, AGENT_PROVIDER_MAX_INPUT_CHARS);
  const maximumOutputChars = limit(options.maximumOutputChars, AGENT_PROVIDER_MAX_OUTPUT_CHARS);
  const encodedInput = serialize({ trigger: options.trigger, steps: options.steps }, 'PROVIDER_INVALID_INPUT');
  if (encodedInput.length > maximumInputChars) throw new AgentProviderError('PROVIDER_INPUT_TOO_LARGE');

  // A detached JSON snapshot prevents an adapter from mutating persisted state.
  const input: Pick<AgentProviderInput, 'trigger' | 'steps'> = JSON.parse(encodedInput);
  const controller = new AbortController();
  return new Promise<AgentDecision>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof AgentProviderError ? error : new AgentProviderError('PROVIDER_FAILED'));
    };
    const abort = (code: 'PROVIDER_ABORTED' | 'PROVIDER_TIMEOUT') => {
      if (settled) return;
      const error = new AgentProviderError(code);
      // Settle before dispatching abort; an adapter's abort handler cannot win.
      fail(error);
      controller.abort(error);
    };
    const onAbort = () => abort('PROVIDER_ABORTED');
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => abort('PROVIDER_TIMEOUT'), timeoutMs);
    // Both handlers stay attached after cancellation, consuming late failures.
    void Promise.resolve()
      .then(() => settled ? undefined : provider.decide({ ...input, signal: controller.signal }))
      .then(output => {
        if (settled) return;
        try {
          const decision = parseDecision(output, maximumOutputChars);
          settled = true;
          cleanup();
          resolve(decision);
        } catch (error) {
          fail(error);
        }
      }, fail);
  });
}

export function createMockProvider(): AgentProvider {
  return {
    id: 'mock',
    live: false,
    decide: ({ trigger, steps, signal }) => {
      if (signal.aborted) return Promise.reject(new AgentProviderError('PROVIDER_ABORTED'));
      return nextMockDecision(trigger, steps);
    },
  };
}

/** Intentionally has no key/configuration parameter and no live enable switch. */
export function createDisabledOpenAIProvider(): AgentProvider {
  return {
    id: 'openai',
    live: false,
    decide: async () => { throw new AgentProviderError('LIVE_PROVIDER_DISABLED'); },
  };
}
