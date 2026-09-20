import { env, SELF, reset, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { digest, type AccountPublic } from '../src/accounts';
import { encodeWallet, handleIdentity, type IdentityEnv } from '../src/identity';
import type { Trip } from '../src/types';

interface Session { token: string; user: AccountPublic & { username: string | null }; recoveryCode?: string; passwordCleared?: boolean }
interface Challenge { id: string; message: string }
const password = 'Synthetic account password 123!';
const replacement = 'Synthetic replacement password 456!';
const genericFailure = { error: 'Username or password is incorrect.' };

beforeEach(async () => { await reset(); });

function request(path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return SELF.fetch(`https://guard.test${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function register(username = 'night_guardian', token?: string, secret = password): Promise<Session> {
  const response = await request('/api/auth/register', token, { name: 'Night guardian', username, password: secret });
  expect(response.status).toBe(201);
  return response.json<Session>();
}
async function login(username = 'night_guardian', secret = password): Promise<Session> {
  const response = await request('/api/auth/login', undefined, { username, password: secret });
  expect(response.status).toBe(200);
  return response.json<Session>();
}
async function guest(): Promise<Session> {
  const response = await request('/api/session', undefined, { name: 'Existing volunteer' });
  expect(response.status).toBe(201);
  return response.json<Session>();
}
async function history(session: Session) {
  const account = env.USERS.getByName(session.user.id);
  await account.acceptCommunityNotice('community-v1');
  const created = await request('/api/trips', session.token, {
    origin: { label: 'Synthetic pickup', lat: 43.47, lng: -80.54 },
    destination: { label: 'Synthetic arrival', lat: 43.46, lng: -80.52 },
    checkInIntervalSeconds: 300,
  });
  expect(created.status).toBe(201);
  const trip = (await created.json<{ trip: Trip }>()).trip;
  // Seed prior earned recognition through the same account RPCs used by TripRoom.
  const creditId = crypto.randomUUID(), bannerId = crypto.randomUUID();
  expect(await account.credit(creditId, 25, 10, true)).toBe(true);
  expect(await account.recordGratitude(bannerId, 'companionship', Date.now(), true)).toBe(true);
  await account.updateProfile('Available for community journeys.');
  return { trip, data: await account.exportData(), member: await account.communityProfile(), identity: await account.communityIdentity() };
}
async function expectHistory(session: Session, before: Awaited<ReturnType<typeof history>>) {
  const account = env.USERS.getByName(session.user.id), after = await account.exportData();
  expect(after.trips).toEqual(before.data.trips);
  expect(after.credits).toEqual(before.data.credits);
  expect(after.gratitude).toEqual(before.data.gratitude);
  expect(await account.communityIdentity()).toEqual(before.identity);
  expect(await account.communityProfile()).toMatchObject({
    id: session.user.id, bio: 'Available for community journeys.', points: 25, reputation: 10,
    completedGuards: 1, gratitude: { total: 1, companionship: 1 },
  });
  const response = await request('/api/trips', session.token);
  expect(response.status).toBe(200);
  expect((await response.json<{ myTrips: Trip[] }>()).myTrips.map(trip => trip.id)).toContain(before.trip.id);
}

describe('Persistent username and password accounts', () => {
  it('signs in after logout and object eviction with a new token and the same history and recognition', async () => {
    const initial = await register('  Night_Guardian  '), before = await history(initial);
    expect(initial.user.username).toBe('night_guardian');
    expect((await request('/api/auth/logout', initial.token, {})).status).toBe(200);
    expect((await request('/api/me', initial.token)).status).toBe(401);
    await evictDurableObject(env.USERS.getByName(initial.user.id));
    await evictDurableObject(env.AUTH.getByName('username:night_guardian'));
    const current = await login('NIGHT_GUARDIAN');
    expect(current.user.id).toBe(initial.user.id);
    expect(current.token).not.toBe(initial.token);
    expect((await request('/api/me', current.token)).status).toBe(200);
    expect((await request('/api/me', initial.token)).status).toBe(401);
    await expectHistory(current, before);
  });

  it('upgrades the authenticated guest without losing its community identity, trip, contribution or banner', async () => {
    const initial = await guest(), before = await history(initial);
    expect(initial.user.username).toBeNull();
    const upgraded = await register('guest_to_member', initial.token);
    expect(upgraded.user.id).toBe(initial.user.id);
    expect(upgraded.user.username).toBe('guest_to_member');
    expect(upgraded.token).not.toBe(initial.token);
    expect((await request('/api/me', initial.token)).status).toBe(401);
    await expectHistory(upgraded, before);
    const current = await login('guest_to_member');
    expect(current.user.id).toBe(initial.user.id);
    await expectHistory(current, before);
  });

  it('rejects case-equivalent duplicate usernames without altering either account', async () => {
    const owner = await register('shared_name'), other = await guest();
    const response = await request('/api/auth/register', other.token, { name: 'Other person', username: ' SHARED_NAME ', password: replacement });
    expect(response.status).toBe(409);
    expect((await login('Shared_Name')).user.id).toBe(owner.user.id);
    expect((await request('/api/me', other.token)).status).toBe(200);
    expect((await env.USERS.getByName(other.user.id).getPublic())?.username).toBeNull();
  });

  it('serializes concurrent registrations of the same normalized username into one owner', async () => {
    const [a, b] = await Promise.all([guest(), guest()]);
    const replies = await Promise.all([
      request('/api/auth/register', a.token, { name: 'First', username: 'concurrent_name', password }),
      request('/api/auth/register', b.token, { name: 'Second', username: 'CONCURRENT_NAME', password }),
    ]);
    expect(replies.map(response => response.status).sort()).toEqual([201, 409]);
    const winner = await replies.find(response => response.status === 201)!.json<Session>();
    const loser = winner.user.id === a.user.id ? b : a;
    expect((await login('concurrent_name')).user.id).toBe(winner.user.id);
    expect((await request('/api/me', loser.token)).status).toBe(200);
    expect((await env.USERS.getByName(loser.user.id).getPublic())?.username).toBeNull();
  });

  it('does not silently create a new account for an invalid upgrade token or replace an existing password', async () => {
    const response = await request('/api/auth/register', 'invalid-session', { name: 'Intruder', username: 'unclaimed_name', password });
    expect(response.status).toBe(401);
    const owner = await register('unclaimed_name');
    expect((await request('/api/auth/register', owner.token, { name: 'Replaced', username: 'new_name', password: replacement })).status).toBe(409);
    expect((await login('unclaimed_name')).user.id).toBe(owner.user.id);
    expect((await request('/api/auth/login', undefined, { username: 'new_name', password: replacement })).status).toBe(401);
  });

  it('uses the same credential error for a wrong password and an unknown account', async () => {
    await register();
    for (const input of [{ username: 'night_guardian', password: replacement }, { username: 'unknown_guardian', password }]) {
      const response = await request('/api/auth/login', undefined, input);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(genericFailure);
    }
  });

  it('limits repeated username guesses across client addresses without blocking a different account', async () => {
    const owner = await register(), other = await register('other_guardian');
    for (let index = 0; index < 10; index++) {
      const response = await request('/api/auth/login', undefined, { username: 'NIGHT_GUARDIAN', password: replacement }, { 'CF-Connecting-IP': `192.0.2.${index + 1}` });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(genericFailure);
    }
    await evictDurableObject(env.AUTH.getByName('username:night_guardian'));
    const blocked = await request('/api/auth/login', undefined, { username: 'night_guardian', password }, { 'CF-Connecting-IP': '192.0.2.99' });
    expect(blocked.status).toBe(429);
    expect((await request('/api/me', owner.token)).status).toBe(200);
    expect((await login('other_guardian')).user.id).toBe(other.user.id);
  });

  it('resets failed-attempt limits after successful authentication and allows more than ten successful sign-ins', async () => {
    const owner = await register();
    const signIn = (secret: string, address: number) => request('/api/auth/login', undefined,
      { username: 'night_guardian', password: secret }, { 'CF-Connecting-IP': `192.0.2.${address}` });
    for (let index = 0; index < 9; index++) expect((await signIn(replacement, index + 1)).status).toBe(401);
    const accepted = await signIn(password, 20);
    expect(accepted.status).toBe(200);
    expect((await accepted.json<Session>()).user.id).toBe(owner.user.id);
    // A valid password resets the account's failure bucket, not just this client's IP bucket.
    for (let index = 0; index < 9; index++) expect((await signIn(replacement, index + 30)).status).toBe(401);
    for (let index = 0; index < 12; index++) {
      const response = await signIn(password, index + 100);
      expect(response.status).toBe(200);
      const current = await response.json<Session>();
      expect(current.user.id).toBe(owner.user.id);
      expect((await request('/api/auth/logout', current.token, {})).status).toBe(200);
      expect((await request('/api/me', current.token)).status).toBe(401);
    }
  });

  it.each([
    ['register', 'password-register', 30],
    ['login', 'password-login', 20],
    ['password', 'password-change', 10],
  ] as const)('enforces the client request limit before %s can mutate the account', async (endpoint, key, maximum) => {
    const owner = await register(), address = '192.0.2.200';
    const bucket = env.AUTH.getByName(`rate:${await digest(address)}`);
    for (let index = 0; index < maximum; index++) expect(await bucket.allow(key, maximum, 60_000)).toBe(true);
    await evictDurableObject(bucket);
    const input = endpoint === 'register' ? { name: 'Blocked signup', username: 'rate_blocked', password }
      : endpoint === 'login' ? { username: 'night_guardian', password }
      : { currentPassword: password, newPassword: replacement };
    const response = await request(`/api/auth/${endpoint}`, endpoint === 'password' ? owner.token : undefined, input, { 'CF-Connecting-IP': address });
    expect(response.status).toBe(429);
    expect((await request('/api/me', owner.token)).status).toBe(200);
    expect((await login()).user.id).toBe(owner.user.id);
  });

  it('enforces strict ASCII username and password length bounds without trimming passwords', async () => {
    const valid = { name: 'Validation fixture', username: 'valid_name', password };
    const invalid = [
      ...['ab', 'a'.repeat(33), 'space name', 'has-hyphen', 'has.dot', '\u5b88\u62a4\u8005', 'fullwidth_\uff21'].map(username => ({ ...valid, username })),
      ...['a'.repeat(11), 'a'.repeat(129), 123456789012, null].map(password => ({ ...valid, password })),
      { ...valid, name: '' }, { ...valid, username: null }, { ...valid, points: 25 },
    ];
    for (const [index, input] of invalid.entries()) {
      expect((await request('/api/auth/register', undefined, input, { 'CF-Connecting-IP': `192.0.2.${index + 1}` })).status).toBe(400);
    }
    const exact = ' abcdefghij '; // Exactly 12 characters; both spaces are part of the password.
    const minimum = await register('abc', undefined, exact);
    expect((await login('abc', exact)).user.id).toBe(minimum.user.id);
    expect((await request('/api/auth/login', undefined, { username: 'abc', password: exact.trim() })).status).not.toBe(200);
    const maximum = await register('a'.repeat(32), undefined, 'p'.repeat(128));
    expect((await login('a'.repeat(32), 'p'.repeat(128))).user.id).toBe(maximum.user.id);
  });

  it('requires POST JSON with a bounded body for all password endpoints', async () => {
    for (const endpoint of ['register', 'login', 'password']) {
      const url = `https://guard.test/api/auth/${endpoint}`;
      expect((await SELF.fetch(url)).status).toBe(405);
      expect((await SELF.fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
      expect((await SELF.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400);
      expect((await SELF.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(5000) }) })).status).toBe(400);
    }
  });

  it('rejects unapproved origins before registering, logging in or changing a password', async () => {
    const owner = await register();
    const hosted = { ...env, APP_ENV: 'production', SITE_ORIGIN: 'https://guard.example', AUTH_DOMAIN: 'guard.example', ALLOWED_ORIGINS: 'https://guard.example,https://other.example' } as IdentityEnv;
    const inputs = {
      register: { name: 'Origin fixture', username: 'origin_member', password },
      login: { username: 'night_guardian', password },
      password: { currentPassword: password, newPassword: replacement },
    };
    const invoke = (endpoint: keyof typeof inputs, origin: string, configuration = hosted) => handleIdentity(new Request(`https://api.example/api/auth/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Authorization: `Bearer ${owner.token}` },
      body: JSON.stringify(inputs[endpoint]),
    }), configuration);
    for (const endpoint of ['register', 'login', 'password'] as const) {
      expect((await invoke(endpoint, 'https://other.example'))?.status).toBe(403);
      expect((await invoke(endpoint, 'null'))?.status).toBe(403);
    }
    expect((await invoke('login', 'https://guard.example'))?.status).toBe(200);
    expect((await invoke('login', 'https://guard.example', { ...hosted, AUTH_DOMAIN: 'wrong.example' }))?.status).toBe(503);
    expect((await login()).user.id).toBe(owner.user.id);
  });

  it('cannot sign in after deletion or while its deletion journal is awaiting cleanup', async () => {
    const deleted = await register('deleted_member');
    expect((await request('/api/account/delete', deleted.token, { confirmation: 'DELETE MY ACCOUNT' })).status).toBe(200);
    expect((await request('/api/me', deleted.token)).status).toBe(401);
    const pending = await register('deletion_pending');
    await env.GOVERNANCE.getByName('governance-v1').beginDeletion(pending.user.id, []);
    for (const username of ['deleted_member', 'deletion_pending']) {
      const response = await request('/api/auth/login', undefined, { username, password });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual(genericFailure);
    }
    expect(await env.USERS.getByName(deleted.user.id).exportSnapshot()).toBeNull();
  });

  it('changes a password atomically, revokes every previous session and preserves account history', async () => {
    const first = await register(), before = await history(first), second = await login();
    const response = await request('/api/auth/password', first.token, { currentPassword: password, newPassword: replacement });
    expect(response.status).toBe(200);
    const changed = await response.json<Session>();
    expect(changed.user.id).toBe(first.user.id);
    expect(changed.token).not.toBe(first.token);
    expect(changed.user.authVersion).toBeGreaterThan(first.user.authVersion);
    for (const token of [first.token, second.token]) expect((await request('/api/me', token)).status).toBe(401);
    expect((await request('/api/me', changed.token)).status).toBe(200);
    expect((await request('/api/auth/login', undefined, { username: 'night_guardian', password })).status).toBe(401);
    const current = await login('night_guardian', replacement);
    expect(current.user.id).toBe(first.user.id);
    await expectHistory(current, before);
  });

  it('rejects unauthorized password changes without rotating sessions or altering the current credential', async () => {
    const owner = await register();
    expect((await request('/api/auth/password', undefined, { currentPassword: password, newPassword: replacement })).status).toBe(401);
    expect((await request('/api/auth/password', owner.token, { currentPassword: replacement, newPassword: replacement })).status).toBe(401);
    expect((await request('/api/auth/password', owner.token, { currentPassword: password, newPassword: 'too short' })).status).toBe(400);
    expect((await request('/api/me', owner.token)).status).toBe(200);
    expect((await login()).user.authVersion).toBe(owner.user.authVersion);
  });

  it('keeps usernames out of community projections and excludes credentials from account exports', async () => {
    const owner = await register('private_login_name'), viewer = await guest();
    const memberResponse = await request(`/api/members/${owner.user.id}`, viewer.token);
    expect(memberResponse.status).toBe(200);
    const member = await memberResponse.json();
    expect(JSON.stringify(member)).not.toContain('private_login_name');
    expect(JSON.stringify(member)).not.toContain('username');
    const exported = await request('/api/account/export', owner.token);
    expect(exported.status).toBe(200);
    const outputs = [await exported.json(), await env.USERS.getByName(owner.user.id).exportSnapshot(), owner.user, member];
    for (const output of outputs) {
      const encoded = JSON.stringify(output);
      expect(encoded).not.toContain(password);
      expect(encoded).not.toContain(owner.token);
      expect(encoded).not.toMatch(/"(?:password|verifier|salt|hash|iterations|credentials|password_hash)"\s*:/i);
      expect(encoded).not.toContain('PBKDF2');
    }
  });

  it('persists independent password verifiers rather than plaintext or a shared unsalted digest', async () => {
    const first = await register('first_verifier'), second = await register('second_verifier');
    const verifier = (session: Session) => runInDurableObject(env.USERS.getByName(session.user.id), async (_instance, state) => {
      const row = state.storage.sql.exec<{ verifier: string }>('SELECT verifier FROM credentials WHERE id=1').one();
      expect(row.verifier).not.toContain(password);
      return row.verifier;
    });
    const [a, b] = await Promise.all([verifier(first), verifier(second)]);
    expect(a).not.toBe(b);
    for (const session of [first, second]) {
      const exported = JSON.stringify(await env.USERS.getByName(session.user.id).exportData());
      expect(exported).not.toContain(a);
      expect(exported).not.toContain(b);
    }
  });

  it('retains both password and signed-wallet login after wallet binding and password change', async () => {
    const owner = await register();
    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const address = encodeWallet(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer));
    const walletSession = async (intent: 'bind' | 'login', session?: Session) => {
      const response = await request('/api/auth/challenge', session?.token, { intent, wallet: address });
      expect(response.status).toBe(200);
      const challenge = await response.json<Challenge>();
      const bytes = new Uint8Array(await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(challenge.message)));
      const verified = await request('/api/auth/verify', session?.token, { challengeId: challenge.id, signature: btoa(String.fromCharCode(...bytes)) });
      expect(verified.status).toBe(200);
      return verified.json<Session>();
    };
    const bound = await walletSession('bind', owner);
    expect(bound.user.wallet).toBe(address);
    expect(bound.user.username).toBe('night_guardian');
    const signedIn = await login();
    expect(signedIn.user.id).toBe(owner.user.id);
    const changed = await request('/api/auth/password', signedIn.token, { currentPassword: password, newPassword: replacement });
    expect(changed.status).toBe(200);
    expect((await walletSession('login')).user.id).toBe(owner.user.id);
    expect((await login('night_guardian', replacement)).user.wallet).toBe(address);
    expect((await request('/api/me', bound.token)).status).toBe(401);
  });

  it('clears password access on signed-wallet recovery and lets the recovered account reclaim its reserved username', async () => {
    const owner = await register('recoverable_member'), before = await history(owner);
    const wallet = async () => {
      const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
      return { pair, address: encodeWallet(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey) as ArrayBuffer)) };
    };
    const [previous, next] = await Promise.all([wallet(), wallet()]);
    const prove = async (intent: 'bind' | 'recover', account: Awaited<ReturnType<typeof wallet>>, session?: Session) => {
      const response = await request('/api/auth/challenge', session?.token, {
        intent, wallet: account.address, ...(intent === 'recover' ? { accountId: owner.user.id } : {}),
      });
      expect(response.status).toBe(200);
      const challenge = await response.json<Challenge>();
      const bytes = new Uint8Array(await crypto.subtle.sign('Ed25519', account.pair.privateKey, new TextEncoder().encode(challenge.message)));
      return { challengeId: challenge.id, signature: btoa(String.fromCharCode(...bytes)) };
    };
    const boundResponse = await request('/api/auth/verify', owner.token, await prove('bind', previous, owner));
    expect(boundResponse.status).toBe(200);
    const bound = await boundResponse.json<Session>();
    expect(bound.recoveryCode).toBeDefined();
    const priorPasswordSession = await login('recoverable_member');
    const recoveredResponse = await request('/api/auth/verify', undefined, {
      ...await prove('recover', next), recoveryCode: bound.recoveryCode,
    });
    expect(recoveredResponse.status).toBe(200);
    const recovered = await recoveredResponse.json<Session>();
    expect(recovered.user).toMatchObject({ id: owner.user.id, username: null, wallet: next.address });
    expect(recovered.passwordCleared).toBe(true);
    for (const token of [owner.token, bound.token, priorPasswordSession.token]) expect((await request('/api/me', token)).status).toBe(401);
    const denied = await request('/api/auth/login', undefined, { username: 'recoverable_member', password });
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual(genericFailure);
    await expectHistory(recovered, before);
    const outsider = await guest();
    expect((await request('/api/auth/register', outsider.token, { name: 'Other account', username: 'RECOVERABLE_MEMBER', password: replacement })).status).toBe(409);
    const restored = await register('recoverable_member', recovered.token, replacement);
    expect(restored.user).toMatchObject({ id: owner.user.id, username: 'recoverable_member', wallet: next.address });
    expect((await request('/api/me', recovered.token)).status).toBe(401);
    expect((await login('recoverable_member', replacement)).user.id).toBe(owner.user.id);
    expect((await request('/api/auth/login', undefined, { username: 'recoverable_member', password })).status).toBe(401);
    await expectHistory(restored, before);
  });
});
