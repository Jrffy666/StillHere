import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

// Creates only synthetic accounts and simulated journeys; no model or chain calls.
const origin = process.argv[2] || 'https://safety-guard-htn2026.klavander56.chatgpt.site';
const reportPath = process.argv[3];
const checks = [];
const accounts = [];
const suffix = randomBytes(6).toString('hex');
const secret = () => randomBytes(24).toString('base64url');
function check(name, condition) { assert.ok(condition, name); checks.push(name); }
async function request(path, { token, body } = {}) {
  const response = await fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, data: await response.json().catch(() => null) };
}
async function register(role) {
  const account = { username: `check_${role}_${suffix}`, password: secret(), session: null };
  const response = await request('/api/auth/register', { body: { name: `Account verification ${role}`, username: account.username, password: account.password } });
  if (response.data?.token) { account.session = response.data; accounts.push(account); }
  check(`${role} can register without a wallet or email`, response.status === 201 && Boolean(account.session?.user.id));
  return account;
}
let failure;
let deleted = 0;
try {
  const first = await register('rider');
  const second = await register('guardian');
  check('Registered identities are distinct', first.session.user.id !== second.session.user.id);
  const duplicate = await request('/api/auth/register', { body: { name: 'Unrelated name', username: first.username.toUpperCase(), password: secret() } });
  check('Case variants cannot claim an existing username', duplicate.status === 409);
  const wrong = await request('/api/auth/login', { body: { username: first.username, password: secret() } });
  const unknown = await request('/api/auth/login', { body: { username: `unknown_${suffix}`, password: secret() } });
  check('Wrong and unknown credentials return the same generic rejection', wrong.status === 401 && unknown.status === 401 && wrong.data?.error === unknown.data?.error);
  const trip = await request('/api/demo/start', { token: first.session.token, body: {} });
  check('Registered account can create a simulated journey', trip.status === 201 && Boolean(trip.data?.trip.id));
  const originalId = first.session.user.id;
  const originalToken = first.session.token;
  check('Sign out succeeds', (await request('/api/auth/logout', { token: originalToken, body: {} })).status === 200);
  check('Signed-out token is revoked', (await request('/api/me', { token: originalToken })).status === 401);
  const returned = await request('/api/auth/login', { body: { username: first.username.toUpperCase(), password: first.password } });
  if (returned.data?.token) first.session = returned.data;
  check('New login restores the same account with a fresh token', returned.status === 200 && first.session.user.id === originalId && first.session.token !== originalToken);
  const history = await request('/api/trips', { token: first.session.token });
  check('Journey history survives sign out and sign in', history.status === 200 && history.data?.myTrips.some(item => item.id === trip.data.trip.id));
  const otherHistory = await request('/api/trips', { token: second.session.token });
  check('Other accounts do not acquire the journey history', otherHistory.status === 200 && !otherHistory.data?.myTrips.some(item => item.id === trip.data.trip.id));
  const profile = await request(`/api/members/${originalId}`, { token: second.session.token });
  check('Public member profile omits the login username', profile.status === 200 && !('username' in profile.data.member));
  const extra = await request('/api/auth/login', { body: { username: first.username, password: first.password } });
  check('The same account supports another session', extra.status === 200 && extra.data?.user.id === originalId);
  const previousToken = first.session.token;
  const nextPassword = secret();
  const changed = await request('/api/auth/password', { token: first.session.token, body: { currentPassword: first.password, newPassword: nextPassword } });
  if (changed.data?.token) { first.session = changed.data; first.password = nextPassword; }
  check('Password change returns a fresh authenticated session', changed.status === 200 && first.session.token !== previousToken);
  check('Password change revokes another session', (await request('/api/me', { token: extra.data.token })).status === 401);
  const newLogin = await request('/api/auth/login', { body: { username: first.username, password: first.password } });
  if (newLogin.data?.token) first.session = newLogin.data;
  check('New password returns to the same account', newLogin.status === 200 && newLogin.data?.user.id === originalId);
  const guest = { username: `check_upgrade_${suffix}`, password: secret(), session: null };
  const guestResponse = await request('/api/session', { body: { name: 'Account verification existing guest' } });
  if (guestResponse.data?.token) { guest.session = guestResponse.data; accounts.push(guest); }
  check('Existing guest flow remains compatible', guestResponse.status === 201 && Boolean(guest.session?.token));
  const guestId = guest.session.user.id;
  const guestTrip = await request('/api/demo/start', { token: guest.session.token, body: {} });
  check('Existing guest can have history before upgrading', guestTrip.status === 201 && Boolean(guestTrip.data?.trip.id));
  const upgraded = await request('/api/auth/register', { token: guest.session.token, body: { name: guest.session.user.name, username: guest.username, password: guest.password } });
  if (upgraded.data?.token) guest.session = upgraded.data;
  check('Adding a login keeps the existing guest identity', [200, 201].includes(upgraded.status) && guest.session.user.id === guestId && guest.session.user.username === guest.username);
  const guestHistory = await request('/api/trips', { token: guest.session.token });
  check('Adding a login preserves the guest journey history', guestHistory.status === 200 && guestHistory.data?.myTrips.some(item => item.id === guestTrip.data.trip.id));
} catch (error) { failure = error; }
finally {
  for (const account of accounts) {
    let removed = await request('/api/account/delete', { token: account.session.token, body: { confirmation: 'DELETE MY ACCOUNT' } });
    if (removed.status === 401) {
      const login = await request('/api/auth/login', { body: { username: account.username, password: account.password } });
      if (login.data?.token) removed = await request('/api/account/delete', { token: login.data.token, body: { confirmation: 'DELETE MY ACCOUNT' } });
    }
    if (removed.status === 200 && removed.data?.deleted === true) deleted++;
    else failure ||= new Error('Synthetic account cleanup failed; investigate before rerunning.');
  }
}
if (failure) throw failure;
check('All synthetic accounts and their private demo journeys were deleted', deleted === accounts.length);
const report = { checkedAt: new Date().toISOString(), origin, checksPassed: checks.length, checks,
  scope: 'HTTP registration, existing guest upgrade, re-login and simulated journey-history persistence through the frontend proxy. No browser interaction, ordinary community journey settlement or model inference was tested by this script.',
  cleanup: { syntheticAccountsCreated: accounts.length, syntheticAccountsDeleted: deleted }, blockchainTransactions: 0, modelCalls: 0, externalNotifications: 0 };
if (reportPath) await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: 'passed', checks: checks.length, accountsDeleted: deleted }));
