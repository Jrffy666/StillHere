import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn as nativeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  buildExecArgs, buildPrompt, checkCodexDemo, classifyProcessFailure, configurationArgs, createEventCollector,
  CodexDemoError, DISABLED_CODE_MODE_DIAGNOSTIC, DISABLED_FEATURES, findCodexInstallation, MAX_STDOUT_BYTES, parseArguments, runCodexDemo, runProcess, runWithCleanup,
  scrubEnvironment, validateRequest, VERIFIED_CODEX_VERSION, verifyFeatureOutput,
  type SpawnProcess,
} from './codex-demo';
import { SEMANTIC_TOOL_PARAMETERS } from '../worker/src/agent-semantic';

const NOW = 1_900_000_000_000;
const request = () => ({
  version: 1, kind: 'safety-guard-codex-request', jobId: '00000000-0000-4000-8000-000000000001',
  createdAt: NOW, expiresAt: NOW + 300_000,
  context: {
    now: NOW, status: 'active', guardMode: 'ai', risk: 'normal',
    location: { updatedAt: NOW, ageSeconds: 0, stale: false },
    messages: [{ id: 'demo-rider', at: NOW, role: 'rider', text: 'I am on my way home.' }],
    relayOpen: false, notifications: [], contactAvailable: false, unresolvedConcerns: [],
  },
});
const assessment = {
  findings: [], question: { kind: 'companionship', sourceIds: ['message:demo-rider'] },
  requestRelay: false, followUpSeconds: 60,
};
const installation = { executable: '/fake/npm/codex', version: VERIFIED_CODEX_VERSION };
const featureOutput = () => `${DISABLED_FEATURES.map(name => `${name} stable false`).join('\n')}\nskip_host_skill_discovery under development true\n`;
const eventLines = (value: unknown = assessment, usage: unknown = { input_tokens: 110, output_tokens: 30, cached_input_tokens: 20 }) => [
  { type: 'thread.started', thread_id: 'local-test' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed', usage },
].map(event => JSON.stringify(event)).join('\n') + '\n';

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;
  autoCloseOnKill = true;
  input = '';
  constructor() { super(); this.stdin.on('data', chunk => { this.input += chunk.toString('utf8'); }); }
  kill() { this.killed = true; if (this.autoCloseOnKill) queueMicrotask(() => this.emit('close', null)); return true; }
}

function fakeSpawn(options: { output?: string; auth?: string; features?: string; mcp?: string; inheritedMcp?: boolean; onExec?: (child: FakeChild) => void } = {}) {
  const calls: { args: string[]; options: Parameters<SpawnProcess>[2]; child: FakeChild }[] = [];
  const spawn: SpawnProcess = (_command, args, processOptions) => {
    const child = new FakeChild();
    calls.push({ args, options: processOptions, child });
    queueMicrotask(() => {
      if (args.includes('exec')) {
        if (options.onExec) { options.onExec(child); return; }
        child.stdout.write(options.output ?? eventLines());
      } else if (args.includes('--version')) child.stdout.write(`codex-cli ${VERIFIED_CODEX_VERSION}\n`);
      else if (args.includes('login')) child.stderr.write(options.auth ?? 'Logged in using ChatGPT\n');
      else if (args.includes('features')) child.stdout.write(options.features ?? featureOutput());
      else if (args.includes('mcp')) child.stdout.write(options.inheritedMcp
        ? JSON.stringify([{ name: 'inherited_mcp', enabled: !args.includes('mcp_servers.inherited_mcp.enabled=false') }])
        : options.mcp ?? '[]');
      else throw new Error('Unexpected subprocess');
      child.emit('close', 0);
    });
    return child as unknown as ReturnType<SpawnProcess>;
  };
  return { spawn, calls };
}

