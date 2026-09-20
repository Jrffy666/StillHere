import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn as nodeSpawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PersonalAgentClient, PersonalAgentError, PRODUCTION_ORIGIN, parseConnection, readBoundedJson,
  MAX_RESPONSE_BYTES, type PersonalAgentTransport,
} from './personal-agent-client';
import { parsePersonalAgentArguments } from './personal-agent';
import { PersonalAgentMcp, serveMcp, MCP_TOOLS, MCP_MAX_LINE_BYTES, MCP_MAX_METADATA_BYTES } from './personal-agent-mcp';
import { submitAssessment, watchPersonalAgent } from './personal-agent-watch';
import { assessInMemory, DISABLED_FEATURES, VERIFIED_CODEX_VERSION, runProcess, type SpawnProcess } from './codex-demo';
import type { PersonalAgentJob, PersonalAgentResponse, PersonalAgentOperation } from '../worker/src/personal-agent';
import type { SemanticAssessment } from '../worker/src/agent-semantic';
import { parseHostedValidationArguments } from './verify-personal-agent-hosted';

const NOW = 1_900_000_000_000;
const UUID = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
const TOKEN = `shpa_${'a'.repeat(64)}`;
const connection = () => ({ version: 1, kind: 'stillhere-agent-connection', origin: PRODUCTION_ORIGIN,
  tripId: UUID, delegationId: UUID, token: TOKEN, expiresAt: NOW + 1200_000 });
const assessment: SemanticAssessment = { findings: [], question: { kind: 'companionship', sourceIds: ['message:rider-1'] }, requestRelay: false, followUpSeconds: 60 };
const job = (): PersonalAgentJob => ({ id: UUID, revision: 1, createdAt: NOW, expiresAt: NOW + 90_000,
  context: { now: NOW, status: 'active', guardMode: 'ai', risk: 'normal', location: { updatedAt: NOW, ageSeconds: 0, stale: false },
    messages: [{ id: 'rider-1', at: NOW, role: 'rider', text: 'I would like some company.' }],
    relayOpen: false, notifications: [], contactAvailable: false, unresolvedConcerns: [] } });
const response = (pending: PersonalAgentJob | null = job()): PersonalAgentResponse => ({ delegation: {
  id: UUID, ownerId: UUID, ownerName: 'Volunteer', agentName: 'Night companion', status: 'connecting', createdAt: NOW,
  expiresAt: NOW + 1200_000, riderApprovedAt: NOW, connectedAt: NOW, lastSeenAt: NOW, lastProcessedAt: null,
  nextResponseDueAt: NOW + 90_000, lastActionAt: null, endedAt: null, endReason: null, connectionIssued: true, receipts: [],
}, job: pending });
const receiptResponse = (): PersonalAgentResponse => ({ ...response(null), receipt: {
  id: SECOND, jobId: UUID, at: NOW, assessment, summary: 'One canonical question was added.',
  actions: [{ name: 'send_check_in', outcome: 'succeeded', detail: 'Stored in journey chat.' }],
} });
const jsonResponse = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
function mockTransport(handler: (operation: PersonalAgentOperation, body: unknown, signal?: AbortSignal) => Promise<PersonalAgentResponse> | PersonalAgentResponse) {
  const calls: { operation: PersonalAgentOperation; body: unknown }[] = [];
  const client: PersonalAgentTransport = { expiresAt: NOW + 1200_000,
    call: async (operation, body = {}, signal) => { calls.push({ operation, body }); return handler(operation, body, signal); } };
  return { client, calls };
}

