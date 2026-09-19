'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Check, HeartHandshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { GRATITUDE_LABELS, MemberProfileButton } from '@/components/member-profile';
import { api, errorMessage } from '@/lib/api';
import { gratitudeSummary } from '@/lib/journey-layout';
import type { GratitudeKind, JourneyGratitude, Trip } from '@/lib/types';

export function JourneyGratitudeCard({ trip, token, viewerId }: { trip: Trip; token: string; viewerId: string }) {
  const cache = useQueryClient();
  const queryKey = ['gratitude', viewerId, trip.id];
  const gratitude = useQuery({ queryKey,
    queryFn: () => api<{ gratitude: JourneyGratitude }>(`/trips/${trip.id}/gratitude`, token),
    refetchInterval: 15000,
  });
  const [choices, setChoices] = useState<Record<string, GratitudeKind>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const { saved, allSaved } = gratitudeSummary(gratitude.data?.gratitude);
  const pending = gratitude.data?.gratitude.banners.filter(banner => banner.status === 'pending').length ?? 0;
  const regionRef = useRef<HTMLElement>(null);
  const focusedControl = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (focusedControl.current && !focusedControl.current.isConnected && document.activeElement === document.body) {
      const next = regionRef.current?.querySelector<HTMLElement>('[data-gratitude-focus]:not(:disabled)');
      (next || regionRef.current)?.focus();
      focusedControl.current = null;
    }
  }, [allSaved, showSaved, dismissed, busy, error, gratitude.isError, gratitude.data?.gratitude.eligibleGuardians.length]);
  function region(content: ReactNode) {
    return <section ref={regionRef} tabIndex={-1} className="gratitude-region" aria-label="Journey appreciation"
      onFocusCapture={event => { focusedControl.current = event.target; }}
      onBlurCapture={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focusedControl.current = null; }}>
      {content}
    </section>;
  }
  async function send(guardianId: string, kind: GratitudeKind) {
    if (busy) return;
    setBusy(guardianId); setError(''); setNotice('');
    try {
      const response = await api<{ gratitude: JourneyGratitude }>(`/trips/${trip.id}/gratitude`, token, { guardianId, kind });
      cache.setQueryData(queryKey, response);
      await cache.invalidateQueries({ queryKey: ['member'] });
      await cache.invalidateQueries({ queryKey: ['community-records'] });
      await cache.invalidateQueries({ queryKey: ['journey-community'] });
      setNotice(response.gratitude.banners.find(banner => banner.guardianId === guardianId)?.status === 'recorded'
        ? 'Your free banner is saved. The public guarding history shows its separate chain-confirmation status.'
        : 'Your banner is saved. Recording is pending; you can retry safely.');
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(''); }
  }
  if (!gratitude.isError && !error && allSaved && !showSaved) return region(<div className="gratitude-summary">
    <Check size={18} aria-hidden="true" /><div aria-live="polite"><strong>Thank-you {saved === 1 ? 'banner' : 'banners'} sent to {saved} {saved === 1 ? 'guardian' : 'guardians'}</strong>
      <p>Saved. See contribution receipts for chain confirmation.</p></div>
    <Button variant="ghost" data-gratitude-focus onClick={() => { setShowSaved(true); setDismissed(false); }}>View details</Button>
  </div>);
  if (!gratitude.isError && !error && gratitude.data && !gratitude.data.gratitude.eligibleGuardians.length) return region(<p className="gratitude-empty">No checked-in guardians to thank on this journey.</p>);
  if (dismissed && !gratitude.isError && !error) return region(<div className="gratitude-dismissed"><span>{pending ? `${pending} thank-you ${pending === 1 ? 'banner needs' : 'banners need'} recording.` : 'A free thank-you is still available.'}</span><Button variant="ghost" data-gratitude-focus onClick={() => setDismissed(false)}>{pending ? 'Review & retry' : 'Say thank you'}</Button></div>);
  return region(
    <article className="gratitude-card">
      <div className="card-header"><h3><Award size={20} /> Say thank you</h3><span className="mini-tag">FREE</span></div>
      <p>A free banner appears on your guardian’s wall after chain confirmation. It adds no points.</p>
      {gratitude.isError ? <div className="profile-feedback" role="alert"><p>{errorMessage(gratitude.error)}</p><Button variant="outline" onClick={() => void gratitude.refetch()}>Retry</Button></div>
        : gratitude.data ? gratitude.data.gratitude.eligibleGuardians.length ? (
          <div className="gratitude-recipients">
            {gratitude.data.gratitude.eligibleGuardians.map(guardian => {
              const banner = gratitude.data.gratitude.banners.find(item => item.guardianId === guardian.id);
              const kind = banner?.kind ?? choices[guardian.id] ?? 'companionship';
              return (
                <div className="gratitude-recipient" key={guardian.id}>
                  <div className="gratitude-recipient-heading"><strong>{guardian.name}</strong><MemberProfileButton memberId={guardian.id} name={guardian.name} token={token} viewerId={viewerId} /></div>
                  {banner?.status === 'recorded' ? <p className="gratitude-recorded"><Check size={17} /> {GRATITUDE_LABELS[banner.kind]} <span>Sent</span></p>
                    : <div className="gratitude-compose">
                      <NativeSelect aria-label={`Choose a banner for ${guardian.name}`} value={kind} disabled={Boolean(busy || banner)} onChange={event => setChoices(previous => ({ ...previous, [guardian.id]: event.target.value as GratitudeKind }))}>
                        {(Object.keys(GRATITUDE_LABELS) as GratitudeKind[]).map(value => <NativeSelectOption key={value} value={value}>{GRATITUDE_LABELS[value]}</NativeSelectOption>)}
                      </NativeSelect>
                      <Button disabled={Boolean(busy)} onClick={() => void send(guardian.id, kind)}><HeartHandshake size={16} />{busy === guardian.id ? 'Sending…' : banner ? 'Retry recording' : 'Send free banner'}</Button>
                    </div>}
                </div>
              );
            })}
          </div>
        ) : <p>No checked-in guardians to thank on this journey.</p> : <output>Loading your companions…</output>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      {notice && <output>{notice}</output>}
      <Button variant="ghost" data-gratitude-focus disabled={Boolean(busy)} onClick={() => { setShowSaved(false); setDismissed(true); }}>{allSaved ? 'Close details' : 'Maybe later'}</Button>
    </article>
  );
}
