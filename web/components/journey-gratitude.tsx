'use client';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Check, HeartHandshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { GRATITUDE_LABELS, MemberProfileButton } from '@/components/member-profile';
import { api, errorMessage } from '@/lib/api';
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
  if (dismissed) return <div className="gratitude-dismissed"><span>Your journey is closed.</span><Button variant="ghost" onClick={() => setDismissed(false)}>Leave a free thank-you</Button></div>;
  return (
    <article className="gratitude-card">
      <div className="card-header"><h3><Award size={20} /> Say thank you</h3><span className="mini-tag">FREE</span></div>
      <p>Send an optional free banner to a guardian who checked in. It appears on their public appreciation wall after chain confirmation and adds no points.</p>
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
      <Button variant="ghost" onClick={() => setDismissed(true)}>Done for now</Button>
    </article>
  );
}
