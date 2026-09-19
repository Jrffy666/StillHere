import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_PROVIDER_DEADLINE_MS,
  AGENT_PROVIDER_LEASE_MS,
  AGENT_PROVIDER_MAX_INPUT_CHARS,
  AGENT_PROVIDER_MAX_OUTPUT_CHARS,
  createDisabledOpenAIProvider,
  createMockProvider,
  runProviderDecision,
} from '../src/agent-provider';
import type { AgentProvider, AgentProviderInput } from '../src/agent-provider';
import type { AgentStep, AgentTrigger } from '../src/agent';

const trigger: AgentTrigger = { id: 'trigger', kind: 'takeover', at: 1_800_000_000_000 };
const complete = { type: 'complete', summary: 'Offline run completed.' };
const providerFor = (output: unknown): AgentProvider => ({ id: 'mock', live: false, decide: vi.fn(async () => output) });
const invoke = (provider: AgentProvider) => runProviderDecision({ provider, trigger, steps: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((fulfill, fail) => { resolve = fulfill; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Offline provider capability and validation', () => {
  it('runs the deterministic mock through the boundary without network access', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const provider = createMockProvider();
    expect(provider).toMatchObject({ id: 'mock', live: false });
    await expect(invoke(provider)).resolves.toEqual({ type: 'tool', call: { name: 'get_journey_context', arguments: {} } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes only detached trigger, steps, and an abort signal to a provider', async () => {
    const originalTrigger = { ...trigger };
    const steps: AgentStep[] = [];
    const decide = vi.fn(async (input: AgentProviderInput) => {
      expect(Object.keys(input).sort()).toEqual(['signal', 'steps', 'trigger']);
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.trigger).not.toBe(originalTrigger);
      expect(input.steps).not.toBe(steps);
      input.trigger.id = 'mutated';
      input.steps.push({ id: 'injected', at: trigger.at, status: 'pending', call: { name: 'get_journey_context', arguments: {} } });
      return complete;
    });
    await expect(runProviderDecision({ provider: { id: 'mock', live: false, decide }, trigger: originalTrigger, steps })).resolves.toEqual(complete);
    expect(originalTrigger.id).toBe('trigger');
    expect(steps).toEqual([]);
  });

  it('accepts validated tools and a completion summary of at most 1200 characters', async () => {
    const tool = { type: 'tool', call: { name: 'schedule_follow_up', arguments: { delaySeconds: 30 } } };
    await expect(invoke(providerFor(tool))).resolves.toEqual(tool);
    await expect(invoke(providerFor({ type: 'complete', summary: 'a'.repeat(1200) }))).resolves.toEqual({ type: 'complete', summary: 'a'.repeat(1200) });
    await expect(invoke(providerFor({ type: 'complete', summary: 'a'.repeat(1201) }))).rejects.toThrow('PROVIDER_INVALID_OUTPUT');
  });

  it('rejects malformed decisions, forbidden tools, recipient injection, and extra fields', async () => {
    const malformed: unknown[] = [
      null, undefined, 'done', [], {}, true,
      { type: 'complete' }, { type: 'complete', summary: '' }, { type: 'complete', summary: '  ' },
      { type: 'complete', summary: 5 }, { ...complete, call: { name: 'get_journey_context', arguments: {} } },
      { type: 'tool' }, { type: 'tool', call: null },
      { type: 'tool', call: { name: 'sign_transaction', arguments: {} } },
      { type: 'tool', call: { name: 'approve_guardian', arguments: {} } },
      { type: 'tool', call: { name: 'get_journey_context', arguments: { tripId: 'other' } } },
      { type: 'tool', call: { name: 'get_journey_context', arguments: {} }, summary: 'extra' },
      { type: 'tool', call: { name: 'notify_trusted_contact', arguments: { reason: 'help', recipient: 'attacker' } } },
      { type: 'tool', call: { name: 'send_check_in', arguments: { text: 'x'.repeat(601) } } },
      { type: 'tool', call: { name: 'schedule_follow_up', arguments: { delaySeconds: 1 } } },
      { type: 'tool', call: { name: 'schedule_follow_up', arguments: { delaySeconds: NaN } } },
    ];
    for (const output of malformed) await expect(invoke(providerFor(output))).rejects.toThrow('PROVIDER_INVALID_OUTPUT');
  });

  it('rejects unserializable provider output without exposing its contents', async () => {
    const cycle: Record<string, unknown> = { ...complete };
    cycle.self = cycle;
    for (const output of [cycle, { ...complete, unexpected: BigInt(1) }]) {
      await expect(invoke(providerFor(output))).rejects.toThrow('PROVIDER_INVALID_OUTPUT');
    }
  });

  it('rejects oversized serialized input before invoking the provider', async () => {
    const provider = providerFor(complete);
    await expect(runProviderDecision({ provider, trigger: { ...trigger, id: 'x'.repeat(AGENT_PROVIDER_MAX_INPUT_CHARS) }, steps: [] })).rejects.toThrow('PROVIDER_INPUT_TOO_LARGE');
    expect(provider.decide).not.toHaveBeenCalled();
    const inputChars = JSON.stringify({ trigger, steps: [] }).length;
    await expect(runProviderDecision({ provider, trigger, steps: [], maximumInputChars: inputChars - 1 })).rejects.toThrow('PROVIDER_INPUT_TOO_LARGE');
    await expect(runProviderDecision({ provider, trigger, steps: [], maximumInputChars: inputChars })).resolves.toEqual(complete);
  });

  it('bounds serialized output before parsing and honors a smaller output budget', async () => {
    await expect(invoke(providerFor({ type: 'complete', summary: 'x'.repeat(AGENT_PROVIDER_MAX_OUTPUT_CHARS) }))).rejects.toThrow('PROVIDER_OUTPUT_TOO_LARGE');
    const outputChars = JSON.stringify(complete).length;
    await expect(runProviderDecision({ provider: providerFor(complete), trigger, steps: [], maximumOutputChars: outputChars - 1 })).rejects.toThrow('PROVIDER_OUTPUT_TOO_LARGE');
    await expect(runProviderDecision({ provider: providerFor(complete), trigger, steps: [], maximumOutputChars: outputChars })).resolves.toEqual(complete);
  });

  it('rejects invalid limits and cannot extend a decision past the lease', async () => {
    expect(AGENT_PROVIDER_DEADLINE_MS).toBeLessThan(AGENT_PROVIDER_LEASE_MS);
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, AGENT_PROVIDER_DEADLINE_MS + 1]) {
      const provider = providerFor(complete);
      await expect(runProviderDecision({ provider, trigger, steps: [], timeoutMs })).rejects.toThrow('PROVIDER_INVALID_LIMIT');
      expect(provider.decide).not.toHaveBeenCalled();
    }
    for (const budgets of [{ maximumInputChars: 0 }, { maximumOutputChars: 0 }, { maximumInputChars: AGENT_PROVIDER_MAX_INPUT_CHARS + 1 }, { maximumOutputChars: AGENT_PROVIDER_MAX_OUTPUT_CHARS + 1 }]) {
      await expect(runProviderDecision({ provider: providerFor(complete), trigger, steps: [], ...budgets })).rejects.toThrow('PROVIDER_INVALID_LIMIT');
    }
  });

  it('keeps the OpenAI adapter disabled even with a dummy key and never reads configuration', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    vi.stubGlobal('OPENAI_API_KEY', 'dummy-key-never-used');
    const provider = createDisabledOpenAIProvider();
    expect(provider).toMatchObject({ id: 'openai', live: false });
    await expect(provider.decide({ trigger, steps: [], signal: new AbortController().signal })).rejects.toThrow('LIVE_PROVIDER_DISABLED');
    await expect(invoke(provider)).rejects.toThrow('LIVE_PROVIDER_DISABLED');
    const keyRead = vi.fn(() => { throw new Error('Must not read a key'); });
    Object.defineProperty(globalThis, 'OPENAI_API_KEY', { configurable: true, get: keyRead });
    await expect(invoke(createDisabledOpenAIProvider())).rejects.toThrow('LIVE_PROVIDER_DISABLED');
    expect(keyRead).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects any live provider before its callback can run', async () => {
    const provider = { ...providerFor(complete), id: 'openai' as const, live: true };
    await expect(invoke(provider)).rejects.toThrow('LIVE_PROVIDER_DISABLED');
    expect(provider.decide).not.toHaveBeenCalled();
  });
});

