import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PersonalAgentClient, readBoundedJson, MAX_CONNECTION_BYTES, MAX_REQUEST_BYTES, failure, safeError } from './personal-agent-client';
import { watchPersonalAgent } from './personal-agent-watch';
import { serveMcp } from './personal-agent-mcp';
import type { PersonalAgentOperation } from '../worker/src/personal-agent';
import { CodexDemoError } from './codex-demo';

export function parsePersonalAgentArguments(args: string[]) {
  const command = args[0];
  if (!['status', 'accept', 'updates', 'heartbeat', 'assess', 'release', 'watch', 'mcp'].includes(command)) failure('STILLHERE_INVALID_ARGUMENTS');
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (['--allow-processing', '--allow-loopback'].includes(option)) {
      if (flags.has(option)) failure('STILLHERE_INVALID_ARGUMENTS');
      flags.add(option); continue;
    }
    if (!['--connection', '--input', '--reason', '--max-turns', '--max-minutes'].includes(option)
      || values.has(option) || !args[index + 1] || args[index + 1].startsWith('--')) failure('STILLHERE_INVALID_ARGUMENTS');
    values.set(option, args[++index]);
  }
  if (!values.has('--connection') || !flags.has('--allow-processing')) failure('STILLHERE_PROCESSING_CONSENT_REQUIRED');
  if (values.has('--input') !== (command === 'assess') || values.has('--reason') && command !== 'release'
    || (values.has('--max-turns') || values.has('--max-minutes')) && command !== 'watch') failure('STILLHERE_INVALID_ARGUMENTS');
  const integer = (name: string, fallback: number, maximum: number) => {
    const value = values.get(name) ?? String(fallback);
    if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > maximum) failure('STILLHERE_INVALID_ARGUMENTS');
    return Number(value);
  };
  const reason = values.get('--reason') ?? 'stopped';
  if (!['stopped', 'model_unavailable', 'limit_reached'].includes(reason)) failure('STILLHERE_INVALID_ARGUMENTS');
  return { command, connectionPath: values.get('--connection')!, inputPath: values.get('--input'), reason,
    allowLoopback: flags.has('--allow-loopback'), maxTurns: integer('--max-turns', 12, 60), maxMinutes: integer('--max-minutes', 20, 120) };
}
export async function main(args: string[]) {
  const options = parsePersonalAgentArguments(args);
  const connection = await readBoundedJson(options.connectionPath, MAX_CONNECTION_BYTES);
  const client = new PersonalAgentClient(connection, { allowLoopback: options.allowLoopback, processingApproved: true });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const expiry = setTimeout(stop, Math.max(1, client.expiresAt - Date.now()));
  try {
    if (options.command === 'mcp') await serveMcp(client, process.stdin, process.stdout, controller.signal);
    else if (options.command === 'watch') {
      await watchPersonalAgent(client, { maxTurns: options.maxTurns, maxMinutes: options.maxMinutes, signal: controller.signal }, {
        onEvent: event => process.stdout.write(`${JSON.stringify(event)}\n`),
      });
    } else {
      const body = options.command === 'assess' ? await readBoundedJson(options.inputPath!, MAX_REQUEST_BYTES)
        : options.command === 'release' ? { reason: options.reason } : {};
      process.stdout.write(`${JSON.stringify(await client.call(options.command as PersonalAgentOperation, body, controller.signal))}\n`);
    }
  } finally { clearTimeout(expiry); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    const code = error instanceof CodexDemoError ? error.code : safeError(error);
    process.stderr.write(`${code}\n`);
    if (code === 'STILLHERE_INPUT_FILE_NOT_FOUND') process.stderr.write('The --connection or --input file was not found. Check its saved location and filename.\n');
    if (code === 'STILLHERE_INPUT_FILE_UNREADABLE') process.stderr.write('The --connection or --input file could not be read. Check its file permissions.\n');
    if (error instanceof CodexDemoError && error.cleanupFailed) process.stderr.write('STILLHERE_TEMP_CLEANUP_PENDING\n');
    if (error instanceof CodexDemoError && error.terminationPending) process.stderr.write('STILLHERE_MODEL_PROCESS_TERMINATION_PENDING\n');
    process.exitCode = 1;
  }
}
