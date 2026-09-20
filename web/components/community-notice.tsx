'use client';
import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Globe2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { api, errorMessage } from '@/lib/api';
import type { User } from '@/lib/types';

export const COMMUNITY_NOTICE_VERSION = 'community-v1';

export function useCommunityNotice(token: string) {
  const query = useQuery({
    queryKey: ['community-notice', token],
    queryFn: () => api<{ user: User }>('/me', token),
    staleTime: 15000,
  });
  return { ...query, accepted: query.data?.user.communityNoticeVersion === COMMUNITY_NOTICE_VERSION };
}

export function CommunityNotice({ token }: { token: string }) {
  const notice = useCommunityNotice(token);
  const cache = useQueryClient();
  const id = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    if (!checked || busy) return;
    setBusy(true); setError('');
    try {
      await api('/me/community-notice', token, { version: COMMUNITY_NOTICE_VERSION });
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['community-notice', token] }),
        cache.invalidateQueries({ queryKey: ['me'] }),
      ]);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  if (notice.accepted) return (
    <p className="community-notice-accepted"><Check size={15} /> Public community records enabled. No wallet or payment needed.</p>
  );
  return (
    <section className="community-notice" aria-label="Public community records">
      <h4><Globe2 size={18} /> A shared record of being there</h4>
      <p>New journeys, guarding contributions and any thank-you banners you send are published on Solana Devnet under community identifiers. These records are public beyond this website and may remain after you delete your account.</p>
      <p>Your route, messages and contact details stay off chain. Identifiers and timing can still link participation. StillHere pays publication costs and signs platform attestations; these are not your wallet signature or proof of someone’s character.</p>
      <label className="consent-row" htmlFor={id}>
        <Checkbox id={id} checked={checked} onCheckedChange={value => setChecked(Boolean(value))} disabled={busy} />
        <span>I understand that my new community participation and recognition records will be public.</span>
      </label>
      {notice.isError ? <div role="alert"><p>{errorMessage(notice.error)}</p><Button type="button" variant="outline" onClick={() => void notice.refetch()}>Retry</Button></div>
        : <Button type="button" variant="outline" disabled={!checked || busy || notice.isPending} onClick={() => void accept()}>{busy ? 'Saving…' : 'Continue with public records'}</Button>}
      {error && <p role="alert" className="inline-error">{error}</p>}
    </section>
  );
}
