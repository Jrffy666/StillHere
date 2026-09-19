import assert from 'node:assert/strict';
import test from 'node:test';
import { journeyProgress } from '../web/lib/journey-progress.ts';

const firstGuardian = { id: 'guardian-first', name: 'First guardian' };
const nextGuardian = { id: 'guardian-next', name: 'Next guardian' };

function participation(guardian, checkIns = 0, overrides = {}) {
  return {
    guardian, checkIns, startedAt: 1_800_000_000_000, endedAt: null,
    points: 0, reputation: 0, rewardStatus: 'pending', ...overrides,
  };
}

function journey(overrides = {}) {
  return {
    demo: false, status: 'active', guardian: firstGuardian,
    contributions: [participation(firstGuardian)], ...overrides,
  };
}

test('arrival after approval without a guardian check-in explains the missing contribution', () => {
  const progress = journeyProgress(journey({
    status: 'arrived',
    contributions: [participation(firstGuardian, 0, { rewardStatus: 'ineligible' })],
  }));

  assert.equal(progress.noContributionAtArrival, true);
  assert.equal(progress.firstCheckInNeeded, false);
  assert.equal(progress.checkedGuardians, 0);
});

test('an assigned guardian receives a first-check-in prompt while the journey is active', () => {
  const progress = journeyProgress(journey());
  assert.equal(progress.currentCheckIns, 0);
  assert.equal(progress.firstCheckInNeeded, true);
  assert.equal(progress.noContributionAtArrival, false);

  const checkedIn = journeyProgress(journey({ contributions: [participation(firstGuardian, 1)] }));
  assert.equal(checkedIn.firstCheckInNeeded, false);
  assert.equal(checkedIn.currentCheckIns, 1);
});

test('checked-in arrival avoids the missing-check-in warning while settlement is still pending', () => {
  const trip = journey({
    status: 'arrived', contributions: [participation(firstGuardian, 1)],
  });
  const progress = journeyProgress(trip);

  assert.equal(progress.checkedGuardians, 1);
  assert.equal(progress.noContributionAtArrival, false);
  assert.equal(progress.firstCheckInNeeded, false);
  assert.equal(trip.contributions[0].rewardStatus, 'pending');
  assert.equal(trip.contributions[0].points, 0);
});

test('a relay prompts the new guardian without discarding an earlier guardian’s check-in', () => {
  const contributions = [
    participation(firstGuardian, 2, { endedAt: 1_800_000_060_000 }),
    participation(nextGuardian),
  ];
  const active = journeyProgress(journey({ guardian: nextGuardian, contributions }));
  assert.equal(active.currentCheckIns, 0);
  assert.equal(active.firstCheckInNeeded, true);
  assert.equal(active.checkedGuardians, 1);

  const arrived = journeyProgress(journey({ status: 'arrived', guardian: nextGuardian, contributions }));
  assert.equal(arrived.noContributionAtArrival, false);
  assert.equal(arrived.checkedGuardians, 1);
  assert.equal(contributions[0].checkIns, 2);
});

test('simulated and cancelled journeys do not show the missing-contribution arrival warning', () => {
  for (const trip of [
    journey({ demo: true, status: 'arrived' }),
    journey({ status: 'cancelled' }),
    journey({ demo: true }),
  ]) {
    const progress = journeyProgress(trip);
    assert.equal(progress.noContributionAtArrival, false);
    assert.equal(progress.firstCheckInNeeded, false);
  }
});

test('no assigned guardian never produces a guardian check-in prompt', () => {
  for (const status of ['open', 'active', 'arrived']) {
    const progress = journeyProgress(journey({ status, guardian: null, contributions: [] }));
    assert.equal(progress.firstCheckInNeeded, false);
    assert.equal(progress.currentCheckIns, 0);
    assert.equal(progress.checkedGuardians, 0);
    assert.equal(progress.noContributionAtArrival, status === 'arrived');
  }
});

test('simulated guardian activity cannot satisfy real journey participation', () => {
  const simulatedGuardian = { ...firstGuardian, simulated: true };
  const progress = journeyProgress(journey({
    status: 'arrived', guardian: simulatedGuardian,
    contributions: [participation(simulatedGuardian, 3, { rewardStatus: 'demo' })],
  }));

  assert.equal(progress.checkedGuardians, 0);
  assert.equal(progress.noContributionAtArrival, true);
});
