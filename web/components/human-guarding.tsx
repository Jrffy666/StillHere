'use client';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clock3,
  Copy,
  HeartHandshake,
  Users,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GuardRequest, Trip, TripSummary, User } from '@/lib/types';
import type { ActionBody } from '@/components/trip-detail';
import { MemberProfileCard, MemberProfileButton, useMemberProfile } from '@/components/member-profile';
import { CommunityNotice, useCommunityNotice } from '@/components/community-notice';
import { useCommunityRecords } from '@/components/community-records';
import { canCompactRelay } from '@/lib/journey-layout';

function remaining(at: number, now: number) {
  const seconds = Math.max(0, Math.ceil((at - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function GuardianInvitation({
  request,
  token,
  viewerId,
  busy,
  act,
}: {
  request: TripSummary;
  token: string;
  viewerId: string;
  busy: boolean;
  act: (action: ActionBody) => Promise<void>;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [committed, setCommitted] = useState(false);
  const riderProfile = useMemberProfile(request.riderProfile?.id, token, viewerId);
  const communityNotice = useCommunityNotice(token);
  const riderRecords = useCommunityRecords(request.riderProfile?.id, token, viewerId);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const pending =
    request.application && request.application.expiresAt > now
      ? request.application
      : null;
  const available = Boolean(
    request.requestId &&
    request.requestExpiresAt &&
    request.requestExpiresAt > now,
  );
  return (
    <article className="invitation-card">
      <HeartHandshake size={35} />
      <span className="pill">
        {request.requestKind === 'relay'
          ? 'HUMAN RELAY REQUEST'
          : 'GUARDIAN INVITATION'}
      </span>
      <h2>
        {pending
          ? 'Waiting for the rider’s approval.'
          : available
            ? 'Offer to be there for this journey.'
            : 'This request has ended.'}
      </h2>
      <p>
        Check in every {request.checkInIntervalSeconds} seconds. The rider
        chooses who can join. Route, location, and conversation stay private
        until you are approved.
      </p>
      {request.riderProfile ? (
        <div className="invitation-profile">
          <p className="field-label">Meet the person you will accompany</p>
          <MemberProfileCard memberId={request.riderProfile.id} token={token} viewerId={viewerId} compact />
          <MemberProfileButton memberId={request.riderProfile.id} name={request.riderProfile.name} token={token} viewerId={viewerId} />
        </div>
      ) : <output>The rider’s community profile is not available yet. This request refreshes automatically.</output>}
      {pending ? (
        <>
          {request.chainEnabled && (
            <p className="small-note">
              After the rider signs a proposal, use Sign & accept guardianship
              to join.
            </p>
          )}
          <div className="application-wait">
            <output className="application-countdown">
              <Clock3 size={16} /> Your application expires in{' '}
              {remaining(pending.expiresAt, now)}.
            </output>
            <p>Keep this page open. It updates when the rider approves you.</p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void act({
                  action: 'withdraw-application',
                  requestId: pending.id,
                }).catch(() => {})
              }
            >
              Withdraw application
            </Button>
          </div>
        </>
      ) : available ? (
        <>
          <CommunityNotice token={token} />
          <label className="commitment-choice">
            <Checkbox
              checked={committed}
              onCheckedChange={(value) => setCommitted(Boolean(value))}
            />
            <span>
              I am available to check in every {request.checkInIntervalSeconds}{' '}
              seconds and will request a relay if I need to leave.
            </span>
          </label>
          <Button
            disabled={busy || !committed || !communityNotice.accepted || !riderProfile.data || riderProfile.isError || !riderRecords.data || riderRecords.isError}
            onClick={() =>
              void act({
                action: 'accept',
                requestId: request.requestId!,
              }).catch(() => {})
            }
          >
            Apply to {request.requestKind === 'relay' ? 'take over' : 'guard'}{' '}
            <ArrowRight size={17} />
          </Button>
          <p className="small-note">
            An application lasts up to 5 minutes. Approval starts your check-in
            timer.
          </p>
        </>
      ) : (
        <p>Return to the community to find an open request.</p>
      )}
    </article>
  );
}

export function HumanGuarding({
  trip,
  user,
  token,
  now,
  busy,
  act,
  share,
}: {
  trip: Trip;
  user: User;
  token: string;
  now: number;
  busy: boolean;
  act: (action: ActionBody) => Promise<void>;
  share: () => Promise<void>;
}) {
  const [approval, setApproval] = useState<GuardRequest | null>(null);
  const applicantProfile = useMemberProfile(approval?.candidate.id, token, user.id);
  const applicantRecords = useCommunityRecords(approval?.candidate.id, token, user.id);
  const rider = user.id === trip.rider.id;
  const closed = trip.status === 'arrived' || trip.status === 'cancelled';
  const relay = trip.relay && trip.relay.expiresAt > now ? trip.relay : null;
  const candidates = (trip.guardianRequests || []).filter(
    (request) => request.expiresAt > now,
  );
  const approvalValid =
    approval && candidates.some((candidate) => candidate.id === approval.id);
  const compactRelay = canCompactRelay(trip, now);
  async function approve() {
    if (!approvalValid || !approval || !applicantProfile.data || applicantProfile.isError || !applicantRecords.data || applicantRecords.isError) return;
    try {
      await act({ action: 'approve-guardian', requestId: approval.id });
      setApproval(null);
    } catch {
      /* The page presents the server error; keep the decision visible. */
    }
  }
  return (
    <>
      {!trip.demo && !closed && (
        <article className={`human-relay-card ${compactRelay ? 'relay-compact' : ''}`} aria-label="Guardian requests and relay">
          {compactRelay ? <span className="relay-compact-label"><Users size={16} aria-hidden="true" /> Need a different guardian?</span> : <>
          <div className="card-header">
            <h3>
              <Users size={17} />{' '}
              {trip.status === 'open' ? 'Choose your guardian' : 'Human relay'}
            </h3>
          </div>
          {trip.status === 'open' ? (
            <p>
              Share the invitation with someone you trust. Approve their
              application before they can see your journey.
            </p>
          ) : relay ? (
            <div className="relay-status">
              <strong>Looking for the next guardian</strong>
              <p>Request expires in {remaining(relay.expiresAt, now)}.</p>
              <p>
                {trip.guardMode === 'human'
                  ? `${trip.guardian?.name || 'Your guardian'} remains assigned and should keep checking in until a replacement is approved.`
                  : 'No human has confirmed coverage. Scheduled reminders continue while you find a replacement.'}
              </p>
            </div>
          ) : (
            <p>
              A replacement must apply and be approved by the rider. Your
              assigned guardian keeps access until that handoff.
            </p>
          )}
          </>}
          <div className="relay-actions">
            {(trip.status === 'open' || relay) && (
              <Button variant="outline" onClick={() => void share()}>
                <Copy size={15} /> Copy {relay ? 'relay' : 'guardian'} invite
              </Button>
            )}
            {trip.status === 'active' && !relay && (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void act({ action: 'request-relay' }).catch(() => {})
                }
              >
                <HeartHandshake size={15} /> Request a human relay
              </Button>
            )}
            {relay && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void act({
                    action: 'cancel-relay',
                    requestId: relay.id,
                  }).catch(() => {})
                }
              >
                Cancel relay request
              </Button>
            )}
          </div>
          {(trip.status === 'open' || relay || candidates.length > 0) && <div className="guardian-applications" aria-live="polite">
            <h4>
              {candidates.length
                ? `${candidates.length} waiting application${candidates.length === 1 ? '' : 's'}`
                : 'No one is waiting for approval'}
            </h4>
            {candidates.map((candidate) => (
              <div className="guardian-application" key={candidate.id}>
                <div>
                  <strong>{candidate.candidate.name}</strong>
                  <span>
                    Guest {candidate.candidate.id.slice(0, 8)} ·{' '}
                    {remaining(candidate.expiresAt, now)} left
                  </span>
                </div>
                {rider ? (
                  <div className="relay-actions">
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => setApproval(candidate)}
                    >
                      <Check size={14} /> Review
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`Decline ${candidate.candidate.name}`}
                      onClick={() =>
                        void act({
                          action: 'reject-guardian',
                          requestId: candidate.id,
                        }).catch(() => {})
                      }
                    >
                      <X size={15} /> Decline
                    </Button>
                  </div>
                ) : (
                  <small>The rider will choose.</small>
                )}
              </div>
            ))}
          </div>}
          {rider && (trip.status === 'open' || relay || candidates.length > 0) && (
            <p className="small-note">
              Guest names are not verified. Check who is applying before
              approving access.
            </p>
          )}
        </article>
      )}
      <Dialog
        open={Boolean(approval)}
        onOpenChange={(open) => {
          if (!open) setApproval(null);
        }}
      >
        <DialogContent className="community-profile-dialog">
          <DialogHeader>
            <DialogTitle>Approve {approval?.candidate.name}?</DialogTitle>
            <DialogDescription>
              They will see the route, shared location, Uber link, and journey
              conversation, and must check in every{' '}
              {trip.checkInIntervalSeconds} seconds.
              {trip.guardian
                ? ` ${trip.guardian.name} will lose access to future trip details and actions ${trip.chainEnabled ? 'after the new guardian’s signed acceptance is finalized' : 'immediately'}.`
                : ''}
              {trip.chainEnabled
                ? ' Your signature proposes this guardian; their signed acceptance completes the handoff.'
                : ''}
            </DialogDescription>
          </DialogHeader>
          {approval && <><MemberProfileCard key={approval.candidate.id} memberId={approval.candidate.id} token={token} viewerId={user.id} compact /><MemberProfileButton memberId={approval.candidate.id} name={approval.candidate.name} token={token} viewerId={user.id} /></>}
          {!approvalValid && (
            <p role="alert">
              This application is no longer available. Close this window and
              review the current requests.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setApproval(null)}
            >
              Keep current arrangement
            </Button>
            <Button
              disabled={busy || !approvalValid || !applicantProfile.data || applicantProfile.isError || !applicantRecords.data || applicantRecords.isError}
              onClick={() => void approve()}
            >
              {trip.chainEnabled
                ? 'Sign guardian proposal'
                : 'Approve guardian'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function JourneyParticipation({ trip, viewerId }: { trip: Trip; viewerId: string }) {
  const closed = trip.status === 'arrived' || trip.status === 'cancelled';
  if (!trip.contributions.length) return null;
  return <section className="journey-participation" aria-label="Guardian check-ins">
    <h4>Guardian check-ins</h4>
    {trip.contributions.map(item => <div className="contribution-row" key={item.guardian.id}>
      <div><strong>{item.guardian.name}{item.guardian.id === viewerId ? ' (you)' : ''}</strong>
        <span>{item.checkIns} check-in{item.checkIns === 1 ? '' : 's'} · {item.endedAt === null && !closed ? 'Assigned now' : 'Shift ended'}</span></div>
      <small>{item.rewardStatus === 'credited' ? 'Journey credit recorded'
        : item.rewardStatus === 'demo' ? 'Demo only'
          : closed && item.rewardStatus === 'pending' ? 'Settlement pending'
            : item.rewardStatus === 'ineligible' ? 'No completion credit'
              : item.checkIns > 0 ? 'Checked in' : 'Check-in needed'}</small>
    </div>)}
    <p className="simple-note">Check-ins record participation. Chain confirmation is shown separately below.</p>
  </section>;
}
