import assert from 'node:assert/strict';
import test from 'node:test';
import { personalAgentPresence } from '../web/lib/personal-agent.ts';

const now = 1_800_000_000_000;
const active = { status: 'active', expiresAt: now + 60_000, lastSeenAt: now - 1_000, nextResponseDueAt: now + 30_000 };
test('only accepted processing with a current lease displays personal-agent coverage', () => {
  assert.equal(personalAgentPresence(active, now).active, true);
  for (const status of ['requested', 'approved', 'connecting', 'revoked', 'expired', 'unavailable', 'ended'])
    assert.equal(personalAgentPresence({ ...active, status }, now).active, false);
});
test('stale cached trip data stops claiming coverage at any deadline', () => {
  for (const changes of [{ expiresAt: now }, { lastSeenAt: now - 45_000 }, { nextResponseDueAt: now }, { lastSeenAt: null }])
    assert.equal(personalAgentPresence({ ...active, ...changes }, now).active, false);
  assert.equal(personalAgentPresence({ ...active, nextResponseDueAt: null }, now).active, true);
});
test('connecting and missing delegation never imply a working model', () => {
  assert.equal(personalAgentPresence({ ...active, status: 'connecting' }, now).label, 'Waiting for the first response');
  assert.equal(personalAgentPresence(undefined, now).active, false);
});
