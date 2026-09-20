import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import {
  personalAgentConnectionSchema, personalAgentOperationSchema, personalAgentEmptyInputSchema,
  personalAgentAssessmentInputSchema, personalAgentReleaseInputSchema, personalAgentResponseSchema,
  type PersonalAgentConnection, type PersonalAgentOperation, type PersonalAgentResponse,
} from '../worker/src/personal-agent';

export const PRODUCTION_ORIGIN = 'https://safety-guard-api-production.2012044zj.workers.dev';
export const MAX_CONNECTION_BYTES = 4096;
export const MAX_REQUEST_BYTES = 16_384;
export const MAX_RESPONSE_BYTES = 262_144;
export const REQUEST_TIMEOUT_MS = 8000;
export class PersonalAgentError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly status?: number) { super(code); this.name = 'PersonalAgentError'; }
}
export function failure(code: string): never { throw new PersonalAgentError(code); }
export function safeError(error: unknown): string {
  return error instanceof PersonalAgentError ? error.code : 'STILLHERE_LOCAL_FAILURE';
}
export function parseConnection(raw: unknown, options: { allowLoopback?: boolean; now?: number } = {}): PersonalAgentConnection {
  const parsed = personalAgentConnectionSchema.safeParse(raw);
  if (!parsed.success) failure('STILLHERE_INVALID_CONNECTION');
  const value = parsed.data;
  const url = new URL(value.origin);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (value.origin !== PRODUCTION_ORIGIN && !(options.allowLoopback && loopback)) failure('STILLHERE_UNTRUSTED_ORIGIN');
  const now = options.now ?? Date.now();
  if (value.expiresAt <= now || value.expiresAt > now + 120 * 60_000) failure('STILLHERE_CONNECTION_EXPIRED');
  return value;
}
export async function readBoundedJson(file: string, maxBytes: number): Promise<unknown> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) failure('STILLHERE_INVALID_INPUT_FILE');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await handle.stat()).isFile()) failure('STILLHERE_INVALID_INPUT_FILE');
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > maxBytes) failure('STILLHERE_INPUT_TOO_LARGE');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { return failure('STILLHERE_INVALID_JSON'); }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof PersonalAgentError) throw error;
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') failure('STILLHERE_INPUT_FILE_NOT_FOUND');
    if (code === 'EACCES' || code === 'EPERM') failure('STILLHERE_INPUT_FILE_UNREADABLE');
    throw error;
  }
}
export function parseOperationInput(operation: PersonalAgentOperation, body: unknown): unknown {
  const schema = operation === 'assess' ? personalAgentAssessmentInputSchema
    : operation === 'release' ? personalAgentReleaseInputSchema : personalAgentEmptyInputSchema;
  const result = schema.safeParse(body);
  if (!result.success) failure('STILLHERE_INVALID_TOOL_ARGUMENTS');
  return result.data;
}

export interface PersonalAgentTransport {
  readonly expiresAt: number;
  call(operation: PersonalAgentOperation, body?: unknown, signal?: AbortSignal): Promise<PersonalAgentResponse>;
}
export class PersonalAgentClient implements PersonalAgentTransport {
  #connection: PersonalAgentConnection;
  #fetch: typeof fetch;
  #now: () => number;
  readonly expiresAt: number;
  constructor(connection: unknown, options: { allowLoopback?: boolean; processingApproved: boolean; fetch?: typeof fetch; now?: () => number }) {
    if (!options.processingApproved) failure('STILLHERE_PROCESSING_CONSENT_REQUIRED');
    this.#now = options.now ?? Date.now;
    this.#connection = parseConnection(connection, { allowLoopback: options.allowLoopback, now: this.#now() });
    this.expiresAt = this.#connection.expiresAt;
    this.#fetch = options.fetch ?? fetch;
  }
  async call(operation: PersonalAgentOperation, body: unknown = {}, signal?: AbortSignal): Promise<PersonalAgentResponse> {
    if (!personalAgentOperationSchema.safeParse(operation).success) failure('STILLHERE_INVALID_OPERATION');
    if (signal?.aborted) failure('STILLHERE_STOPPED');
    if (this.#now() >= this.expiresAt) failure('STILLHERE_CONNECTION_EXPIRED');
    const payload = JSON.stringify(parseOperationInput(operation, body));
    if (Buffer.byteLength(payload) > MAX_REQUEST_BYTES) failure('STILLHERE_REQUEST_TOO_LARGE');
    const connection = this.#connection;
    const url = `${connection.origin}/api/agent/trips/${connection.tripId}/delegations/${connection.delegationId}/${operation}`;
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, this.expiresAt - this.#now())));
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(url, { method: 'POST', redirect: 'error', signal: requestSignal,
        headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json', accept: 'application/json' }, body: payload });
    } catch {
      if (signal?.aborted) failure('STILLHERE_STOPPED');
      throw new PersonalAgentError('STILLHERE_TRANSPORT_UNCERTAIN', true);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PersonalAgentError(`STILLHERE_HTTP_${response.status}`, response.status >= 500, response.status);
    }
    if (response.redirected || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel(); failure('STILLHERE_INVALID_RESPONSE');
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_RESPONSE_BYTES || !response.body) { await response.body?.cancel(); failure('STILLHERE_RESPONSE_TOO_LARGE'); }
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > MAX_RESPONSE_BYTES) failure('STILLHERE_RESPONSE_TOO_LARGE');
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof PersonalAgentError) throw error;
      throw new PersonalAgentError('STILLHERE_TRANSPORT_UNCERTAIN', true);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let raw: unknown;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { return failure('STILLHERE_INVALID_RESPONSE'); }
    const result = personalAgentResponseSchema.safeParse(raw);
    if (!result.success || result.data.delegation.id !== connection.delegationId
      || result.data.delegation.expiresAt !== connection.expiresAt) failure('STILLHERE_INVALID_RESPONSE');
    const job = result.data.job;
    if (job && (job.expiresAt <= job.createdAt || job.expiresAt - job.createdAt > 90_000
      || job.expiresAt > connection.expiresAt || job.context.now > this.#now())) failure('STILLHERE_INVALID_JOB');
    return result.data;
  }
}
