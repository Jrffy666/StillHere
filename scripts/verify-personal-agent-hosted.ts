import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PersonalAgentClient, PersonalAgentError, PRODUCTION_ORIGIN } from './personal-agent-client';
import { watchPersonalAgent } from './personal-agent-watch';
import { assessInMemory, CodexDemoError } from './codex-demo';
import type { PersonalAgentConnection } from '../worker/src/personal-agent';
import type { Trip, User, GratitudeView } from '../worker/src/types';

interface Session { token: string; user: User }
interface JournalRecord {
  status: string; programId: string; recordAddress: string | null; signature: string | null; points: number; reputation: number;
  event: { sequence: number; kind: string; value: number };
}
interface Journal { enabled: boolean; journeyId: string; records: JournalRecord[]; nextCursor: string | null }
class ValidationError extends Error { constructor(readonly code: string) { super(code); } }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseHostedValidationArguments(args: string[]) {
  if (args.length === 1 && args[0] === '--check') return { check: true as const, retain: false };
  const allowed = new Set(['--run', '--confirm-synthetic', '--allow-model-call', '--retain-accounts']);
  if (new Set(args).size !== args.length || args.some(arg => !allowed.has(arg))
    || !['--run', '--confirm-synthetic', '--allow-model-call'].every(arg => args.includes(arg))) throw new ValidationError('EXPLICIT_HOSTED_MODEL_VALIDATION_FLAGS_REQUIRED');
  return { check: false as const, retain: args.includes('--retain-accounts') };
}
export async function runHostedPersonalAgentValidation(retainAccounts: boolean) {
  const marker = randomUUID().slice(0, 8);
  const privateDirectory = path.join(root, '.dev', 'personal-agent-hosted');
  const privateStatePath = path.join(privateDirectory, `${marker}.private.json`);
  const reportPath = path.join(root, 'docs', 'deployment', 'personal-agent.hosted.validation.json');
  const accounts: Session[] = [];
  const controller = new AbortController();
  let watchOutcome: Promise<{ result?: unknown; error?: unknown }> | undefined;
  let tripId: string | undefined;
  let connection: PersonalAgentConnection | undefined;
  let privateCreated = false;
  const report = {
    verifiedAt: new Date().toISOString(), origin: PRODUCTION_ORIGIN, status: 'running',
    checks: [] as string[], failure: null as string | null,
    model: { invocations: 0, completedTurns: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, durationsMs: [] as number[] },
    runtimeLimits: { maxTurns: 2, maxMinutes: 2 },
    actions: [] as { name: string; outcome: string }[], interpretationKinds: [] as string[], question: null as string | null,
    hostedOpenAiApiCalls: 0, externalNotifications: 0, browserInteractiveAcceptance: false,
    humanCheckInsBeforeAgent: 0, humanCheckInsAfterAgent: 0, humanCheckInsAfterReturn: 0,
    humanContributionPoints: 0, bannerCount: 0,
    community: null as null | { journeyId: string; programId: string | null; records: { sequence: number; kind: string; value: number; status: string; address: string | null; signature: string | null; points: number; reputation: number }[]; independentlyDecoded: false },
    syntheticAccountsCreated: 0, syntheticAccountsDeleted: 0, retainedForChainVerification: false,
  };
  function check(label: string, value: unknown): asserts value {
    if (!value) throw new ValidationError(`CHECK_FAILED_${label.replace(/[^a-z0-9]+/gi, '_').toUpperCase()}`);
    report.checks.push(label);
  }
  async function request<T>(endpoint: string, token?: string, body?: unknown, expected = 200): Promise<T> {
    const response = await fetch(new URL(endpoint, PRODUCTION_ORIGIN), { method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (response.status !== expected) { await response.body?.cancel(); throw new ValidationError(`HOSTED_HTTP_${response.status}_EXPECTED_${expected}`); }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new ValidationError('HOSTED_INVALID_CONTENT_TYPE');
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000) throw new ValidationError('HOSTED_RESPONSE_TOO_LARGE');
    return JSON.parse(text) as T;
  }
  async function persistPrivateState() {
    await mkdir(privateDirectory, { recursive: true });
    await writeFile(privateStatePath, JSON.stringify({ version: 1, origin: PRODUCTION_ORIGIN, tripId, accounts,
      connection, createdAt: report.verifiedAt, reportPath }, null, 2), { flag: privateCreated ? 'w' : 'wx', mode: 0o600 });
    privateCreated = true;
  }
  async function createSession(role: string) {
    const session = await request<Session>('/api/session', undefined, { name: `StillHere synthetic ${role} ${marker}` }, 201);
    accounts.push(session); report.syntheticAccountsCreated++;
    await persistPrivateState();
    await request('/api/me/community-notice', session.token, { version: 'community-v1' });
    return session;
  }
  const tripEndpoint = () => `/api/trips/${tripId}`;
  const readTrip = (session: Session) => request<{ trip: Trip }>(tripEndpoint(), session.token).then(value => value.trip);
  const action = (session: Session, body: object) => request<{ trip: Trip }>(`${tripEndpoint()}/actions`, session.token, body).then(value => value.trip);
  try {
    console.log('Checking deployed StillHere configuration.');
    const config = await request<{ ai: { provider: string; liveModel: boolean }; notifications: { configured: boolean }; community: { configured: boolean; network: string } }>('/api/config');
    check('Hosted OpenAI API and external notifications remain disabled', config.ai.provider === 'mock' && !config.ai.liveModel && !config.notifications.configured);
    check('Community ledger is configured for Devnet', config.community.configured && config.community.network === 'devnet');
    check('Production readiness passes', (await request<{ ready: boolean }>('/api/ready')).ready);
    const rider = await createSession('rider');
    const guardian = await createSession('guardian');
    let trip = (await request<{ trip: Trip }>('/api/trips', rider.token, {
      origin: { label: 'Synthetic rehearsal pickup', lat: 43.47, lng: -80.54 },
      destination: { label: 'Synthetic rehearsal arrival', lat: 43.46, lng: -80.52 },
      checkInIntervalSeconds: 300, notificationConsent: false, chainEnabled: false,
    }, 201)).trip;
    tripId = trip.id; await persistPrivateState();
    const application = await request<{ trip: { application: { id: string } | null } }>(`${tripEndpoint()}/actions`, guardian.token, { action: 'accept', requestId: trip.id });
    check('Guardian applies before rider approval', Boolean(application.trip.application?.id));
    trip = await action(rider, { action: 'approve-guardian', requestId: application.trip.application!.id });
    trip = await action(guardian, { action: 'check-in' });
    check('Two actual guest accounts form a non-simulated human assignment', !trip.demo && trip.guardian?.id === guardian.user.id && !trip.guardian.simulated && trip.guardMode === 'human');
    report.humanCheckInsBeforeAgent = trip.contributions.reduce((sum, entry) => sum + entry.checkIns, 0);
    await action(guardian, { action: 'message', text: 'Synthetic rehearsal: I will rest briefly and my named personal agent can accompany you if you approve.' });
    await action(rider, { action: 'message', text: 'Synthetic rehearsal: I felt okay at first.' });
    await action(rider, { action: 'message', text: 'Synthetic rehearsal, no real emergency: the driver took an unfamiliar detour and has not explained it. I feel uneasy. Please help me clarify the route and stay with me.' });
    const consent = { consent: true, noticeVersion: 'personal-agent-v1' };
    trip = (await request<{ trip: Trip }>(`${tripEndpoint()}/delegation`, guardian.token, { action: 'request', agentName: 'StillHere night companion', minutes: 5, ...consent })).trip;
    check('Named agent waits for rider approval', trip.personalAgent?.status === 'requested');
    const delegationId = trip.personalAgent!.id;
    trip = (await request<{ trip: Trip }>(`${tripEndpoint()}/delegation`, rider.token, { action: 'approve', delegationId, ...consent })).trip;
    check('Rider approves the exact named delegation', trip.personalAgent?.status === 'approved');
    const connected = await request<{ trip: Trip; connection: PersonalAgentConnection }>(`${tripEndpoint()}/delegation`, guardian.token, { action: 'connect', delegationId });
    connection = connected.connection; await persistPrivateState();
    const client = new PersonalAgentClient(connection, { processingApproved: true });
    check('Capability is journey scoped and is not an account session', connection.token !== guardian.token && connection.tripId === trip.id && connection.origin === PRODUCTION_ORIGIN);
    let completed!: () => void;
    const firstReceipt = new Promise<void>(resolve => { completed = resolve; });
    console.log('Starting bounded owner Codex watch on synthetic journey context.');
    watchOutcome = watchPersonalAgent(client, { maxTurns: 2, maxMinutes: 2, signal: controller.signal }, {
      assess: async (job, signal) => {
        report.model.invocations++;
        const startedAt = Date.now();
        const result = await assessInMemory({ context: job.context, expiresAt: job.expiresAt, processingApproved: true }, { signal });
        report.model.completedTurns++; report.model.durationsMs.push(Date.now() - startedAt);
        if (result.usage) {
          report.model.inputTokens += result.usage.inputTokens;
          report.model.outputTokens += result.usage.outputTokens;
          report.model.cachedInputTokens += result.usage.cachedInputTokens;
        }
        return result.assessment;
      },
      onEvent: event => { if (event.kind === 'completed') completed(); },
    }).then(result => ({ result }), error => ({ error }));
    await Promise.race([firstReceipt, watchOutcome.then(outcome => { if (outcome.error) throw outcome.error; throw new ValidationError('WATCH_ENDED_BEFORE_FIRST_RECEIPT'); })]);
    trip = await readTrip(rider);
    check('First real Codex proposal establishes active named agent coverage', trip.personalAgent?.status === 'active' && trip.guardMode === 'ai' && report.model.completedTurns >= 1);
    const receipt = trip.personalAgent!.receipts.at(-1)!;
    check('Server records a source-cited route interpretation', receipt.assessment.findings.some(finding => finding.topic === 'route' && finding.sourceIds.length > 0));
    check('Canonical check-in has an actual posted receipt', receipt.actions.some(item => item.name === 'send_check_in' && item.outcome === 'posted'));
    check('Posted message identifies the personal agent', trip.messages.some(message => message.automatedBy === 'personal_agent' && message.senderName.includes('StillHere night companion')));
    check('Interpretation causes no external notification', trip.notifications.length === 0);
    report.actions = receipt.actions.map(({ name, outcome }) => ({ name, outcome }));
    report.interpretationKinds = [...new Set(receipt.assessment.findings.map(finding => finding.kind))];
    report.question = receipt.assessment.question.kind;
    report.humanCheckInsAfterAgent = trip.contributions.reduce((sum, entry) => sum + entry.checkIns, 0);
    check('Agent execution does not inflate human check-ins', report.humanCheckInsAfterAgent === report.humanCheckInsBeforeAgent);
    console.log('Real Codex receipt recorded; checking human return and capability revocation.');
    trip = await action(guardian, { action: 'resume' });
    controller.abort();
    await watchOutcome;
    check('Human return revokes agent coverage and resumes human mode', trip.personalAgent?.status === 'revoked' && trip.personalAgent.endReason === 'human_resumed' && trip.guardMode === 'human');
    let denied = false;
    try { await client.call('status'); } catch (error) { denied = error instanceof PersonalAgentError && [401, 403, 409, 410].includes(error.status ?? 0); }
    check('Old scoped capability is rejected after human return', denied);
    report.humanCheckInsAfterReturn = trip.contributions.reduce((sum, entry) => sum + entry.checkIns, 0);
    check('Explicit human return adds the human check-in', report.humanCheckInsAfterReturn === report.humanCheckInsBeforeAgent + 1);
    trip = await action(rider, { action: 'arrive' });
    check('Rider can close the complete journey after agent handback', trip.status === 'arrived');
    report.humanContributionPoints = trip.contributions.filter(entry => entry.guardian.id === guardian.user.id).reduce((sum, entry) => sum + entry.points, 0);
    check('Human completion has the fixed contribution allocation', report.humanContributionPoints === 25);
    const gratitude = (await request<{ gratitude: GratitudeView }>(`${tripEndpoint()}/gratitude`, rider.token, { guardianId: guardian.user.id, kind: 'companionship' })).gratitude;
    report.bannerCount = gratitude.banners.length;
    check('Rider awards one free companionship banner to the human guardian', gratitude.banners.length === 1 && gratitude.banners[0].guardianId === guardian.user.id && gratitude.banners[0].kind === 'companionship');
    const journal: JournalRecord[] = []; let cursor: string | null = null; let journeyId = '';
    do {
      const value = (await request<{ community: Journal }>(`${tripEndpoint()}/community${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, rider.token)).community;
      check('Community journal remains enabled', value.enabled);
      journeyId = value.journeyId; journal.push(...value.records); cursor = value.nextCursor;
    } while (cursor);
    report.community = { journeyId, programId: journal[0]?.programId ?? null,
      records: journal.map(record => ({ sequence: record.event.sequence, kind: record.event.kind, value: record.event.value,
        status: record.status, address: record.recordAddress, signature: record.signature, points: record.points, reputation: record.reputation })), independentlyDecoded: false };
    check('Journal preserves agent start and explicit human return separately', journal.some(record => record.event.kind === 'agent_service' && record.event.value === 0)
      && journal.some(record => record.event.kind === 'agent_service' && record.event.value === 3));
    check('Journal contains human contribution and free banner events', journal.some(record => record.event.kind === 'contribution') && journal.some(record => record.event.kind === 'gratitude'));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = error instanceof ValidationError || error instanceof PersonalAgentError || error instanceof CodexDemoError ? error.code : 'HOSTED_VALIDATION_FAILED';
    process.exitCode = 1;
  } finally {
    controller.abort();
    await watchOutcome;
    if (retainAccounts && accounts.length) {
      report.retainedForChainVerification = true;
      await persistPrivateState();
      console.log(`Private follow-up state: ${path.relative(root, privateStatePath)}`);
    } else {
      for (const account of accounts) {
        try { await request('/api/account/delete', account.token, { confirmation: 'DELETE MY ACCOUNT' }); report.syntheticAccountsDeleted++; }
        catch { report.status = 'failed'; report.failure ??= 'SYNTHETIC_ACCOUNT_CLEANUP_PENDING'; process.exitCode = 1; }
      }
      if (privateCreated && report.syntheticAccountsDeleted === accounts.length) await rm(privateStatePath);
      else if (privateCreated) console.log(`Private cleanup state: ${path.relative(root, privateStatePath)}`);
    }
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ status: report.status, checks: report.checks.length, modelTurns: report.model.completedTurns,
      created: report.syntheticAccountsCreated, deleted: report.syntheticAccountsDeleted, retained: report.retainedForChainVerification,
      report: path.relative(root, reportPath), failure: report.failure }));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseHostedValidationArguments(process.argv.slice(2));
    if (options.check) console.log('Hosted StillHere validator ready. No network request or model call performed.');
    else await runHostedPersonalAgentValidation(options.retain);
  } catch (error) { console.error(error instanceof ValidationError ? error.code : 'HOSTED_VALIDATION_SETUP_FAILED'); process.exitCode = 1; }
}