async function withFiles(callback: (files: { directory: string; inputPath: string; outputPath: string }) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'safety-guard-codex-test-'));
  const files = { directory, inputPath: path.join(directory, 'input.json'), outputPath: path.join(directory, 'result.json') };
  try { await writeFile(files.inputPath, JSON.stringify(request())); await callback(files); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('CLI arguments require explicit synthetic confirmation and reject duplicate or unknown flags', () => {
  assert.deepEqual(parseArguments(['--check']), { check: true });
  assert.deepEqual(parseArguments(['--input', 'a.json', '--output', 'b.json', '--confirm-synthetic']), {
    check: false, inputPath: 'a.json', outputPath: 'b.json', confirmSynthetic: true,
  });
  for (const args of [[], ['--check', '--input', 'a'], ['--input', 'a', '--input', 'b'], ['--input', 'a', '--output', '--confirm-synthetic']]) {
    assert.throws(() => parseArguments(args), /CODEX_DEMO_INVALID_ARGUMENTS/);
  }
});

test('environment keeps auth location but removes keys, tokens, injection flags and endpoint overrides', () => {
  const clean = scrubEnvironment({ PATH: 'safe', USERPROFILE: 'profile', CODEX_HOME: 'same-auth-location',
    OPENAI_API_KEY: 'dummy', CODEX_API_KEY: 'dummy', OPENAI_BASE_URL: 'bad', NODE_OPTIONS: '--require bad',
    CODEX_ACCESS_TOKEN: 'dummy', AWS_SECRET_ACCESS_KEY: 'dummy', SHELL: 'bad' });
  assert.deepEqual(clean, { PATH: 'safe', USERPROFILE: 'profile', CODEX_HOME: 'same-auth-location' });
});

test('exec arguments use stdin and explicit capability restrictions without embedding rider text', () => {
  const args = buildExecArgs('C:/private/schema.json');
  for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--json']) assert.ok(args.includes(flag));
  assert.equal(args.at(-1), '-');
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('mcp_servers={}'));
  assert.ok(args.includes('features.shell_tool=false'));
  assert.ok(!args.some(arg => /danger-full|approve-for-me|--search/.test(arg)));
  assert.ok(configurationArgs().includes('features.hooks=false'));
});

test('request rejects stale, future, non-rider, notification, inactive and extra-field data', () => {
  const initial = request();
  assert.equal(validateRequest(initial, NOW).jobId, initial.jobId);
  assert.throws(() => validateRequest(initial, initial.expiresAt), /EXPIRED/);
  assert.throws(() => validateRequest(initial, NOW - 1), /EXPIRED/);
  assert.throws(() => validateRequest({ ...initial, key: 'not allowed' }, NOW), /INVALID_EXPORT/);
  assert.throws(() => validateRequest({ ...initial, context: { ...initial.context, messages: [{ ...initial.context.messages[0], role: 'guardian' }] } }, NOW), /RIDER_ONLY/);
  assert.throws(() => validateRequest({ ...initial, context: { ...initial.context, status: 'arrived' } }, NOW), /INACTIVE/);
});

test('prompt includes only the snapshot, no job metadata, and bounds UTF-8 bytes', () => {
  const parsed = validateRequest(request(), NOW);
  const prompt = buildPrompt(parsed);
  assert.ok(prompt.includes('untrusted data'));
  assert.ok(!prompt.includes(parsed.jobId));
  assert.ok(!prompt.includes('safety-guard-codex-request'));
  assert.throws(() => buildPrompt({ ...parsed, context: { ...parsed.context, messages: [{ ...parsed.context.messages[0], text: '汉'.repeat(12_000) }] } }), /INPUT_TOO_LARGE/);
});

test('feature verification fails for missing or enabled required capabilities', () => {
  verifyFeatureOutput(featureOutput());
  verifyFeatureOutput(featureOutput().replace('unified_exec stable false', 'unified_exec stable true'));
  assert.throws(() => verifyFeatureOutput(featureOutput().replace('shell_tool stable false', 'shell_tool stable true')), /CAPABILITIES_UNVERIFIED/);
  assert.throws(() => verifyFeatureOutput(''), /CAPABILITIES_UNVERIFIED/);
});

test('preflight disables inherited MCP entries but exec excludes their user configuration entirely', async () => {
  await withFiles(async files => {
    const fake = fakeSpawn({ inheritedMcp: true });
    await runCodexDemo({ ...files, confirmSynthetic: true }, { spawn: fake.spawn, installation, now: () => NOW });
    assert.equal(fake.calls.filter(call => call.args.includes('mcp')).length, 2);
    assert.ok(fake.calls.find(call => call.args.includes('mcp_servers.inherited_mcp.enabled=false')));
    assert.ok(fake.calls.at(-1)!.args.includes('--ignore-user-config'));
    assert.ok(!fake.calls.at(-1)!.args.some(arg => arg.startsWith('mcp_servers.')));
  });
});

