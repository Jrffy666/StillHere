import assert from 'node:assert/strict';
import test from 'node:test';
import { bannerCategory, communityHonors, receivedBanners } from '../web/lib/honors.ts';
import { communityReceiptUrl } from '../web/lib/community.ts';

const guardian = 'a'.repeat(64);
const rider = 'b'.repeat(64);
const otherGuardian = 'c'.repeat(64);
const journey = 'd'.repeat(64);
const address = '11111111111111111111111111111111';

function totals(overrides = {}) {
  return { points: 0, reputation: 0, contributions: 0, banners: 0, history: 0, ...overrides };
}

function record(id, overrides = {}) {
  const { event, ...fields } = overrides;
  return {
    id,
    event: {
      journeyId: journey, sequence: 5, kind: 'gratitude', actorId: rider,
      subjectId: guardian, assignment: 1, observedAt: 1_780_000_000, value: 1,
      ...event,
    },
    points: 0, reputation: 0, status: 'finalized', evidence: 'platform_attested',
    network: 'devnet', programId: address, recordAddress: address,
    signature: null, finalizedAt: 1_780_000_001_000, error: null,
    withdrawn: false, withdrawal: null,
    ...fields,
  };
}

function page(records = [], options = {}) {
  const { memberId = guardian, finalized = {}, pending = {}, nextCursor = null } = options;
  return {
    ledger: {
      memberId, evidence: 'platform_attested', network: 'devnet', programId: address,
      configured: true, finalized: totals(finalized), pending: totals(pending),
      withdrawn: records.filter(item => item.withdrawn).length, records, nextCursor,
    },
    legacy: { points: 0, reputation: 0, contributions: 0, banners: 0 },
  };
}

function unlockedIds(confirmed) {
  return communityHonors(confirmed).filter(honor => honor.unlocked).map(honor => honor.id);
}

test('received wall uses the public subject reference, never sent gratitude or another recipient', () => {
  const received = record('received');
  const sent = record('sent', { event: { actorId: guardian, subjectId: rider } });
  const other = record('other', { event: { subjectId: otherGuardian } });
  const applicationId = record('app-uuid', {
    event: { subjectId: '123e4567-e89b-42d3-a456-426614174000' },
  });
  const contribution = record('contribution', { event: { kind: 'contribution', actorId: guardian, value: 0 } });

  assert.deepEqual(receivedBanners([page([sent, other, applicationId, contribution, received])]), [received]);
  assert.deepEqual(receivedBanners([page([received], { memberId: rider })]), []);
});

test('only finalized received banners appear, across all supported categories', () => {
  const confirmed = [1, 2, 3].map(value => record(`confirmed-${value}`, { event: { value } }));
  const unconfirmed = ['pending', 'submitted', 'retry'].map(status => record(status, { status }));
  assert.deepEqual(receivedBanners([page([...unconfirmed, ...confirmed])]), confirmed);
  assert.deepEqual(confirmed.map(item => bannerCategory(item.event.value)), ['companionship', 'thoughtfulness', 'relay']);
});

test('finalized withdrawal excludes recognition; a pending correction preserves the original banner', () => {
  const pendingCorrection = record('pending-correction', {
    withdrawal: { journeyId: journey, targetSequence: 4, reason: 1, sequence: 6,
      observedAt: 1_780_000_005, status: 'submitted', recordAddress: null,
      signature: null, finalizedAt: null, error: null },
  });
  const withdrawn = record('withdrawn', {
    withdrawn: true,
    withdrawal: { ...pendingCorrection.withdrawal, status: 'finalized', recordAddress: address },
  });
  assert.deepEqual(receivedBanners([page([withdrawn, pendingCorrection])]), [pendingCorrection]);
  assert.equal(withdrawn.withdrawn, true, 'Projection must not erase retained historical evidence.');
});

test('appreciation for a cancelled journey remains valid without any points or contribution', () => {
  const closure = record('cancelled', { event: { kind: 'closed', actorId: rider, subjectId: rider, value: 2 } });
  const banner = record('thanks-after-cancellation');
  const response = page([closure, banner], { finalized: { banners: 1, history: 1 } });

  assert.deepEqual(receivedBanners([response]), [banner]);
  assert.deepEqual(unlockedIds(response.ledger.finalized), ['first-thanks']);
  assert.equal(response.ledger.finalized.points, 0);
});

test('overlapping pages deduplicate by ID and keep the current first-page withdrawal state', () => {
  const withdrawn = record('withdrawn', { withdrawn: true });
  const staleActive = record('withdrawn');
  const confirmed = record('confirmed');
  const stalePending = record('confirmed', { status: 'pending', recordAddress: null });
  const first = page([withdrawn, confirmed], { nextCursor: '50' });
  const later = page([staleActive, stalePending, confirmed]);

  assert.deepEqual(receivedBanners([first, later]), [confirmed]);
});

