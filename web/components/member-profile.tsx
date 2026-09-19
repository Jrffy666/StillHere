'use client';
import { useId, useState, type SyntheticEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, ArrowUpRight, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import type { GratitudeKind, MemberProfile } from '@/lib/types';
import { MemberCommunityLedger, useCommunityRecords } from '@/components/community-records';
import { CommunityHonors } from '@/components/community-honors';

export const GRATITUDE_LABELS: Record<GratitudeKind, string> = {
  companionship: 'Thank you for being there',
  thoughtfulness: 'Thank you for listening',
  relay: 'Thank you for taking over',
};

export function useMemberProfile(memberId: string | undefined, token: string, viewerId: string) {
  return useQuery({
    queryKey: ['member', viewerId, memberId],
    queryFn: () => api<{ member: MemberProfile }>(`/members/${memberId}`, token),
    enabled: Boolean(memberId),
    refetchInterval: 15000,
  });
}

export function MemberProfileCard({ memberId, token, viewerId, editable = false, compact = false }: {
  memberId: string; token: string; viewerId: string; editable?: boolean; compact?: boolean;
}) {
  const profile = useMemberProfile(memberId, token, viewerId);
  const records = useCommunityRecords(memberId, token, viewerId);
  const confirmed = records.data?.pages[0].ledger.finalized;
  const member = profile.data?.member;
  return (
    <section className={`member-profile ${compact ? 'member-profile-compact' : ''}`} aria-label="Community member profile">
      <div className="member-visibility"><Users size={14} /> Always visible to community members</div>
      {profile.isError ? (
        <div role="alert" className="profile-feedback">
          <p>{errorMessage(profile.error)}</p>
          <Button variant="outline" onClick={() => void profile.refetch()}>Retry profile</Button>
        </div>
      ) : member ? (
        <>
          <div className="member-heading">
            <span className="member-avatar" aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
            <div className="member-identity"><h3>{member.name}</h3><p>Community member · {member.id.slice(0, 8)}</p></div>
            {!compact && editable && member.id === viewerId && <ProfileEditor key={member.id} member={member} token={token} />}
          </div>
          <p className="member-bio">{member.bio || 'This member has not added an introduction yet.'}</p>
          <dl className="member-stats">
            <div><dt>Confirmed points</dt><dd>{confirmed?.points ?? '—'}</dd></div>
            <div><dt>Confirmed contributions</dt><dd>{confirmed?.contributions ?? '—'}</dd></div>
            <div><dt>Confirmed banners</dt><dd>{confirmed?.banners ?? '—'}</dd></div>
          </dl>
          {!compact && <p className="simple-note">These points recognize participation. Each confirmed contribution has a receipt below.</p>}
          {!compact && records.isError && !records.data && <div className="profile-feedback" role="alert"><p>Contribution records could not load.</p><Button variant="outline" onClick={() => void records.refetch()}>Retry contributions</Button></div>}
          {!compact && <CommunityHonors query={records} ownProfile={member.id === viewerId} />}
          {compact ? <MemberCommunityLedger query={records} compact /> : <details className="simple-details">
            <summary>Contribution history & receipts</summary>
            <MemberCommunityLedger query={records} />
          </details>}
        </>
      ) : <output>Loading community profile…</output>}
    </section>
  );
}

function ProfileEditor({ member, token }: { member: MemberProfile; token: string }) {
  const cache = useQueryClient();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(member.bio);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  function changeOpen(next: boolean) {
    if (busy) return;
    if (next) { setDraft(member.bio); setError(''); }
    setOpen(next);
  }
  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || draft === member.bio) return;
    setBusy(true); setError('');
    try {
      const response = await api<{ member: MemberProfile }>('/me/profile', token, { bio: draft });
      await cache.cancelQueries({ queryKey: ['member', member.id, member.id], exact: true });
      cache.setQueryData(['member', member.id, member.id], response);
      setOpen(false);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" className="member-edit" aria-label="Edit your introduction" />}>
        <Pencil size={13} aria-hidden="true" /> Edit
      </DialogTrigger>
      <DialogContent className="profile-edit-dialog" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Edit introduction</DialogTitle>
          <DialogDescription>Your introduction is always visible to community members.</DialogDescription>
        </DialogHeader>
        <form className="profile-editor" onSubmit={event => void save(event)} aria-busy={busy}>
          <label className="field-label" htmlFor={fieldId}>About you</label>
          <textarea id={fieldId} value={draft} maxLength={280} rows={4} disabled={busy}
            aria-describedby={`${fieldId}-hint ${fieldId}-count`}
            placeholder="A little about you and how you like to accompany others."
            onChange={event => setDraft(event.target.value)} />
          <p id={`${fieldId}-hint`}>Keep contact details and travel plans out of your introduction.</p>
          <div className="profile-editor-actions">
            <small id={`${fieldId}-count`}>{draft.length}/280</small>
            <div className="profile-edit-buttons">
              <Button type="button" variant="ghost" disabled={busy} onClick={() => changeOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={busy || draft === member.bio}>{busy ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
          {error && <p role="alert" className="inline-error">{error}</p>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MemberProfileButton({ memberId, name, token, viewerId }: {
  memberId: string; name: string; token: string; viewerId: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" className="profile-link" onClick={() => setOpen(true)}
        aria-label={`View ${name}'s profile and contributions`}>
        View profile <ArrowUpRight size={14} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="community-profile-dialog">
          <DialogHeader><DialogTitle>{name}’s community profile</DialogTitle>
            <DialogDescription>Contribution records are visible to every community member.</DialogDescription>
          </DialogHeader>
          {open && <MemberProfileCard memberId={memberId} token={token} viewerId={viewerId} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