test('events extract schema JSON and usage without exposing arbitrary text', () => {
  const collector = createEventCollector();
  for (const line of eventLines().trim().split('\n')) collector.onLine(line);
  assert.deepEqual(collector.finish(), { assessment, usage: { inputTokens: 110, outputTokens: 30, cachedInputTokens: 20 } });
});

test('only the exact disabled-host startup notice is accepted, once, before the turn', () => {
  const notice = { type: 'item.completed', item: { id: 'startup', type: 'error', message: DISABLED_CODE_MODE_DIAGNOSTIC } };
  const collector = createEventCollector();
  collector.onLine(JSON.stringify(notice));
  assert.throws(() => collector.onLine(JSON.stringify(notice)), /CODEX_DEMO_MODEL_FAILED/);
  const duringTurn = createEventCollector();
  duringTurn.onLine('{"type":"turn.started"}');
  assert.throws(() => duringTurn.onLine(JSON.stringify(notice)), /CODEX_DEMO_MODEL_FAILED/);
  for (const changed of [
    { ...notice, item: { ...notice.item, message: `${DISABLED_CODE_MODE_DIAGNOSTIC} extra instructions` } },
    { ...notice, item: { ...notice.item, extra: 'not accepted' } },
    { ...notice, extra: 'not accepted' },
  ]) assert.throws(() => createEventCollector().onLine(JSON.stringify(changed)), /CODEX_DEMO_MODEL_FAILED/);
});

test('unknown event failures retain bounded shape metadata but no message text or identifiers', () => {
  const collector = createEventCollector();
  assert.throws(() => collector.onLine(JSON.stringify({ type: 'unexpected.lifecycle', message: 'private rider text',
    thread_id: 'private identifier', item: { id: 'private item', type: 'unknown', text: 'private content' } })), error => {
    const metadata = (error as CodexDemoError).eventMetadata;
    assert.equal(metadata?.type, 'unexpected.lifecycle');
    assert.deepEqual(metadata?.fields, ['type', 'message', 'thread_id', 'item']);
    assert.equal(metadata?.phase, 'before_turn');
    assert.ok(!JSON.stringify(error).includes('private'));
    return true;
  });
});

test('tool events, malformed JSON, missing results and invalid usage fail closed', () => {
  for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'unknown']) {
    const collector = createEventCollector();
    collector.onLine('{"type":"turn.started"}');
    assert.throws(() => collector.onLine(JSON.stringify({ type: 'item.started', item: { type } })), /TOOL_ACTIVITY_REJECTED/);
  }
  assert.throws(() => createEventCollector().onLine('invalid secret text'), /^CodexDemoError: CODEX_DEMO_INVALID_EVENT$/);
  assert.throws(() => createEventCollector().finish(), /MISSING_RESULT/);
  const collector = createEventCollector();
  assert.throws(() => eventLines(assessment, { input_tokens: 1, output_tokens: -1, cached_input_tokens: 0 }).trim().split('\n').forEach(collector.onLine), /INVALID_USAGE/);
});

test('preflight makes no exec/model invocation and rejects non-ChatGPT authentication or configured MCP', async () => {
  const fake = fakeSpawn();
  await checkCodexDemo({ spawn: fake.spawn, installation });
  assert.equal(fake.calls.length, 4);
  assert.ok(fake.calls.every(call => !call.args.includes('exec')));
  await assert.rejects(checkCodexDemo({ spawn: fakeSpawn({ auth: 'Logged in using an API key\n' }).spawn, installation }), /CHATGPT_LOGIN_REQUIRED/);
  await assert.rejects(checkCodexDemo({ spawn: fakeSpawn({ mcp: '[{"name":"unexpected"}]' }).spawn, installation }), /MCP_UNVERIFIED/);
});