test('a first-page unconfirmed record cannot be replaced by a conflicting later-page record', () => {
  const current = record('conflict', { status: 'submitted' });
  const stale = record('conflict');
  assert.deepEqual(receivedBanners([page([current]), page([stale])]), []);
});

test('wall ordering uses observed time rather than insertion/page order and is stable for ties', () => {
  const older = record('older', { event: { observedAt: 100 } });
  const newest = record('newest', { event: { observedAt: 300 } });
  const tiedB = record('tie-b', { event: { observedAt: 200 } });
  const tiedA = record('tie-a', { event: { observedAt: 200 } });
  const firstPageRecords = [older, tiedB];

  assert.deepEqual(receivedBanners([page(firstPageRecords), page([newest, tiedA])]).map(item => item.id),
    ['newest', 'tie-a', 'tie-b', 'older']);
  assert.deepEqual(firstPageRecords, [older, tiedB], 'Projection must not reorder cached query pages.');
});

test('cabinet milestones use complete aggregate totals even when loaded pages contain no award records', () => {
  const response = page([], {
    finalized: { points: 125, reputation: 50, contributions: 5, banners: 2 },
    nextCursor: '50',
  });
  assert.deepEqual(receivedBanners([response]), []);
  assert.deepEqual(unlockedIds(response.ledger.finalized), ['first-watch', 'first-thanks', 'steady-presence']);
  const honors = communityHonors(response.ledger.finalized);
  assert.equal(honors.find(item => item.id === 'first-thanks').current, 2);
  assert.equal(honors.find(item => item.id === 'first-thanks').progress, 1);
});

test('pending and legacy recognition do not unlock confirmed honors', () => {
  const response = page([record('not-final', { status: 'pending' })], {
    pending: { points: 125, contributions: 5, banners: 3 },
  });
  response.legacy = { points: 250, reputation: 100, contributions: 10, banners: 4 };
  assert.deepEqual(unlockedIds(response.ledger.finalized), []);
  assert.deepEqual(receivedBanners([response]), []);
});

test('contribution milestones remain separate from appreciation and bound displayed progress', () => {
  const confirmed = totals({ contributions: 4, points: 100, reputation: 40 });
  assert.deepEqual(unlockedIds(confirmed), ['first-watch']);
  const steady = communityHonors(confirmed).find(item => item.id === 'steady-presence');
  assert.equal(steady.progress, 4);
  assert.equal(steady.target, 5);
  assert.equal(steady.unlocked, false);
  assert.deepEqual(communityHonors(totals()).map(item => item.progress), [0, 0, 0]);
});

test('absent or null member identity yields an empty wall and ignores unrelated cached pages', () => {
  assert.deepEqual(receivedBanners([]), []);
  assert.deepEqual(receivedBanners([page([record('orphan')], { memberId: null }), page([record('later')])]), []);
});

test('pages belonging to another member cannot contribute banners, even with a matching record subject', () => {
  const own = record('own');
  const contaminated = record('contaminated');
  const otherMemberBanner = record('other-member', { event: { subjectId: otherGuardian } });
  assert.deepEqual(receivedBanners([
    page([own]), page([contaminated, otherMemberBanner], { memberId: otherGuardian }),
  ]), [own]);
});

test('unknown category values retain a generic appreciation presentation', () => {
  for (const value of [0, 4, -1, 100, NaN]) assert.equal(bannerCategory(value), 'other');
  const futureCategory = record('future-category', { event: { value: 4 } });
  assert.deepEqual(receivedBanners([page([futureCategory])]), [futureCategory]);
});

test('receipt links require finalized Devnet evidence and a safe record address', () => {
  assert.equal(communityReceiptUrl(record('confirmed')),
    `https://explorer.solana.com/address/${address}?cluster=devnet`);
  for (const status of ['pending', 'submitted', 'retry']) {
    assert.equal(communityReceiptUrl(record(status, { status })), null);
  }
  assert.equal(communityReceiptUrl(record('local', { network: 'localnet' })), null);
  for (const recordAddress of [null, '', 'https://example.com', 'javascript:alert(1)', '0'.repeat(32), '1'.repeat(45)]) {
    assert.equal(communityReceiptUrl(record('unsafe', { recordAddress })), null);
  }
  assert.equal(communityReceiptUrl(record('withdrawn-history', { withdrawn: true })),
    `https://explorer.solana.com/address/${address}?cluster=devnet`,
    'Historical receipts stay inspectable after recognition is withdrawn.');
});
