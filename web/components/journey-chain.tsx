'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { signJourneyTransaction } from '@/lib/wallet';
import { MemberProfileCard, useMemberProfile } from '@/components/member-profile';
import { CommunityNotice, useCommunityNotice } from '@/components/community-notice';
import { useCommunityRecords } from '@/components/community-records';
import type { Trip, TripSummary, User } from '@/lib/types';

export type ChainOperation =
  | 'create'
  | 'propose'
  | 'cancel-proposal'
  | 'accept'
  | 'check-in'
  | 'complete'
  | 'cancel'
  | 'claim';
interface ChainView {
  network: string;
  riderWallet: string;
  wallet: string | null;
  lastError: string | null;
  canAccept: boolean;
  canClaim: boolean;
  snapshot: {
    address: string;
    state: string;
    currentGuardian: string | null;
    proposedGuardian: string | null;
    sequence: number;
    contributions: {
      wallet: string;
      checkIns: number;
      points: number;
      reputation: number;
      claimed: boolean;
    }[];
  };
  intents: {
    id: string;
    operation: ChainOperation;
    status: string;
    signature: string | null;
    error: string | null;
  }[];
}
// The signed payload is deliberately not persisted in browser storage. The durable outbox owns retries.
export async function submitChainOperation(
  tripId: string,
  token: string,
  operation: ChainOperation,
  applicationId?: string,
) {
  const prepared = await api<{
    intentId: string;
    transaction: string;
    wallet: string;
  }>(`/trips/${tripId}/chain/prepare`, token, {
    operation,
    ...(applicationId ? { applicationId } : {}),
  });
  let transaction: string;
  try {
    transaction = await signJourneyTransaction(
      prepared.transaction,
      prepared.wallet,
    );
  } catch (error) {
    await api(`/trips/${tripId}/chain/discard`, token, {
      intentId: prepared.intentId,
    }).catch(() => {});
    throw error;
  }
  // A transport error after this call may still mean the server accepted it. Inspect the outbox before retrying.
  return api<ChainView>(`/trips/${tripId}/chain/submit`, token, {
    intentId: prepared.intentId,
    transaction,
  });
}
export function JourneyChain({
  trip,
  user,
  token,
  riderProfile,
}: {
  trip: Pick<Trip | TripSummary, 'id' | 'chainEnabled' | 'status'>;
  user: User;
  token: string;
  riderProfile?: { id: string; name: string } | null;
}) {
  const cache = useQueryClient(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const state = useQuery({
    queryKey: ['chain', user.id, trip.id],
    queryFn: async () =>
      (await api<{ chain: ChainView }>(`/trips/${trip.id}/chain`, token)).chain,
    enabled: Boolean(trip.chainEnabled),
    refetchInterval: 5000,
  });
  const member = useMemberProfile(state.data?.canAccept ? riderProfile?.id : undefined, token, user.id);
  const records = useCommunityRecords(state.data?.canAccept ? riderProfile?.id : undefined, token, user.id);
  const communityNotice = useCommunityNotice(token);
  if (!trip.chainEnabled) return null;
  const value = state.data,
    rider = value?.riderWallet === value?.wallet && Boolean(value?.wallet);
  const waiting = value?.intents.some(
    (item) => item.status === 'prepared' || item.status === 'submitted',
  );
  const ended = trip.status === 'arrived' || trip.status === 'cancelled';
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ['chain'] });
      void cache.invalidateQueries({ queryKey: ['trip'] });
      void cache.invalidateQueries({ queryKey: ['me'] });
    }
  }
  const button = (label: string, operation: ChainOperation) => (
    <Button
      disabled={busy || waiting || (operation === 'accept' && (!member.data || member.isError || !records.data || records.isError || !communityNotice.accepted))}
      onClick={() =>
        void run(() => submitChainOperation(trip.id, token, operation))
      }
    >
      {label}
    </Button>
  );
  const explorer = (kind: 'address' | 'tx', address: string) =>
    `https://explorer.solana.com/${kind}/${address}?cluster=devnet`;
  return (
    <article
      className="human-relay-card chain-journey"
      aria-label="Journey blockchain commitment"
    >
      <div className="card-header">
        <h3>Wallet-signed commitment</h3>
        <span className="mini-tag">{value?.network || 'Solana'}</span>
      </div>
      <p>
        One journey shares 25 points and 10 reputation between guardians with a
        signed check-in. Up to 16 distinct guardians can contribute.
      </p>
      <p className="small-note">These V2 protocol receipts are separate from the community ledger. Their allocations use wallet order and are not added to your community totals.</p>
      {value?.canAccept && <CommunityNotice token={token} />}
      {(error || state.isError || value?.lastError) && (
        <p role="alert" className="inline-error">
          {error ||
            (state.isError ? errorMessage(state.error) : value?.lastError)}{' '}
          Your conversation and help controls remain available.
        </p>
      )}
      {value ? (
        <>
          <div className="chain-overview">
            <span className="status-pill">{value.snapshot.state}</span>
            <span>{value.snapshot.sequence} accepted handoffs</span>
            {value.network === 'devnet' ? (
              <a
                target="_blank"
                rel="noopener noreferrer"
                href={explorer('address', value.snapshot.address)}
              >
                View public receipt ↗
              </a>
            ) : (
              <code>{value.snapshot.address}</code>
            )}
          </div>
          {value.canAccept && !ended && (riderProfile
            ? <MemberProfileCard memberId={riderProfile.id} token={token} viewerId={user.id} compact />
            : <p>The rider’s community profile is unavailable. Open the journey request to review it before accepting.</p>)}
          <div className="relay-actions">
            {rider &&
              value.snapshot.state === 'uncreated' &&
              !ended &&
              button('Create chain commitment', 'create')}
            {value.canAccept &&
              !ended &&
              button('Sign & accept guardianship', 'accept')}
            {value.snapshot.currentGuardian === value.wallet &&
              value.wallet &&
              value.snapshot.state === 'active' &&
              !ended &&
              button('Sign contribution check-in', 'check-in')}
            {rider &&
              value.snapshot.proposedGuardian &&
              !ended &&
              button('Revoke pending proposal', 'cancel-proposal')}
            {rider &&
              trip.status === 'arrived' &&
              value.snapshot.state === 'active' &&
              button('Sign arrival & allocate rewards', 'complete')}
            {rider &&
              trip.status === 'cancelled' &&
              ['active', 'open'].includes(value.snapshot.state) &&
              button('Close chain commitment', 'cancel')}
            {value.canClaim && button('Claim my contribution', 'claim')}
            <Button
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  api(`/trips/${trip.id}/chain/refresh`, token, {}),
                )
              }
            >
              Check confirmation
            </Button>
          </div>
          {!ended && value.snapshot.state === 'uncreated' && (
            <p>
              The rider first creates the chain commitment, then approves a
              guardian application.
            </p>
          )}
          {!ended && value.snapshot.proposedGuardian && (
            <p>
              A proposal is waiting for the guardian’s signature. The current
              guardian keeps access until the new acceptance is finalized.
            </p>
          )}
          {!ended && value.snapshot.currentGuardian === value.wallet && (
            <p className="small-note">
              Keep using regular availability check-ins. At least one signed
              contribution check-in is also required for your chain reward.
            </p>
          )}
          <details
            className="chain-records"
            open={Boolean(waiting || value.intents.some((item) => item.error))}
          >
            <summary>
              Transactions &amp; contributions
              <span>{value.intents.length} requests</span>
            </summary>
            {value.intents.slice(-4).map((item) => (
              <div className="chain-transaction" key={item.id}>
                <span>
                  {item.operation} · <strong>{item.status}</strong>
                </span>
                {item.signature && value.network === 'devnet' && (
                  <a
                    href={explorer('tx', item.signature)}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View transaction
                  </a>
                )}
                {item.error && <small>{item.error}</small>}
                {item.status === 'prepared' && (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        api(`/trips/${trip.id}/chain/discard`, token, {
                          intentId: item.id,
                        }),
                      )
                    }
                  >
                    Discard unsigned request
                  </Button>
                )}
              </div>
            ))}
            {value.intents.some((item) => item.status === 'submitted') && (
              <output>
                Confirmation is pending. You can close and reopen the page; the
                server checks and retries the same signed transaction.
              </output>
            )}
            {value.snapshot.contributions.map((item) => (
              <div className="contribution-row" key={item.wallet}>
                <span>
                  {item.wallet === value.wallet
                    ? 'You'
                    : `${item.wallet.slice(0, 6)}…${item.wallet.slice(-4)}`}{' '}
                  · {item.checkIns} signed check-ins
                </span>
                <small>
                  {value.snapshot.state === 'completed'
                    ? `${item.points} points · ${item.reputation} reputation · ${item.claimed ? 'claimed' : item.checkIns ? 'claim pending' : 'ineligible'}`
                    : 'Allocated after signed arrival'}
                </small>
              </div>
            ))}
          </details>
        </>
      ) : (
        !state.isError && <output>Loading the journey commitment…</output>
      )}
    </article>
  );
}