test('one-shot runner writes a validated result, isolates cwd, scrubs env, and never invokes a shell', async () => {
  await withFiles(async files => {
    const fake = fakeSpawn();
    const result = await runCodexDemo({ ...files, confirmSynthetic: true }, { spawn: fake.spawn, installation, now: () => NOW + 1,
      environment: { PATH: 'ok', OPENAI_API_KEY: 'dummy', CODEX_API_KEY: 'dummy', NODE_OPTIONS: 'bad' } });
    assert.equal(result.kind, 'safety-guard-codex-result');
    assert.deepEqual(JSON.parse(await readFile(files.outputPath, 'utf8')), result);
    assert.equal(fake.calls.filter(call => call.args.includes('exec')).length, 1);
    for (const call of fake.calls) {
      assert.equal(call.options.shell, false);
      assert.equal(call.options.windowsHide, true);
      assert.ok(!call.options.cwd.includes('safety-guard/scripts'));
      assert.deepEqual(call.options.env, { PATH: 'ok' });
      assert.ok(!call.args.some(arg => arg.includes('I am on my way home')));
    }
    assert.ok(fake.calls.at(-1)!.child.input.includes('I am on my way home'));
    await assert.rejects(readFile(path.join(fake.calls[0].options.cwd, 'assessment.schema.json')), { code: 'ENOENT' });
  });
});

test('confirmation, input bounds and existing output stop before process startup', async () => {
  await withFiles(async files => {
    const fake = fakeSpawn();
    await assert.rejects(runCodexDemo({ ...files, confirmSynthetic: false }, { spawn: fake.spawn, installation, now: () => NOW }), /SYNTHETIC_CONFIRMATION_REQUIRED/);
    await writeFile(files.outputPath, 'retain this');
    await assert.rejects(runCodexDemo({ ...files, confirmSynthetic: true }, { spawn: fake.spawn, installation, now: () => NOW }), /OUTPUT_EXISTS/);
    assert.equal(await readFile(files.outputPath, 'utf8'), 'retain this');
    await writeFile(files.inputPath, ' '.repeat(32_001));
    await assert.rejects(runCodexDemo({ ...files, confirmSynthetic: true }, { spawn: fake.spawn, installation, now: () => NOW }), /INPUT_TOO_LARGE/);
    assert.equal(fake.calls.length, 0);
  });
});

test('forged evidence, extra fields and expired completion never create an output', async () => {
  await withFiles(async files => {
    const invalid = { ...assessment, question: { kind: 'route_explanation', sourceIds: ['message:forged'] } };
    await assert.rejects(runCodexDemo({ ...files, confirmSynthetic: true }, {
      spawn: fakeSpawn({ output: eventLines(invalid) }).spawn, installation, now: () => NOW,
    }), /INVALID_ASSESSMENT/);
    let current = NOW;
    await assert.rejects(runCodexDemo({ ...files, confirmSynthetic: true }, {
      spawn: fakeSpawn({ onExec: child => { current = NOW + 300_000; child.stdout.write(eventLines()); child.emit('close', 0); } }).spawn,
      installation, now: () => current,
    }), /EXPORT_EXPIRED/);
    await assert.rejects(readFile(files.outputPath), { code: 'ENOENT' });
  });
});

test('timeout kills child and late output/error cannot produce a result or unhandled rejection', async () => {
  const child = new FakeChild();
  const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 5 });
  await assert.rejects(promise, /TIMEOUT/);
  assert.equal(child.killed, true);
  child.stdout.write(eventLines());
  child.emit('error', new Error('late sensitive error'));
  child.emit('close', 0);
});

test('oversized streams, corrupt UTF-8 and tool activity kill the process promptly', async () => {
  for (const input of [Buffer.alloc(MAX_STDOUT_BYTES + 1), Buffer.from([0xc3, 0x28])]) {
    const child = new FakeChild();
    const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
      spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000 });
    child.stdout.write(input);
    await assert.rejects(promise, /OUTPUT_TOO_LARGE|INVALID_OUTPUT/);
    assert.equal(child.killed, true);
  }
  const child = new FakeChild();
  const collector = createEventCollector();
  const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000, onLine: collector.onLine });
  child.stdout.write('{"type":"turn.started"}\n{"type":"item.started","item":{"type":"command_execution"}}\n');
  await assert.rejects(promise, /TOOL_ACTIVITY_REJECTED/);
  assert.equal(child.killed, true);
});

