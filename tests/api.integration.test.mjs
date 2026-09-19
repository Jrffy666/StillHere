import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

// Run against the web proxy by default, or set GUARD_TEST_ORIGIN to the Worker
// origin. This exercises the public HTTP contract without browser automation.
const origin = (process.env.GUARD_TEST_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');
const apiBase = origin.endsWith('/api') ? origin : `${origin}/api`;
const cleanup = [];
const sessionTokens = [];
const sentinel = randomUUID().slice(0, 8);
const privateInput = {
  origin: { label: `Synthetic private pickup ${sentinel}`, lat: 47.600123, lng: -122.330456 },
  destination: { label: `Synthetic private destination ${sentinel}`, lat: 47.610789, lng: -122.320987 },
  shareUrl: `https://trip.uber.com/synthetic-integration-${sentinel}`,
  checkInIntervalSeconds: 60,
  emergencyContact: { name: `Synthetic contact ${sentinel}`, contact: `never-send-${sentinel}@example.invalid` },
  notificationConsent: false,
};

async function request(path, { token, method = 'GET', data } = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      Accept: 'application/json',
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  return { status: response.status, body, headers: response.headers };
}

function status(result, expected, operation) {
  // Never include bearer credentials or complete private response bodies in errors.
  assert.equal(result.status, expected, `${operation}: expected HTTP ${expected}, got ${result.status}`);
  return result.body;
}

async function session(name) {
  const result = await request('/session', { method: 'POST', data: { name: `${name} ${sentinel}` } });
  const person = status(result, 201, 'Create session');
  assert.equal(typeof person.token, 'string');
  assert.equal(typeof person.user.id, 'string');
  assert.equal(person.user.points, 0);
  assert.equal(person.user.reputation, 0);
  sessionTokens.push(person.token);
  const notice=await request('/me/community-notice',{method:'POST',token:person.token,data:{version:'community-v1'}});
  person.user=status(notice,200,'Accept public community record notice').user;
  assert.equal(person.user.communityNoticeVersion,'community-v1');
  return person;
}

async function create(person, demo = false) {
  const response = await request(demo ? '/demo/start' : '/trips', {
    method: 'POST', token: person.token, data: demo ? {} : privateInput,
  });
  const { trip } = status(response, 201, demo ? 'Create demo trip' : 'Create trip');
  cleanup.push({ id: trip.id, token: person.token });
  return trip;
}

async function action(trip, person, name, extra = {}) {
  return request(`/trips/${trip.id}/actions`, {
    method: 'POST', token: person.token, data: { action: name, ...extra },
  });
}

function assertRedacted(value) {
  const serialized = JSON.stringify(value);
  for (const forbidden of [
    privateInput.origin.label,
    privateInput.destination.label,
    privateInput.shareUrl,
    privateInput.emergencyContact.name,
    privateInput.emergencyContact.contact,
    String(privateInput.origin.lat),
    String(privateInput.origin.lng),
    String(privateInput.destination.lat),
    String(privateInput.destination.lng),
    ...sessionTokens,
  ]) assert.equal(serialized.includes(forbidden), false, 'A public response exposed private trip or authentication data');
}

function assertPublicSummary(trip, kind, requestId) {
  assertRedacted(trip);
  assert.deepEqual(Object.keys(trip).sort(), [
    'application', 'chainEnabled', 'checkInIntervalSeconds', 'createdAt', 'demo', 'id',
    'requestExpiresAt', 'requestId', 'requestKind', 'rewardPoints', 'riderProfile', 'status',
  ].sort(), 'Public requests must contain only the documented redacted fields');
  assert.equal(trip.requestKind, kind);
  assert.equal(trip.requestId, requestId);
  assert.deepEqual(Object.keys(trip.riderProfile).sort(), ['id', 'name']);
  assert.ok(trip.requestExpiresAt > Date.now(), 'Public request must have a future expiry');
  if (trip.application !== null) {
    assert.deepEqual(Object.keys(trip.application).sort(), ['expiresAt', 'id']);
    assert.equal(typeof trip.application.id, 'string');
    assert.ok(trip.application.expiresAt > Date.now());
  }
}

async function apply(trip, candidate, requestId = trip.id, kind = 'initial') {
  const pending = status(await action(trip, candidate, 'accept', { requestId }), 200, 'Apply to guard').trip;
  assertPublicSummary(pending, kind, requestId);
  assert.ok(pending.application, 'Candidate must receive their own application reference');
  return pending.application;
}

async function approve(trip, rider, application) {
  return status(await action(trip, rider, 'approve-guardian', { requestId: application.id }), 200, 'Rider approves guardian').trip;
}

async function profile(person) {
  return status(await request('/me', { token: person.token }), 200, 'Read participant rewards').user;
}

async function communityProfile(person, viewer) {
  const { member } = status(await request(`/members/${person.user.id}`, { token: viewer.token }), 200, 'Read always-public community profile');
  assert.deepEqual(Object.keys(member).sort(), ['bio', 'completedGuards', 'contributions', 'gratitude', 'id', 'name', 'points', 'reputation'].sort());
  assert.equal(member.id, person.user.id);
  assert.equal(member.name, person.user.name);
  assert.ok(member.contributions.length <= 20);
  for (const contribution of member.contributions) assert.deepEqual(Object.keys(contribution).sort(), ['points', 'reputation']);
  assert.deepEqual(Object.keys(member.gratitude).sort(), ['companionship', 'relay', 'thoughtfulness', 'total']);
  assert.equal(member.gratitude.total, member.gratitude.companionship + member.gratitude.thoughtfulness + member.gratitude.relay);
  assertRedacted(member);
  return member;
}

async function giveThanks(trip, rider, guardian, kind) {
  return request(`/trips/${trip.id}/gratitude`, {
    method: 'POST', token: rider.token, data: { guardianId: guardian.user.id, kind },
  });
}

function assertNoCredits(user) {
  assert.equal(user.points, 0);
  assert.equal(user.reputation, 0);
  assert.equal(user.completedGuards, 0);
}

before(async () => {
  const health = status(await request('/health'), 200, 'Service health');
  assert.equal(health.ok, true);
  const config = status(await request('/config'), 200, 'Integration configuration');
  // Fail before any workflows if this is an integration-enabled deployment.
  // No test is allowed to call a live model or send a real contact notification.
  assert.equal(config.ai.provider, 'mock', 'Integration tests require the offline mock configuration');
  assert.equal(config.ai.liveModel, false, 'Live models must remain disabled');
  assert.equal(config.ai.configured, false, 'Disable OpenAI before running these synthetic tests');
  assert.equal(config.notifications.configured, false, 'Disable real notification dispatch before running these tests');
  assert.equal(config.notifications.provider, 'demo');
  assert.equal(config.uber.configured, false);
  assert.equal(config.storage.persistent, true);
  assert.equal(config.storage.serverAlarms, true);
});

after(async () => {
  // Closing is attempted even after an assertion failure. Already-closed trips
  // correctly return 409, and are still verified through their private read.
  const outcomes = await Promise.allSettled(cleanup.map(async item => {
    const result = await request(`/trips/${item.id}/actions`, {
      method: 'POST', token: item.token, data: { action: 'cancel' },
    });
    assert.ok(result.status === 200 || result.status === 409, 'Synthetic trip cleanup failed');
    const { trip } = status(await request(`/trips/${item.id}`, { token: item.token }), 200, 'Verify cleanup');
    assert.ok(trip.status === 'arrived' || trip.status === 'cancelled', 'Synthetic trip was left open');
  }));
  assert.equal(outcomes.filter(item => item.status === 'rejected').length, 0, 'One or more synthetic trips could not be closed');
});

test('public configuration is truthful and unauthenticated access is rejected', async () => {
  const response = await request('/config');
  status(response, 200, 'Read configuration');
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  for (const forbidden of ['OPENAI_API_KEY', 'NOTIFICATION_WEBHOOK_SECRET', 'NOTIFICATION_ACK_SECRET', 'ELEVENLABS_API_KEY']) {
    assert.equal(JSON.stringify(response.body).includes(forbidden), false, 'Configuration exposed a secret field');
  }
  status(await request('/me'), 401, 'Reject unauthenticated profile access');
  status(await request('/trips'), 401, 'Reject unauthenticated trip access');
});

test('rider approval protects private trip details and credits a checked-in guardian exactly once', async () => {
  const rider = await session('Integration rider');
  const guardian = await session('Integration guardian');
  const outsider = await session('Integration outsider');
  assert.notEqual(rider.token, guardian.token);
  assert.notEqual(rider.user.id, guardian.user.id);

  status(await request(`/members/${rider.user.id}`), 401, 'Community profiles require a member session');
  const bio = 'Synthetic volunteer available for company on a journey.';
  const edited = status(await request('/me/profile', { method: 'POST', token: guardian.token, data: { bio } }), 200, 'Set community introduction');
  assert.equal(edited.member.bio, bio);
  const visibleBeforeApproval = await communityProfile(guardian, outsider);
  assert.equal(visibleBeforeApproval.bio, bio);
  assert.equal(visibleBeforeApproval.points, 0);
  assert.equal(visibleBeforeApproval.gratitude.total, 0);
  status(await request('/me/profile', { method: 'POST', token: guardian.token, data: { bio, private: true } }), 400, 'Profiles cannot opt out of community visibility');
  await communityProfile(rider, guardian);

  const trip = await create(rider);
  assert.equal(trip.demo, false);
  assert.equal(trip.status, 'open');
  assert.equal(trip.notificationConsent, false);
  const own = status(await request(`/trips/${trip.id}`, { token: rider.token }), 200, 'Read own trip');
  assert.equal(own.trip.emergencyContact.contact, privateInput.emergencyContact.contact);
  assert.equal(own.trip.origin.lat, privateInput.origin.lat);

  const redacted = status(await request(`/trips/${trip.id}`, { token: guardian.token }), 200, 'Read open request as outsider');
  assertPublicSummary(redacted.trip, 'initial', trip.id);
  assert.deepEqual(redacted.trip.riderProfile, { id: rider.user.id, name: rider.user.name });
  assert.equal(redacted.trip.application, null);
  const lobby = status(await request('/trips', { token: outsider.token }), 200, 'Read public lobby');
  assert.ok(lobby.trips.some(item => item.id === trip.id));
  assert.deepEqual(lobby.trips.find(item => item.id === trip.id).riderProfile, { id: rider.user.id, name: rider.user.name });
  assert.equal(lobby.myTrips.length, 0);
  assertRedacted(lobby);

  status(await action(trip, rider, 'accept', { requestId: trip.id }), 400, 'Reject self-guarding');
  status(await action(trip, outsider, 'help'), 403, 'Reject outsider mutation');
  const application = await apply(trip, guardian);
  const pending = status(await request(`/trips/${trip.id}`, { token: guardian.token }), 200, 'Read pending application').trip;
  assertPublicSummary(pending, 'initial', trip.id);
  assert.equal(pending.application.id, application.id);
  const otherView = status(await request(`/trips/${trip.id}`, { token: outsider.token }), 200, 'Hide application from other candidates').trip;
  assertPublicSummary(otherView, 'initial', trip.id);
  assert.equal(otherView.application, null);
  const review = status(await request(`/trips/${trip.id}`, { token: rider.token }), 200, 'Read rider approval queue').trip;
  assert.equal(review.guardian, null);
  assert.equal(review.status, 'open');
  assert.equal(review.guardianRequests.length, 1);
  assert.equal(review.guardianRequests[0].id, application.id);
  assert.equal(review.guardianRequests[0].candidate.id, guardian.user.id);
  assert.equal((await communityProfile(guardian, rider)).bio, bio, 'Rider can inspect a candidate profile before approval');
  status(await action(trip, guardian, 'check-in'), 403, 'Pending candidate cannot check in');
  status(await action(trip, guardian, 'message', { text: 'Must remain unauthorized.' }), 403, 'Pending candidate cannot send private messages');
  status(await action(trip, guardian, 'approve-guardian', { requestId: application.id }), 403, 'Candidate cannot approve themselves');
  status(await action(trip, guardian, 'accept', { requestId: trip.id }), 409, 'Reject duplicate application');

  const accepted = await approve(trip, rider, application);
  assert.equal(accepted.guardian.id, guardian.user.id);
  assert.equal(accepted.status, 'active');
  assert.equal(accepted.guardMode, 'human');
  assert.equal(accepted.emergencyContact.contact, privateInput.emergencyContact.contact);
  assert.equal(accepted.guardianRequests.length, 0);
  assert.equal(accepted.relay, null);
  status(await action(trip, rider, 'approve-guardian', { requestId: application.id }), 409, 'Reject repeated approval');
  const assignedView = status(await request(`/trips/${trip.id}`, { token: guardian.token }), 200, 'Approved guardian can read private trip').trip;
  assert.equal(assignedView.shareUrl, privateInput.shareUrl);
  assertRedacted(status(await request('/trips', { token: outsider.token }), 200, 'Read lobby after approval'));
  status(await request(`/trips/${trip.id}`, { token: outsider.token }), 403, 'Reject private read after approval');
  status(await action(trip, outsider, 'accept', { requestId: trip.id }), 409, 'Reject a second guardian without a relay');

  status(await action(trip, guardian, 'check-in'), 200, 'Record guardian contribution');
  const message = 'Synthetic guardian confirms availability.';
  const chatted = status(await action(trip, guardian, 'message', { text: message }), 200, 'Send guardian message').trip;
  assert.ok(chatted.messages.some(item => item.text === message && item.senderId === guardian.user.id));
  assert.equal(chatted.notifications.length, 0);
  status(await giveThanks(trip, rider, guardian, 'thoughtfulness'), 409, 'No gratitude promises during an active journey');
  status(await action(trip, guardian, 'arrive'), 403, 'Reject guardian-confirmed arrival');

  const arrived = status(await action(trip, rider, 'arrive'), 200, 'Confirm rider arrival').trip;
  assert.equal(arrived.status, 'arrived');
  assert.equal(arrived.reward.status, 'credited');
  status(await action(trip, rider, 'arrive'), 409, 'Reject repeated arrival');
  status(await action(trip, guardian, 'check-in'), 409, 'Reject closed-trip mutation');
  const rewarded = await profile(guardian);
  assert.equal(rewarded.points, 25);
  assert.equal(rewarded.reputation, 10);
  assert.equal(rewarded.completedGuards, 1);
  const replayProfile = await profile(guardian);
  assert.equal(replayProfile.points, 25);
  assert.equal(replayProfile.reputation, 10);
  assert.equal(replayProfile.completedGuards, 1);
  assertNoCredits(await profile(rider));
  assertNoCredits(await profile(outsider));

  const eligible = status(await request(`/trips/${trip.id}/gratitude`, { token: rider.token }), 200, 'Read free gratitude choices').gratitude;
  assert.deepEqual(eligible.eligibleGuardians, [{ id: guardian.user.id, name: guardian.user.name }]);
  assert.equal(eligible.banners.length, 0, 'Closing does not require gratitude');
  status(await giveThanks(trip, outsider, guardian, 'thoughtfulness'), 403, 'Outsider cannot send a journey banner');
  const thanks = status(await giveThanks(trip, rider, guardian, 'thoughtfulness'), 200, 'Thank an actual guardian for free').gratitude;
  assert.equal(thanks.banners.length, 1);
  assert.equal(thanks.banners[0].guardianId, guardian.user.id);
  assert.equal(thanks.banners[0].kind, 'thoughtfulness');
  assert.equal(thanks.banners[0].status, 'recorded');
  status(await giveThanks(trip, rider, guardian, 'thoughtfulness'), 200, 'Repeated gratitude is idempotent');
  status(await giveThanks(trip, rider, guardian, 'companionship'), 409, 'Cannot replace a recorded banner category');
  const thanked = await communityProfile(guardian, outsider);
  assert.equal(thanked.points, 25);
  assert.equal(thanked.reputation, 10);
  assert.equal(thanked.completedGuards, 1);
  assert.deepEqual(thanked.gratitude, { total: 1, companionship: 0, thoughtfulness: 1, relay: 0 });
  assert.equal(JSON.stringify(thanked).includes(trip.id), false);
  assert.equal(JSON.stringify(thanked).includes(rider.user.id), false, 'Received gratitude does not expose sender identity');
});

test('a rider-approved human relay revokes former access, preserves help, and splits one reward pool', async () => {
  const rider = await session('Relay rider');
  const first = await session('Relay first guardian');
  const replacement = await session('Relay replacement');
  const outsider = await session('Relay outsider');
  const trip = await create(rider);
  await approve(trip, rider, await apply(trip, first));
  status(await action(trip, first, 'check-in'), 200, 'First guardian contributes');
  status(await action(trip, first, 'check-in'), 200, 'Repeated check-in records work without extra reward pool');
  const privateMessage = `Private relay conversation ${sentinel}`;
  status(await action(trip, rider, 'message', { text: privateMessage }), 200, 'Create private conversation before relay');
  status(await action(trip, outsider, 'request-relay'), 403, 'Outsider cannot request replacement');

  const relaying = status(await action(trip, first, 'request-relay'), 200, 'Current guardian requests relief').trip;
  assert.equal(relaying.guardian.id, first.user.id, 'Original guardian remains assigned while waiting');
  assert.equal(relaying.guardMode, 'human');
  assert.ok(relaying.relay?.id);
  const relayId = relaying.relay.id;
  assert.ok(relaying.relay.expiresAt > Date.now());
  const publicRelay = status(await request(`/trips/${trip.id}`, { token: replacement.token }), 200, 'Read redacted relay request').trip;
  assertPublicSummary(publicRelay, 'relay', relayId);
  assert.equal(JSON.stringify(publicRelay).includes(privateMessage), false);
  const lobby = status(await request('/trips', { token: outsider.token }), 200, 'Find relay in community').trips;
  assertPublicSummary(lobby.find(item => item.id === trip.id), 'relay', relayId);
  assertRedacted(lobby);
  status(await action(trip, replacement, 'accept', { requestId: trip.id }), 409, 'Initial request cannot be reused for relay');
  const losingApplication = await apply(trip, outsider, relayId, 'relay');
  const application = await apply(trip, replacement, relayId, 'relay');
  const applicantTrips = status(await request('/trips', { token: replacement.token }), 200, 'Applicant sees only their redacted request');
  const pendingTrip = applicantTrips.myTrips.find(item => item.id === trip.id);
  assertPublicSummary(pendingTrip, 'relay', relayId);
  assert.equal(pendingTrip.application.id, application.id);
  assertRedacted(applicantTrips);
  status(await action(trip, replacement, 'check-in'), 403, 'Pending replacement cannot check in');
  status(await action(trip, first, 'approve-guardian', { requestId: application.id }), 403, 'Outgoing guardian cannot approve a replacement');
  status(await action(trip, outsider, 'cancel-relay', { requestId: relayId }), 403, 'Candidate cannot cancel a relay');

  const helped = status(await action(trip, rider, 'help', { text: 'Synthetic request for human assistance during relay.' }), 200, 'Rider requests help before transfer').trip;
  assert.equal(helped.risk, 'urgent');
  const transferred = await approve(trip, rider, application);
  assert.equal(transferred.guardian.id, replacement.user.id);
  assert.equal(transferred.guardMode, 'human');
  assert.equal(transferred.risk, 'urgent', 'Transfer must not clear an unresolved help request');
  assert.equal(transferred.relay, null);
  assert.equal(transferred.guardianRequests.length, 0);
  assert.ok(transferred.messages.some(item => item.text === privateMessage));
  assert.ok(transferred.notifications.every(item => item.channel !== 'webhook'));
  status(await action(trip, rider, 'approve-guardian', { requestId: losingApplication.id }), 409, 'Stale competing approval cannot replace the chosen guardian');
  status(await action(trip, rider, 'approve-guardian', { requestId: application.id }), 409, 'Repeated relay approval is rejected');
  status(await request(`/trips/${trip.id}`, { token: first.token }), 403, 'Former guardian loses private read immediately');
  status(await request(`/trips/${trip.id}`, { token: outsider.token }), 403, 'Unchosen candidate never gains private access');
  status(await action(trip, first, 'check-in'), 403, 'Former guardian cannot add contributions');
  status(await action(trip, first, 'message', { text: 'Unauthorized former guardian message.' }), 403, 'Former guardian cannot send private messages');
  const revokedList = status(await request('/trips', { token: first.token }), 200, 'Former guardian list revokes private trip');
  assert.equal(revokedList.myTrips.some(item => item.id === trip.id), false);
  assertRedacted(revokedList);
  const checked = status(await action(trip, replacement, 'check-in'), 200, 'Replacement contributes').trip;
  assert.equal(checked.risk, 'urgent', 'Guardian availability must not mark the rider safe');

  // Returning to a previous guardian must reuse their contribution record.
  const returning = status(await action(trip, rider, 'request-relay'), 200, 'Rider opens a second relay').trip;
  assert.notEqual(returning.relay.id, relayId);
  status(await action(trip, first, 'accept', { requestId: relayId }), 409, 'Previous relay ID cannot authorize a new application');
  const returnApplication = await apply(trip, first, returning.relay.id, 'relay');
  const returned = await approve(trip, rider, returnApplication);
  assert.equal(returned.guardian.id, first.user.id);
  assert.equal(returned.risk, 'urgent');
  assert.equal(returned.contributions.length, 2, 'Rejoining must not create another reward recipient');
  status(await request(`/trips/${trip.id}`, { token: replacement.token }), 403, 'Second outgoing guardian also loses access');
  status(await action(trip, first, 'check-in'), 200, 'Returning guardian contributes again');

  const arrived = status(await action(trip, rider, 'arrive'), 200, 'Complete relayed trip').trip;
  assert.equal(arrived.reward.status, 'credited');
  assert.equal(arrived.contributions.length, 2);
  const communityProfiles=await Promise.all([first,replacement].map(async person=>({id:person.user.id,...status(await request(`/members/${person.user.id}/records`,{token:rider.token}),200,'Read community evidence')})));
  const references=new Map(communityProfiles.map(item=>[item.id,item.ledger.memberId]));
  const allocations = [...arrived.contributions].sort((a, b) => references.get(a.guardian.id).localeCompare(references.get(b.guardian.id)));
  assert.deepEqual(allocations.map(item => item.points), [13, 12]);
  assert.deepEqual(allocations.map(item => item.reputation), [5, 5]);
  assert.equal(allocations.reduce((sum, item) => sum + item.points, 0), 25);
  assert.equal(allocations.reduce((sum, item) => sum + item.reputation, 0), 10);
  const community=status(await request(`/trips/${trip.id}/community`,{token:replacement.token}),200,'Former guardian reads only public journey evidence').community;
  assert.equal(community.enabled,true);
  assert.notEqual(community.journeyId,trip.id);
  assert.equal(community.records.filter(item=>item.event.kind==='assigned').length,3);
  assert.equal(community.records.filter(item=>item.event.kind==='contribution').length,2);
  assertRedacted(community);
  for(const item of communityProfiles){
    assert.equal(item.legacy.contributions,0,'New official credits must not be duplicated as legacy credits');
    assert.equal(item.ledger.finalized.contributions+item.ledger.pending.contributions,1);
    assert.equal(item.ledger.evidence,'platform_attested');
  }
  assert.equal(allocations.find(item => item.guardian.id === first.user.id).checkIns, 3);
  assert.equal(allocations.find(item => item.guardian.id === replacement.user.id).checkIns, 1);
  for (const allocation of allocations) {
    assert.equal(allocation.rewardStatus, 'credited');
    assert.ok(allocation.endedAt !== null);
    const person = allocation.guardian.id === first.user.id ? first : replacement;
    const credited = await profile(person);
    assert.equal(credited.points, allocation.points);
    assert.equal(credited.reputation, allocation.reputation);
    assert.equal(credited.completedGuards, 1);
  }
  status(await action(trip, rider, 'arrive'), 409, 'Reject repeated relayed arrival');
  for (const allocation of allocations) {
    const person = allocation.guardian.id === first.user.id ? first : replacement;
    const credited = await profile(person);
    assert.equal(credited.points, allocation.points, 'Replay must not credit an allocation twice');
    assert.equal(credited.reputation, allocation.reputation);
    assert.equal(credited.completedGuards, 1);
  }
  assertNoCredits(await profile(rider));
  assertNoCredits(await profile(outsider));
  status(await giveThanks(trip, rider, replacement, 'relay'), 200, 'A former guardian can receive a relay thank-you');
  assert.equal((await communityProfile(replacement, outsider)).gratitude.relay, 1);
  status(await request(`/trips/${trip.id}`, { token: replacement.token }), 403, 'Gratitude does not restore former guardian private access');
});

test('withdrawn, rejected, and cancelled requests cannot be approved or generate rewards', async () => {
  const rider = await session('Lifecycle rider');
  const guardian = await session('Lifecycle guardian');
  const candidate = await session('Lifecycle replacement');
  const trip = await create(rider);

  const withdrawnApplication = await apply(trip, guardian);
  status(await action(trip, candidate, 'withdraw-application', { requestId: withdrawnApplication.id }), 403, 'Only the applicant can withdraw their application');
  const withdrawn = status(await action(trip, guardian, 'withdraw-application', { requestId: withdrawnApplication.id }), 200, 'Withdraw initial application').trip;
  assertPublicSummary(withdrawn, 'initial', trip.id);
  assert.equal(withdrawn.application, null);
  status(await action(trip, rider, 'approve-guardian', { requestId: withdrawnApplication.id }), 409, 'Withdrawn application cannot be approved');
  const rejectedApplication = await apply(trip, guardian);
  status(await action(trip, candidate, 'reject-guardian', { requestId: rejectedApplication.id }), 403, 'Only the rider can reject an application');
  const rejected = status(await action(trip, rider, 'reject-guardian', { requestId: rejectedApplication.id }), 200, 'Reject initial application').trip;
  assert.equal(rejected.guardianRequests.length, 0);
  status(await action(trip, rider, 'approve-guardian', { requestId: rejectedApplication.id }), 409, 'Rejected application cannot be approved');
  const accepted = await approve(trip, rider, await apply(trip, guardian));
  assert.equal(accepted.contributions[0].checkIns, 0, 'Approval alone is not a completed contribution');
  status(await action(trip, guardian, 'check-in'), 200, 'Record contribution before cancellation');

  const relay = status(await action(trip, rider, 'request-relay'), 200, 'Rider requests replacement').trip.relay;
  const staleApplication = await apply(trip, candidate, relay.id, 'relay');
  const cancelledRelay = status(await action(trip, rider, 'cancel-relay', { requestId: relay.id }), 200, 'Rider cancels relay').trip;
  assert.equal(cancelledRelay.relay, null);
  assert.equal(cancelledRelay.guardian.id, guardian.user.id);
  assert.equal(cancelledRelay.guardianRequests.length, 0);
  status(await action(trip, rider, 'approve-guardian', { requestId: staleApplication.id }), 409, 'Cancelled relay application cannot be approved');
  status(await request(`/trips/${trip.id}`, { token: candidate.token }), 403, 'Cancelled candidate loses request access');
  const nextRelay = status(await action(trip, guardian, 'request-relay'), 200, 'Current guardian creates another relay').trip.relay;
  assert.notEqual(nextRelay.id, relay.id);
  status(await action(trip, candidate, 'accept', { requestId: relay.id }), 409, 'Cancelled relay identifier cannot be reused');
  const pending = await apply(trip, candidate, nextRelay.id, 'relay');
  const withdrewRelay = status(await action(trip, candidate, 'withdraw-application', { requestId: pending.id }), 200, 'Withdraw relay application').trip;
  assertPublicSummary(withdrewRelay, 'relay', nextRelay.id);
  assert.equal(withdrewRelay.application, null);
  status(await action(trip, rider, 'approve-guardian', { requestId: pending.id }), 409, 'Withdrawn relay application cannot be approved');
  await apply(trip, candidate, nextRelay.id, 'relay');

  const cancelled = status(await action(trip, rider, 'cancel'), 200, 'Cancel trip with contribution and pending relay').trip;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.reward.status, 'ineligible');
  assert.equal(cancelled.relay, null);
  assert.equal(cancelled.guardianRequests.length, 0);
  status(await action(trip, rider, 'arrive'), 409, 'Cancelled trip cannot later award arrival credit');
  status(await request(`/trips/${trip.id}`, { token: candidate.token }), 403, 'Cancelled trip remains private');
  assertNoCredits(await profile(rider));
  assertNoCredits(await profile(guardian));
  assertNoCredits(await profile(candidate));
  status(await giveThanks(trip, rider, guardian, 'companionship'), 200, 'Thank real help even when a journey was cancelled');
  status(await giveThanks(trip, rider, candidate, 'relay'), 409, 'An unapproved applicant cannot receive a journey banner');
  const cancelledThanks = await communityProfile(guardian, candidate);
  assert.equal(cancelledThanks.gratitude.companionship, 1);
  assertNoCredits(cancelledThanks);

  const noCheckInTrip = await create(rider);
  await approve(noCheckInTrip, rider, await apply(noCheckInTrip, guardian));
  const unearned = status(await action(noCheckInTrip, rider, 'arrive'), 200, 'Complete trip without a guardian check-in').trip;
  assert.equal(unearned.reward.status, 'ineligible');
  status(await giveThanks(noCheckInTrip, rider, guardian, 'companionship'), 409, 'Approval without check-in does not qualify for gratitude');
  assertNoCredits(await profile(guardian));
});