test('connection requires a pinned exact origin, bounded life, strict fields and scoped token', () => {
  assert.equal(parseConnection(connection(), { now: NOW }).tripId, UUID);
  for (const change of [{ token: 'account-session' }, { expiresAt: NOW }, { expiresAt: NOW + 7200_001 },
    { origin: 'https://evil.example' }, { origin: `${PRODUCTION_ORIGIN}/api` }, { origin: `${PRODUCTION_ORIGIN}?x=1` },
    { origin: 'https://user:password@safety-guard-api-production.2012044zj.workers.dev' }, { accountSession: 'secret' }]) {
    assert.throws(() => parseConnection({ ...connection(), ...change }, { now: NOW }), /STILLHERE_/);
  }
  const local = { ...connection(), origin: 'http://127.0.0.1:8787' };
  assert.throws(() => parseConnection(local, { now: NOW }), /UNTRUSTED/);
  assert.equal(parseConnection(local, { now: NOW, allowLoopback: true }).origin, local.origin);
});
test('connection files use a bounded regular-file reader', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stillhere-client-test-'));
  try {
    const file = path.join(directory, 'connection.json');
    await writeFile(file, JSON.stringify(connection()));
    assert.deepEqual(await readBoundedJson(file, 4096), connection());
    await assert.rejects(readBoundedJson(file, 20), /INVALID_INPUT_FILE/);
    await assert.rejects(readBoundedJson(directory, 4096), /INVALID_INPUT_FILE/);
    await writeFile(file, '{bad');
    await assert.rejects(readBoundedJson(file, 4096), /INVALID_JSON/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('CLI requires processing consent and rejects duplicate flags, arbitrary tools and unsafe limits', () => {
  const base = ['watch', '--connection', 'local.json', '--allow-processing'];
  assert.equal(parsePersonalAgentArguments(base).maxTurns, 12);
  assert.equal(parsePersonalAgentArguments(base).maxMinutes, 20);
  for (const args of [['watch', '--connection', 'x'], ['run-shell', '--connection', 'x', '--allow-processing'],
    [...base, '--max-turns', '61'], [...base, '--max-minutes', '121'], [...base, '--max-minutes', '0'],
    [...base, '--allow-processing'], [...base, '--input', 'anything'], ['assess', '--connection', 'x', '--allow-processing']]) {
    assert.throws(() => parsePersonalAgentArguments(args), /STILLHERE_/);
  }
});
test('hosted validator cannot run without explicit synthetic and actual-model flags', () => {
  assert.deepEqual(parseHostedValidationArguments(['--check']), { check: true, retain: false });
  assert.deepEqual(parseHostedValidationArguments(['--run', '--confirm-synthetic', '--allow-model-call', '--retain-accounts']), { check: false, retain: true });
  for (const args of [[], ['--run'], ['--run', '--confirm-synthetic'], ['--allow-model-call'], ['--check', '--run'], ['--run', '--confirm-synthetic', '--allow-model-call', '--allow-model-call']]) {
    assert.throws(() => parseHostedValidationArguments(args), /EXPLICIT_HOSTED_MODEL_VALIDATION_FLAGS_REQUIRED/);
  }
});
test('HTTP client sends capability only in headers, forbids redirects, and rejects credential arguments', async () => {
  let called = 0;
  const client = new PersonalAgentClient(connection(), { processingApproved: true, now: () => NOW,
    fetch: async (url, init) => {
      called++;
      assert.equal(String(url), `${PRODUCTION_ORIGIN}/api/agent/trips/${UUID}/delegations/${UUID}/status`);
      assert.equal(init?.redirect, 'error');
      assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${TOKEN}`);
      assert.equal(init?.body, '{}');
      return jsonResponse(response());
    },
  });
  assert.equal((await client.call('status')).job?.id, UUID);
  assert.ok(!JSON.stringify(client).includes(TOKEN));
  await assert.rejects(client.call('status', { token: 'injection' }), /INVALID_TOOL_ARGUMENTS/);
  await assert.rejects(client.call('wallet' as PersonalAgentOperation), /INVALID_OPERATION/);
  assert.equal(called, 1);
  assert.throws(() => new PersonalAgentClient(connection(), { processingApproved: false }), /PROCESSING_CONSENT/);
});
test('HTTP client rejects excess output, wrong types, wrong authority and extended jobs', async () => {
  for (const body of [{ ...response(), token: TOKEN }, { ...response(), delegation: { ...response().delegation, id: SECOND } },
    { ...response(), job: { ...job(), expiresAt: NOW + 90_001 } }, { ...response(), job: { ...job(), context: { ...job().context, now: NOW + 1 } } }]) {
    const client = new PersonalAgentClient(connection(), { processingApproved: true, now: () => NOW, fetch: async () => jsonResponse(body) });
    await assert.rejects(client.call('updates'), /INVALID_RESPONSE|INVALID_JOB/);
  }
  for (const result of [new Response('x', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(MAX_RESPONSE_BYTES + 1), { headers: { 'content-type': 'application/json' } }),
    jsonResponse({}, { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } })]) {
    const client = new PersonalAgentClient(connection(), { processingApproved: true, now: () => NOW, fetch: async () => result });
    await assert.rejects(client.call('status'), /INVALID_RESPONSE|RESPONSE_TOO_LARGE/);
  }
});
test('transport errors contain no body, URL, credential or network diagnostic', async () => {
  for (const status of [401, 403, 409, 410, 429, 500]) {
    const client = new PersonalAgentClient(connection(), { processingApproved: true, now: () => NOW,
      fetch: async () => jsonResponse({ error: `${TOKEN} private rider text` }, { status }) });
    await assert.rejects(client.call('status'), error => {
      assert.ok(error instanceof PersonalAgentError);
      assert.equal(error.message, `STILLHERE_HTTP_${status}`);
      assert.equal(error.retryable, status >= 500); return true;
    });
  }
  const client = new PersonalAgentClient(connection(), { processingApproved: true, now: () => NOW,
    fetch: async () => { throw new Error(`URL contains ${TOKEN}`); } });
  await assert.rejects(client.call('status'), /STILLHERE_TRANSPORT_UNCERTAIN/);
});
test('loopback HTTP exercises real fetch and does not follow an authenticated redirect', async () => {
  const calls: string[] = [];
  const server = createServer((request, reply) => {
    calls.push(request.url!);
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (request.url?.endsWith('/status')) { reply.writeHead(302, { location: '/redirected' }); reply.end(); }
    else { reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(response())); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const client = new PersonalAgentClient({ ...connection(), origin: `http://127.0.0.1:${address.port}` }, { processingApproved: true, allowLoopback: true, now: () => NOW });
    assert.equal((await client.call('updates')).job?.id, UUID);
    await assert.rejects(client.call('status'), /TRANSPORT_UNCERTAIN/);
    assert.equal(calls.length, 2);
    assert.ok(!calls.includes('/redirected'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test('watch completes an assessment once, requires its receipt and releases at turn limit', async () => {
  const fake = mockTransport(operation => operation === 'assess' ? receiptResponse() : response());
  let inferences = 0;
  const events: unknown[] = [];
  const result = await watchPersonalAgent(fake.client, { maxTurns: 1 }, { now: () => NOW,
    assess: async () => { inferences++; return assessment; }, onEvent: event => events.push(event) });
  assert.deepEqual(result, { turns: 1, reason: 'limit_reached' });
  assert.equal(inferences, 1);
  assert.deepEqual(fake.calls.map(call => call.operation), ['accept', 'updates', 'assess', 'release']);
  assert.deepEqual(fake.calls.at(-1)?.body, { reason: 'limit_reached' });
  assert.deepEqual(events, [{ kind: 'connected', turns: 0 }, { kind: 'completed', turns: 1 }, { kind: 'stopped', turns: 1 }]);
});
test('uncertain submission retries the identical object and never calls inference again', async () => {
  let attempts = 0;
  let inferences = 0;
  const fake = mockTransport(operation => {
    if (operation === 'assess') { attempts++; if (attempts < 3) throw new PersonalAgentError('STILLHERE_TRANSPORT_UNCERTAIN', true); return receiptResponse(); }
    return response();
  });
  await watchPersonalAgent(fake.client, { maxTurns: 1 }, { now: () => NOW, sleep: async () => {}, assess: async () => { inferences++; return assessment; } });
  const submissions = fake.calls.filter(call => call.operation === 'assess');
  assert.equal(submissions.length, 3); assert.equal(inferences, 1);
  assert.equal(submissions[0].body, submissions[1].body); assert.equal(submissions[1].body, submissions[2].body);
});
test('ambiguous exhausted submission stops and releases without another model turn', async () => {
  const fake = mockTransport(operation => { if (operation === 'assess') throw new PersonalAgentError('STILLHERE_TRANSPORT_UNCERTAIN', true); return response(); });
  let inferences = 0;
  await assert.rejects(watchPersonalAgent(fake.client, {}, { now: () => NOW, sleep: async () => {}, assess: async () => { inferences++; return assessment; } }), /TRANSPORT_UNCERTAIN/);
  assert.equal(inferences, 1); assert.equal(fake.calls.filter(call => call.operation === 'assess').length, 3);
  assert.equal(fake.calls.at(-1)?.operation, 'release');
});
test('revocation and stale submissions never retry', async () => {
  for (const status of [401, 403, 409, 410, 429]) {
    const fake = mockTransport(operation => { if (operation === 'assess') throw new PersonalAgentError(`STILLHERE_HTTP_${status}`, false, status); return response(); });
    await assert.rejects(submitAssessment(fake.client, job(), assessment, new AbortController().signal, async () => {}, () => NOW), new RegExp(`HTTP_${status}`));
    assert.equal(fake.calls.length, 1);
  }
});
test('a superseded job is discarded before submission', async () => {
  const fake = mockTransport(operation => operation === 'updates' ? response({ ...job(), id: SECOND }) : response());
  const result = await watchPersonalAgent(fake.client, { maxTurns: 1 }, { now: () => NOW, assess: async () => assessment });
  assert.equal(result.turns, 1);
  assert.ok(!fake.calls.some(call => call.operation === 'assess'));
});
test('job expiry and hard watch deadline prevent delayed model actions', async () => {
  let current = NOW;
  const fake = mockTransport(() => response());
  const result = await watchPersonalAgent(fake.client, { maxMinutes: 1 }, { now: () => current,
    assess: async () => { current = NOW + 60_001; return assessment; } });
  assert.equal(result.reason, 'limit_reached');
  assert.ok(!fake.calls.some(call => call.operation === 'assess'));
});
test('model failure releases and does not perform fallback inference or action', async () => {
  const fake = mockTransport(() => response());
  await assert.rejects(watchPersonalAgent(fake.client, {}, { now: () => NOW, assess: async () => { throw new Error('quota'); } }), /quota/);
  assert.deepEqual(fake.calls.at(-1), { operation: 'release', body: { reason: 'model_unavailable' } });
  assert.equal(fake.calls.filter(call => call.operation === 'assess').length, 0);
});
test('heartbeats run during inference, and revocation aborts the model', async () => {
  const fake = mockTransport(operation => { if (operation === 'heartbeat') throw new PersonalAgentError('STILLHERE_HTTP_403', false, 403); return response(); });
  let aborted = false;
  await assert.rejects(watchPersonalAgent(fake.client, {}, { now: () => NOW, heartbeatMs: 5,
    assess: async (_job, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })),
  }), /HTTP_403/);
  assert.ok(aborted); assert.ok(fake.calls.some(call => call.operation === 'heartbeat'));
  assert.ok(!fake.calls.some(call => call.operation === 'assess'));
});
test('transport-only heartbeats with no job do not cancel healthy inference', async () => {
  const fake = mockTransport(operation => operation === 'heartbeat' ? response(null) : operation === 'assess' ? receiptResponse() : response());
  await watchPersonalAgent(fake.client, { maxTurns: 1 }, { now: () => NOW, heartbeatMs: 2,
    assess: async (_job, signal) => { await new Promise(resolve => setTimeout(resolve, 12)); assert.equal(signal.aborted, false); return assessment; },
  });
  assert.ok(fake.calls.some(call => call.operation === 'heartbeat'));
  assert.equal(fake.calls.filter(call => call.operation === 'assess').length, 1);
});
test('new updates abort obsolete inference and prevent stale submission', async () => {
  const fake = mockTransport(operation => operation === 'updates' ? response({ ...job(), id: SECOND }) : response());
  let aborted = false;
  const result = await watchPersonalAgent(fake.client, { maxTurns: 1 }, { now: () => NOW, pollMs: 2,
    assess: async (_job, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('stale')); }, { once: true })),
  });
  assert.ok(aborted); assert.equal(result.turns, 1);
  assert.ok(!fake.calls.some(call => call.operation === 'assess'));
});
test('signal shutdown aborts inference and releases with stopped', async () => {
  const controller = new AbortController();
  const fake = mockTransport(() => response());
  const result = await watchPersonalAgent(fake.client, { signal: controller.signal }, { now: () => NOW,
    assess: async (_job, signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); controller.abort(); }),
  });
  assert.equal(result.reason, 'stopped');
  assert.deepEqual(fake.calls.at(-1)?.body, { reason: 'stopped' });
});
test('MCP requires initialize/initialized, negotiates supported version, and exposes exactly six bounded tools', async () => {
  const fake = mockTransport(() => response());
  const server = new PersonalAgentMcp(fake.client);
  const request = (id: number, method: string, params = {}) => server.handle({ jsonrpc: '2.0', id, method, params });
  assert.match(JSON.stringify(await request(1, 'tools/list')), /Initialization required/);
  const initialized = await request(2, 'initialize', { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(JSON.stringify(initialized), /2025-11-25/);
  assert.match(JSON.stringify(await request(3, 'tools/list')), /Initialization required/);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const tools = await request(4, 'tools/list');
  assert.match(JSON.stringify(tools), /stillhere_assess/); assert.equal(MCP_TOOLS.length, 6);
  assert.ok(!JSON.stringify(tools).includes(TOKEN));
  assert.match(JSON.stringify(await request(5, 'initialize')), /Already initialized/);
  assert.equal(fake.calls.length, 0);
});
async function initialize(server: PersonalAgentMcp) {
  await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
test('MCP does not accept tokens, destinations, arbitrary methods or tool names', async () => {
  const fake = mockTransport(() => response());
  const server = new PersonalAgentMcp(fake.client);
  await initialize(server);
  for (const params of [{ name: 'stillhere_status', arguments: { token: TOKEN } }, { name: 'stillhere_status', arguments: { url: 'https://evil.test' } }, { name: 'shell', arguments: {} }]) {
    assert.match(JSON.stringify(await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params })), /isError|Unknown tool/);
  }
  assert.equal(fake.calls.length, 0);
  assert.match(JSON.stringify(await server.handle({ jsonrpc: '2.0', id: 3, method: 'sampling/createMessage' })), /Method not found/);
});
test('standard MCP metadata is accepted and discarded for initialize, notifications, listing, ping and tool calls', async () => {
  const fake = mockTransport(() => response());
  const server = new PersonalAgentMcp(fake.client);
  const meta = { progressToken: 'opaque-progress-id', 'com.example/context': { token: 'ignored-dummy-value', url: 'https://never-contact.example' } };
  const initialized = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'compatible-client', version: '1', title: 'Optional display title' }, _meta: meta,
  } });
  assert.match(JSON.stringify(initialized), /2025-11-25/);
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized', params: { _meta: { 'com.example/ready': true } } });
  for (const method of ['tools/list', 'ping']) {
    const result = await server.handle({ jsonrpc: '2.0', id: 2, method, params: { _meta: { progressToken: 42 } } });
    assert.ok(!JSON.stringify(result).includes('error'));
  }
  const result = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stillhere_status', arguments: {}, _meta: meta } });
  assert.match(JSON.stringify(result), /"isError":false/);
  assert.deepEqual(fake.calls, [{ operation: 'status', body: {} }]);
  for (const text of ['opaque-progress-id', 'ignored-dummy-value', 'never-contact.example']) assert.ok(!JSON.stringify(result).includes(text));
});
test('invalid or oversized MCP metadata never reaches a tool while metadata inside arguments remains forbidden', async () => {
  const fake = mockTransport(() => response()); const server = new PersonalAgentMcp(fake.client); await initialize(server);
  for (const meta of [null, [], 'bad', { progressToken: {} }, { progressToken: 1.5 }, { extra: 'x'.repeat(MCP_MAX_METADATA_BYTES) }]) {
    const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stillhere_status', arguments: {}, _meta: meta } });
    assert.match(JSON.stringify(result), /Invalid metadata/);
  }
  const misplaced = await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stillhere_status', arguments: { _meta: { progressToken: 1 } } } });
  assert.match(JSON.stringify(misplaced), /INVALID_TOOL_ARGUMENTS/); assert.equal(fake.calls.length, 0);
});
test('MCP returns a real receipt, hides server errors and releases on EOF after accepting', async () => {
  const fake = mockTransport(operation => { if (operation === 'heartbeat') throw new PersonalAgentError('STILLHERE_HTTP_403'); return operation === 'assess' ? receiptResponse() : response(); });
  const server = new PersonalAgentMcp(fake.client);
  await initialize(server);
  const call = (name: string, args: unknown = {}) => server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  await call('stillhere_accept');
  assert.match(JSON.stringify(await call('stillhere_assess', { jobId: UUID, assessment })), /Stored in journey chat/);
  assert.match(JSON.stringify(await call('stillhere_heartbeat')), /STILLHERE_HTTP_403/);
  await server.close(); await server.close();
  assert.equal(fake.calls.filter(call => call.operation === 'release').length, 1);
});
test('MCP releases even when acceptance succeeded remotely but its response was lost', async () => {
  const fake = mockTransport(operation => { if (operation === 'accept') throw new PersonalAgentError('STILLHERE_TRANSPORT_UNCERTAIN', true); return response(); });
  const server = new PersonalAgentMcp(fake.client);
  await initialize(server);
  const result = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stillhere_accept', arguments: {} } });
  assert.match(JSON.stringify(result), /TRANSPORT_UNCERTAIN/);
  await server.close();
  assert.equal(fake.calls.at(-1)?.operation, 'release');
});
test('STDIO emits only JSON-RPC lines, handles parse errors, and rejects oversized or unterminated frames', async () => {
  const fake = mockTransport(() => response());
  const input = new PassThrough(); const output = new PassThrough(); let text = '';
  output.on('data', chunk => { text += chunk.toString(); });
  const running = serveMcp(fake.client, input, output);
  input.end('bad\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  await running;
  const lines = text.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(lines.length, 2); assert.equal(lines[0].error.code, -32700); assert.deepEqual(lines[1].result, {});
  for (const body of ['x'.repeat(MCP_MAX_LINE_BYTES + 1), '{"jsonrpc":"2.0"}']) {
    const incoming = new PassThrough(); const outgoing = new PassThrough();
    const run = serveMcp(fake.client, incoming, outgoing); incoming.end(body);
    await assert.rejects(run, /MCP_INPUT_TOO_LARGE|MCP_UNTERMINATED_MESSAGE/);
  }
});
test('actual MCP CLI process speaks STDIO to a mock HTTP server and releases on clean EOF without invoking Codex', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stillhere-mcp-process-test-'));
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const current = Date.now();
  const shift = (value: unknown): unknown => typeof value === 'number' && value >= NOW ? value - NOW + current
    : Array.isArray(value) ? value.map(shift) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, shift(entry)])) : value;
  const operations: string[] = [];
  const server = createServer((request, reply) => {
    operations.push(request.url!.split('/').at(-1)!);
    reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(shift(response())));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const file = path.join(directory, 'connection.json');
    const port = (server.address() as { port: number }).port;
    await writeFile(file, JSON.stringify(shift({ ...connection(), origin: `http://127.0.0.1:${port}` })), { mode: 0o600 });
    const child = nodeSpawn(process.execPath, [path.join(root, 'chain/node_modules/tsx/dist/cli.mjs'), path.join(root, 'scripts/personal-agent.ts'),
      'mcp', '--connection', file, '--allow-processing', '--allow-loopback'], { cwd: root, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'stillhere_accept', arguments: {} } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
    const code = await new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
    clearTimeout(timeout);
    assert.equal(code, 0, stderr); assert.equal(stderr, '');
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(messages.length, 3); assert.equal(messages[1].result.tools.length, 6); assert.equal(messages[2].result.isError, false);
    assert.ok(!stdout.includes(TOKEN)); assert.deepEqual(operations, ['accept', 'release']);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
test('official MCP SDK initializes and invokes the handwritten STDIO bridge with standard metadata', async context => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let Client, StdioClientTransport;
  try {
    ({ Client } = await import(pathToFileURL(path.join(root, 'web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href));
    ({ StdioClientTransport } = await import(pathToFileURL(path.join(root, 'web/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js')).href));
  } catch { context.skip('Optional installed MCP SDK is unavailable.'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'stillhere-mcp-sdk-test-'));
  const current = Date.now(); const liveConnection = { ...connection(), expiresAt: current + 1200_000 };
  const liveResponse = response(null); liveResponse.delegation.expiresAt = liveConnection.expiresAt;
  const bodies: unknown[] = [];
  const server = createServer((request, reply) => {
    let body = ''; request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => { bodies.push(JSON.parse(body)); reply.writeHead(200, { 'content-type': 'application/json' }); reply.end(JSON.stringify(liveResponse)); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let client;
  try {
    const file = path.join(directory, 'connection.json');
    await writeFile(file, JSON.stringify({ ...liveConnection, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'chain/node_modules/tsx/dist/cli.mjs'),
      path.join(root, 'scripts/personal-agent.ts'), 'mcp', '--connection', file, '--allow-processing', '--allow-loopback'], stderr: 'pipe' });
    let diagnostic = ''; transport.stderr?.on('data', (chunk: Buffer) => { diagnostic += chunk.toString(); });
    client = new Client({ name: 'stillhere-offline-sdk-test', version: '1.0.0' });
    await client.connect(transport, { timeout: 5000 });
    const tools = await client.listTools({ _meta: { progressToken: 'sdk-list' } });
    assert.equal(tools.tools.length, 6);
    const result = await client.callTool({ name: 'stillhere_status', arguments: {}, _meta: { progressToken: 'sdk-call', 'com.example/context': { url: 'https://ignored.example' } } });
    assert.equal(result.isError, false); assert.deepEqual(bodies, [{}]); assert.equal(diagnostic, '');
  } finally { await client?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill() { queueMicrotask(() => this.emit('close', null)); return true; }
}
test('an external abort terminates an in-flight Codex subprocess before using its output', async () => {
  const controller = new AbortController(); let killed = false;
  const spawn: SpawnProcess = () => {
    const child = new FakeChild();
    child.kill = () => { killed = true; queueMicrotask(() => child.emit('close', null)); return true; };
    queueMicrotask(() => controller.abort());
    return child as unknown as ReturnType<SpawnProcess>;
  };
  await assert.rejects(runProcess({ installation: { executable: 'fake', version: VERIFIED_CODEX_VERSION }, args: [], cwd: '.', environment: {}, spawn,
    timeoutMs: 1000, signal: controller.signal }), /CODEX_DEMO_ABORTED/);
  assert.ok(killed);
});
test('memory-only Codex assessment uses eligible guardian context, no credential env, and only a schema file', async () => {
  const seen: string[] = [];
  const spawn: SpawnProcess = (_command, args, options) => {
    const child = new FakeChild(); let prompt = '';
    child.stdin.on('data', chunk => { prompt += chunk.toString(); });
    queueMicrotask(async () => {
      if (args.includes('exec')) {
        assert.equal(options.env.STILLHERE_TOKEN, undefined); assert.equal(options.env.OPENAI_API_KEY, undefined);
        assert.ok(!prompt.includes(TOKEN)); assert.ok(prompt.includes('Guardian claims')); assert.ok(!prompt.includes(UUID));
        assert.deepEqual(await readdir(options.cwd), ['assessment.schema.json']); seen.push(prompt);
        for (const event of [{ type: 'turn.started' }, { type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: JSON.stringify(assessment) } },
          { type: 'turn.completed', usage: { input_tokens: 50, output_tokens: 20, cached_input_tokens: 0 } }]) child.stdout.write(`${JSON.stringify(event)}\n`);
      } else if (args.includes('--version')) child.stdout.write(`codex-cli ${VERIFIED_CODEX_VERSION}`);
      else if (args.includes('login')) child.stderr.write('Logged in using ChatGPT');
      else if (args.includes('features')) child.stdout.write(`${DISABLED_FEATURES.map(name => `${name} stable false`).join('\n')}\nskip_host_skill_discovery stable true`);
      else if (args.includes('mcp')) child.stdout.write('[]');
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<SpawnProcess>;
  };
  const context = job().context;
  context.messages.push({ id: 'guardian-1', at: NOW, role: 'guardian', text: 'Guardian claims they will rest.' });
  const result = await assessInMemory({ context, expiresAt: NOW + 90_000, processingApproved: true }, { spawn,
    installation: { executable: 'fake-codex', version: VERIFIED_CODEX_VERSION }, now: () => NOW,
    environment: { PATH: 'safe', STILLHERE_TOKEN: TOKEN, OPENAI_API_KEY: 'not-forwarded' } });
  assert.deepEqual(result.assessment, assessment); assert.equal(seen.length, 1);
  await assert.rejects(assessInMemory({ context, expiresAt: NOW + 90_000, processingApproved: false }), /CONSENT_REQUIRED/);
});