test('safe error categories never expose diagnostic text or dummy credentials', () => {
  const cases = [
    ['error: unexpected argument --bad', 'CLI_ARGUMENT_UNSUPPORTED'],
    ['Error loading config: data did not match any variant of untagged enum McpServerTransportConfig', 'CLI_CONFIGURATION_INVALID'],
    ['Authentication failed: token expired', 'AUTHENTICATION_FAILED'],
    ['model example is not supported', 'MODEL_UNAVAILABLE'],
    ['429 rate limit exceeded', 'RATE_OR_CREDIT_LIMIT'],
    ['error sending request: connection refused', 'NETWORK_FAILED'],
    ['unrecognized failure message', 'PROCESS_FAILED'],
  ];
  for (const [diagnostic, category] of cases) {
    const error = classifyProcessFailure(`${diagnostic}\nBearer dummy-do-not-echo; private text`, 1);
    assert.equal(error.message, `CODEX_DEMO_${category}`);
    assert.equal(error.exitCode, 1);
    assert.ok(!JSON.stringify(error).includes('dummy-do-not-echo'));
    assert.ok(!JSON.stringify(error).includes('private text'));
  }
});

test('early EPIPE preserves safe configuration classification until process close', async () => {
  const child = new FakeChild();
  const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000 });
  child.stdin.emit('error', Object.assign(new Error('private startup failure'), { code: 'EPIPE' }));
  child.stderr.write('Error loading config: missing field command; dummy-do-not-echo');
  child.emit('close', 1);
  await assert.rejects(promise, error => {
    assert.equal((error as Error).message, 'CODEX_DEMO_CLI_CONFIGURATION_INVALID');
    assert.equal((error as { exitCode: number }).exitCode, 1);
    return true;
  });
});

test('provider failure waits for Windows-style delayed close before directory cleanup', async () => {
  const child = new FakeChild();
  child.autoCloseOnKill = false;
  const collector = createEventCollector();
  let closed = false;
  let cleaned = false;
  const promise = runWithCleanup(() => runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000, onLine: collector.onLine }), async () => {
    assert.equal(closed, true);
    cleaned = true;
  });
  const rejected = assert.rejects(promise, /CODEX_DEMO_RATE_OR_CREDIT_LIMIT/);
  child.stdout.write('{"type":"error","error":{"code":"usage_limit_reached","message":"private diagnostic"}}\n');
  assert.equal(child.killed, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cleaned, false);
  closed = true;
  child.emit('close', 1);
  await rejected;
  assert.equal(cleaned, true);
});

test('a child that never closes has a bounded termination wait and preserves the original error', async () => {
  const child = new FakeChild();
  child.autoCloseOnKill = false;
  const collector = createEventCollector();
  const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000, closeTimeoutMs: 5, onLine: collector.onLine });
  child.stdout.write('{"type":"error","message":"Authentication token expired; private diagnostic"}\n');
  await assert.rejects(promise, error => {
    assert.equal((error as CodexDemoError).code, 'CODEX_DEMO_AUTHENTICATION_FAILED');
    assert.equal((error as CodexDemoError).terminationPending, true);
    return true;
  });
  child.emit('error', new Error('late private error'));
  child.emit('close', 1);
});

test('cleanup failure cannot mask the provider error and emits no raw cleanup text', async () => {
  const original = new CodexDemoError('CODEX_DEMO_NETWORK_FAILED');
  await assert.rejects(runWithCleanup(async () => { throw original; }, async () => { throw new Error('EBUSY private path'); }), error => {
    assert.equal(error, original);
    assert.equal(original.cleanupFailed, true);
    assert.ok(!JSON.stringify(error).includes('private path'));
    return true;
  });
  await assert.rejects(runWithCleanup(async () => 1, async () => { throw new Error('EPERM private path'); }), /CODEX_DEMO_TEMP_CLEANUP_FAILED/);
});

