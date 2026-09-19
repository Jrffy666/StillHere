'use client';
import { useState, type SyntheticEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Users, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import type { GratitudeKind, MemberProfile } from '@/lib/types';
import { MemberCommunityLedger, useCommunityRecords } from '@/components/community-records';
import { CommunityNotice } from '@/components/community-notice';
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
            <div><h3>{member.name}</h3><p>Community member · {member.id.slice(0, 8)}</p></div>
          </div>
          <p className="member-bio">{member.bio || 'This member has not added an introduction yet.'}</p>
          <dl className="member-stats">
            <div><dt>Confirmed points</dt><dd>{confirmed?.points ?? '—'}</dd></div>
            <div><dt>Confirmed contributions</dt><dd>{confirmed?.contributions ?? '—'}</dd></div>
            <div><dt>Confirmed banners</dt><dd>{confirmed?.banners ?? '—'}</dd></div>
          </dl>
          {!compact && <CommunityHonors query={records} ownProfile={member.id === viewerId} />}
          <MemberCommunityLedger query={records} compact={compact} />
          {!compact && (
            <>
              {editable && member.id === viewerId && <><CommunityNotice token={token} /><ProfileEditor key={member.id} member={member} token={token} /></>}
            </>
          )}
        </>
      ) : <output>Loading community profile…</output>}
    </section>
  );
}

function ProfileEditor({ member, token }: { member: MemberProfile; token: string }) {
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  async function save(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || draft === null) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const response = await api<{ member: MemberProfile }>('/me/profile', token, { bio: draft });
      cache.setQueryData(['member', member.id, member.id], response);
      setDraft(null); setSaved(true);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return (
    <form className="profile-editor" onSubmit={event => void save(event)}>
      <label className="field-label" htmlFor="member-bio">Your community introduction</label>
      <textarea id="member-bio" value={draft ?? member.bio} maxLength={280} rows={3}
        placeholder="A little about you and how you like to accompany others."
        onChange={event => { setDraft(event.target.value); setSaved(false); }} />
      <p>Your introduction and contributions are always visible to other members. Keep contact details and travel plans out of your introduction.</p>
      <div className="profile-editor-actions"><small>{(draft ?? member.bio).length}/280</small>
        <Button type="submit" disabled={busy || draft === null || draft === member.bio}>{busy ? 'Saving…' : 'Save introduction'}</Button>
      </div>
      {error && <p role="alert" className="inline-error">{error}</p>}
      {saved && <output>Introduction saved.</output>}
    </form>
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
