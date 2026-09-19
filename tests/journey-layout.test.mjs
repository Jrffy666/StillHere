import assert from 'node:assert/strict';
import test from 'node:test';
import { canCompactRelay, gratitudeSummary } from '../web/lib/journey-layout.ts';

const now = 1_800_000_000_000;
const guardian = { id: 'guardian-current', name: 'Current guardian' };
function trip(overrides = {}) {
  return { status: 'active', guardMode: 'human', guardian, risk: 'normal',
    contributions: [{ guardian, checkIns: 1 }], lastGuardianCheckInAt: now - 1000,
    nextCheckInAt: now + 59000, relay: null, guardianRequests: [], ...overrides };
}

test('normal checked-in assignment compacts, but first and overdue check-ins remain expanded', () => {
  assert.equal(canCompactRelay(trip(), now), true);
  for (const overrides of [
    { contributions: [{ guardian, checkIns: 0 }] },
    { contributions: [{ guardian: { id: 'previous' }, checkIns: 4 }] },
    { lastGuardianCheckInAt: null }, { nextCheckInAt: null },
    { nextCheckInAt: now }, { nextCheckInAt: now - 1 },
  ]) assert.equal(canCompactRelay(trip(overrides), now), false);
});

test('active relay and applicants expand; expiry returns to a normal assignment', () => {
  assert.equal(canCompactRelay(trip({ relay: { expiresAt: now + 1 } }), now), false);
  assert.equal(canCompactRelay(trip({ guardianRequests: [{ expiresAt: now + 1 }] }), now), false);
  assert.equal(canCompactRelay(trip({ relay: { expiresAt: now }, guardianRequests: [{ expiresAt: now }] }), now), true);
});

test('missing human coverage, attention, and non-active journeys never compact', () => {
  for (const overrides of [
    { guardian: null }, { guardMode: 'ai' }, { guardMode: 'waiting' },
    { risk: 'attention' }, { risk: 'urgent' },
    { status: 'open' }, { status: 'arrived' }, { status: 'cancelled' },
  ]) assert.equal(canCompactRelay(trip(overrides), now), false);
});

test('unloaded and empty gratitude never falsely report all banners saved', () => {
  assert.deepEqual(gratitudeSummary(undefined), { saved: 0, allSaved: false });
  assert.deepEqual(gratitudeSummary({ eligibleGuardians: [], banners: [] }), { saved: 0, allSaved: false });
});

test('partial and pending deliveries keep the thank-you workflow open', () => {
  const eligibleGuardians = [{ id: 'first' }, { id: 'second' }];
  for (const banners of [
    [{ guardianId: 'first', status: 'recorded' }],
    [{ guardianId: 'first', status: 'recorded' }, { guardianId: 'second', status: 'pending' }],
    [{ guardianId: 'first', status: 'recorded' }, { guardianId: 'unrelated', status: 'recorded' }],
  ]) assert.deepEqual(gratitudeSummary({ eligibleGuardians, banners }), { saved: 1, allSaved: false });
});

test('every eligible guardian must receive one saved banner; duplicates add no recipients', () => {
  const eligibleGuardians = [{ id: 'first' }, { id: 'second' }];
  const banners = ['first', 'first', 'second'].map(guardianId => ({ guardianId, status: 'recorded' }));
  assert.deepEqual(gratitudeSummary({ eligibleGuardians, banners }), { saved: 2, allSaved: true });
});