test('stream failure classification preserves nested rate/auth codes and can use later bounded stderr', async () => {
  for (const event of [
    { type: 'error', code: 'usage_limit_reached' },
    { type: 'turn.failed', error: { type: 'insufficient_quota' } },
  ]) assert.throws(() => createEventCollector().onLine(JSON.stringify(event)), /CODEX_DEMO_RATE_OR_CREDIT_LIMIT/);
  assert.throws(() => createEventCollector().onLine('{"type":"error","error":"invalid_grant"}'), /CODEX_DEMO_AUTHENTICATION_FAILED/);
  const child = new FakeChild();
  child.autoCloseOnKill = false;
  const collector = createEventCollector();
  const promise = runProcess({ installation, args: [], cwd: tmpdir(), environment: {},
    spawn: () => child as unknown as ReturnType<SpawnProcess>, timeoutMs: 1000, onLine: collector.onLine });
  child.stdout.write('{"type":"error","message":"Request failed"}\n');
  child.stderr.write('Connection refused; private diagnostic');
  child.emit('close', 1);
  await assert.rejects(promise, /CODEX_DEMO_NETWORK_FAILED/);
});

test('installed CLI completes the real event collector with zero tools and a loopback synthetic SSE response', async context => {
  let localInstallation;
  try { localInstallation = await findCodexInstallation(); }
  catch { context.skip('Pinned npm CLI is not installed; all fake-process tests still run.'); return; }
  const directory = await mkdtemp(path.join(tmpdir(), 'safety-guard-codex-loopback-test-'));
  let requestCount = 0;
  let toolCount = -1;
  let correctRoute = false;
  let hasInput = false;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 256_000) { request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      requestCount++;
      correctRoute = request.method === 'POST' && request.url === '/v1/responses';
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        toolCount = Array.isArray(body.tools) ? body.tools.length : body.tools === undefined ? 0 : -1;
        hasInput = Array.isArray(body.input) && body.input.length > 0;
      } catch { /* Assertions below detect an invalid request without logging it. */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const text = JSON.stringify(assessment);
      const message = { id: 'msg_offline', type: 'message', role: 'assistant', phase: 'final_answer', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] };
      const baseResponse = { id: 'resp_offline', object: 'response', created_at: 1_900_000_000, model: 'gpt-5.6-terra', output: [] };
      const events = [
        { type: 'response.created', response: { ...baseResponse, status: 'in_progress' } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text },
        { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
        { type: 'response.output_item.done', output_index: 0, item: message },
        { type: 'response.completed', response: { ...baseResponse, status: 'completed', output: [message],
          usage: { input_tokens: 110, output_tokens: 30, total_tokens: 140,
            input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 0 } } } },
      ];
      response.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const schemaPath = path.join(directory, 'schema.json');
    await writeFile(schemaPath, JSON.stringify(SEMANTIC_TOOL_PARAMETERS));
    const args = buildExecArgs(schemaPath);
    // Only authentication/provider/model are changed. All production capability
    // restrictions stay intact. This server has no upstream or model connection.
    args.splice(0, 0, '-c', 'model_provider="offline_inventory"', '-c', 'model="gpt-5.6-terra"', '-c',
      `model_providers.offline_inventory={name="Offline inventory",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}`);
    args[args.indexOf('forced_login_method="chatgpt"')] = 'forced_login_method="api"';
    const collector = createEventCollector();
    const eventTypes: string[] = [];
    await runProcess({ installation: localInstallation, args, cwd: directory,
      environment: { ...scrubEnvironment(process.env), CODEX_API_KEY: 'dummy-offline-test-not-a-key' },
      spawn: nativeSpawn, timeoutMs: 10_000, input: 'Return the supplied assessment schema. No tools. Synthetic offline probe.',
      onLine: line => { eventTypes.push(JSON.parse(line).type); collector.onLine(line); } });
    assert.equal(requestCount, 1);
    assert.equal(correctRoute, true);
    assert.equal(hasInput, true);
    assert.equal(toolCount, 0);
    assert.ok(eventTypes.includes('turn.started'));
    assert.ok(eventTypes.includes('turn.completed'));
    assert.deepEqual(collector.finish(), { assessment, usage: { inputTokens: 110, outputTokens: 30, cachedInputTokens: 20 } });
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (path.dirname(directory) === tmpdir() && path.basename(directory).startsWith('safety-guard-codex-loopback-test-')) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