describe('Abortable provider deadline', () => {
  it('actively aborts a pending provider at the deadline and removes its timer', async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const aborted = vi.fn();
    const provider: AgentProvider = { id: 'mock', live: false, decide: ({ signal }) => {
      providerSignal = signal;
      signal.addEventListener('abort', aborted);
      return new Promise(() => {});
    } };
    const result = invoke(provider);
    const assertion = expect(result).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(AGENT_PROVIDER_DEADLINE_MS - 1);
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(aborted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an already aborted request without starting a provider or timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const provider = providerFor(complete);
    await expect(runProviderDecision({ provider, trigger, steps: [], signal: controller.signal })).rejects.toThrow('PROVIDER_ABORTED');
    expect(provider.decide).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates mid-flight cancellation to the adapter and detaches its listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const started = deferred<AbortSignal>();
    const provider: AgentProvider = { id: 'mock', live: false, decide: ({ signal }) => {
      started.resolve(signal);
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('Adapter abort'))));
    } };
    const result = runProviderDecision({ provider, trigger, steps: [], signal: controller.signal });
    const assertion = expect(result).rejects.toThrow('PROVIDER_ABORTED');
    const providerSignal = await started.promise;
    controller.abort();
    await assertion;
    expect(providerSignal.aborted).toBe(true);
    expect(providerSignal.reason).toMatchObject({ code: 'PROVIDER_ABORTED' });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an adapter when cancelled before its invocation microtask', async () => {
    const controller = new AbortController();
    const provider = providerFor(complete);
    const result = runProviderDecision({ provider, trigger, steps: [], signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toThrow('PROVIDER_ABORTED');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('consumes late provider %s after timeout without accepting a decision', async outcome => {
    vi.useFakeTimers();
    const late = deferred<unknown>();
    const provider: AgentProvider = { id: 'mock', live: false, decide: () => late.promise };
    const result = runProviderDecision({ provider, trigger, steps: [], timeoutMs: 10 });
    const fulfilled = vi.fn();
    const rejected = vi.fn();
    const observed = result.then(fulfilled, rejected);
    await vi.advanceTimersByTimeAsync(10);
    await observed;
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVIDER_TIMEOUT' }));
    if (outcome === 'resolve') late.resolve(complete);
    else late.reject(new Error('Late adapter failure'));
    await vi.advanceTimersByTimeAsync(1);
    expect(fulfilled).not.toHaveBeenCalled();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans timers and abort listeners after success and synchronous provider failure', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(runProviderDecision({ provider: providerFor(complete), trigger, steps: [], signal: controller.signal })).resolves.toEqual(complete);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    const provider: AgentProvider = { id: 'mock', live: false, decide: () => { throw new Error('Internal provider data'); } };
    await expect(invoke(provider)).rejects.toThrow('PROVIDER_FAILED');
    expect(vi.getTimerCount()).toBe(0);
  });
});