test('demo handoff, concern handling, and failed delivery remain simulated with no real credits', async () => {
  const rider = await session('Integration demo rider');
  const trip = await create(rider, true);
  assert.equal(trip.demo, true);
  assert.equal(trip.guardian.name, 'Alex');
  assert.equal(trip.guardian.simulated, true);
  assert.equal(trip.guardMode, 'human');

  const handoff = status(await action(trip, rider, 'simulate', { scenario: 'guardian-offline' }), 200, 'Simulate guardian offline').trip;
  assert.equal(handoff.guardMode, 'ai');
  assert.ok(handoff.events.some(item => item.type === 'takeover'));
  assert.equal(handoff.ai.mode, 'rules');
  assert.equal(handoff.agent.provider, 'mock');
  assert.equal(handoff.agent.liveModel, false);
  const run = handoff.agent.runs.find(item => item.status === 'completed');
  assert.ok(run, 'Offline agent must finish a real tool execution loop');
  assert.equal(run.steps[0].call.name, 'get_journey_context');
  assert.ok(run.steps.some(step => step.call.name === 'send_check_in' && step.result.ok));
  assert.ok(run.steps.some(step => step.call.name === 'schedule_follow_up' && step.result.ok));
  assert.ok(handoff.agent.handoffSummary.includes('Offline mock'));

  status(await action(trip, rider, 'message', { text: 'I am okay' }), 200, 'Record earlier reassurance');
  const concern = status(await action(trip, rider, 'message', { text: 'The route seems wrong and I am not sure' }), 200, 'Clarify later route concern').trip;
  assert.equal(concern.risk, 'attention');
  assert.ok(concern.messages.some(item => item.role === 'agent' && item.text.includes('What has changed')));

  const stale = status(await action(trip, rider, 'simulate', { scenario: 'stale-location' }), 200, 'Simulate stale location').trip;
  assert.ok(stale.location.updatedAt < Date.now() - 120_000);
  assert.ok(stale.agent.runs.some(item => item.trigger.kind === 'stale-location' && item.steps.some(step => step.result?.context?.location.stale)));
  const helped = status(await action(trip, rider, 'help', { text: 'Synthetic demonstration: I need help.' }), 200, 'Request demo help').trip;
  assert.equal(helped.risk, 'urgent');
  assert.equal(helped.ai.mode, 'rules');
  assert.ok(helped.notifications.some(item => item.status === 'simulated' && item.channel === 'demo'));
  assert.ok(helped.notifications.every(item => item.status !== 'sent' && item.status !== 'acknowledged'));

  const failed = status(await action(trip, rider, 'simulate', { scenario: 'notification-failure' }), 200, 'Simulate notification failure').trip;
  assert.ok(failed.notifications.some(item => item.status === 'failed' && item.channel === 'demo'));
  assert.ok(failed.notifications.every(item => item.channel !== 'webhook'));
  assert.ok(failed.agent.runs.some(item => item.trigger.kind === 'notification-failure' && item.status === 'completed'));
  const arrived = status(await action(trip, rider, 'arrive'), 200, 'Complete demo trip').trip;
  assert.equal(arrived.reward.status, 'demo');
  status(await request(`/trips/${trip.id}/gratitude`, { token: rider.token }), 409, 'Demo participants do not generate real gratitude');
  status(await action(trip, rider, 'arrive'), 409, 'Reject repeated demo arrival');
  const profile = status(await request('/me', { token: rider.token }), 200, 'Read demo user rewards').user;
  assert.equal(profile.points, 0);
  assert.equal(profile.reputation, 0);
  assert.equal(profile.completedGuards, 0);
});
