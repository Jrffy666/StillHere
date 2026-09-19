'use client';
import { useId, useState } from 'react';
import Image from 'next/image';
import { Award, Check, ExternalLink, HeartHandshake, LockKeyhole, MessageCircleHeart, Repeat2, ShieldCheck, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { useCommunityRecords } from '@/components/community-records';
import { communityReceiptUrl, type CommunityRecord } from '@/lib/community';
import { BANNER_CATEGORIES, bannerCategory, communityHonors, receivedBanners, type BannerFilter } from '@/lib/honors';

const CATEGORY_ICONS = { companionship: HeartHandshake, thoughtfulness: MessageCircleHeart, relay: Repeat2, other: Award };
const HONOR_ICONS = [ShieldCheck, HeartHandshake, Sparkles];

export function CommunityHonors({ query, ownProfile }: {
  query: ReturnType<typeof useCommunityRecords>; ownProfile: boolean;
}) {
  const [filter, setFilter] = useState<BannerFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const uid = useId();
  const ledger = query.data?.pages[0]?.ledger;
  if (!ledger) return null; // The shared ledger renders loading and initial error states.
  const honors = communityHonors(ledger.finalized);
  const received = receivedBanners(query.data!.pages);
  const visible = expanded ? received.filter(record => filter === 'all' || bannerCategory(record.event.value) === filter) : received.slice(0, 3);
  const unlocked = honors.filter(honor => honor.unlocked).length;
  const filters: BannerFilter[] = ['all', 'companionship', 'thoughtfulness', 'relay'];
  if (received.some(record => bannerCategory(record.event.value) === 'other')) filters.push('other');

  return <div className="community-showcase">
    {query.isError && <div className="honors-refresh-error" role="alert">
      <p>Recognition could not refresh. These are previously loaded records.</p>
      <Button variant="outline" onClick={() => void query.refetch()}>Refresh recognition</Button>
    </div>}
    <section className="honor-cabinet" aria-labelledby={`${uid}-honors`}>
      <div className="collection-heading">
        <h4 id={`${uid}-honors`}>Honor cabinet</h4>
        <span className="collection-count"><Award size={15} aria-hidden="true" /> {unlocked} of {honors.length} recognized</span>
      </div>
      <ul className="honor-grid">
        {honors.map((honor, index) => {
          const Icon = HONOR_ICONS[index];
          return <li key={honor.id} className={`honor-tile ${honor.unlocked ? 'honor-earned' : 'honor-locked'}`}>
            <Icon className="honor-symbol" size={22} strokeWidth={1.5} aria-hidden="true" />
            <div className="honor-copy"><h5>{honor.title}</h5><p>{honor.detail}</p></div>
            <span className="honor-state">
              {honor.unlocked ? <Check size={13} aria-hidden="true" /> : <LockKeyhole size={12} aria-hidden="true" />}
              <span className="sr-only">{honor.unlocked ? 'Recognized' : 'Not yet reached'}: </span>
              <span>{honor.progress}/{honor.target}</span>
            </span>
            <progress value={honor.progress} max={honor.target} aria-label={`${honor.title}: ${honor.progress} of ${honor.target} ${honor.unit}`} />
          </li>;
        })}
      </ul>
      <p className="collection-footnote">Based on confirmed records. Milestones add no points and are not separate on-chain awards.</p>
    </section>

    <section className="banner-wall" aria-labelledby={`${uid}-banners`}>
      <div className="collection-heading">
        <div>
          <h4 id={`${uid}-banners`}>Appreciation wall</h4>
        </div>
        <div className="banner-wall-controls"><span className="collection-count">{ledger.finalized.banners} confirmed {ledger.finalized.banners === 1 ? 'banner' : 'banners'}</span>
      {(received.length > 0 || (ledger.finalized.banners > 0 && query.hasNextPage)) && <Button variant="ghost" className="banner-wall-toggle" aria-expanded={expanded} aria-controls={`${uid}-collection`}
        onClick={() => { setExpanded(!expanded); setFilter('all'); }}>
        {expanded ? 'Show less' : 'View all banners'}
      </Button>}
        </div>
      </div>
      {expanded && ledger.finalized.banners > 0 && <fieldset className="banner-filters">
        <legend className="sr-only">Filter appreciation banners</legend>
        {filters.map(category => <Button key={category} variant="ghost" className="banner-filter"
          aria-pressed={filter === category} onClick={() => setFilter(category)}>
          {category === 'all' ? 'All banners' : BANNER_CATEGORIES[category].label}
        </Button>)}
      </fieldset>}
      {ledger.pending.banners > 0 && <output className="banner-pending">
        {ledger.pending.banners} received {ledger.pending.banners === 1 ? 'banner is' : 'banners are'} awaiting chain confirmation. {ownProfile ? 'Your' : 'This'} wall updates after confirmation.
      </output>}
      <div id={`${uid}-collection`}>
      {visible.length ? <ul className={expanded ? 'banner-wall-grid' : 'banner-preview-grid'}>
        {visible.map(record => <BannerCard key={record.id} record={record} compact={!expanded} />)}
      </ul> : <div className="banner-empty-compact">
        <HeartHandshake size={20} strokeWidth={1.5} aria-hidden="true" />
        <p>{ledger.finalized.banners === 0
          ? 'No banners yet. Free thank-you banners appear here after chain confirmation.'
          : query.hasNextPage ? expanded ? 'Load earlier records to find more banners.' : 'Banners are in earlier records. Open the full wall to load them.' : 'No matching banners in the loaded records.'}</p>
      </div>}
      {(visible.length > 0 || expanded) && <div className="banner-wall-footer">
        <p aria-live="polite">{expanded ? `${visible.length} displayed` : `${visible.length} recent banners shown`}{query.hasNextPage ? ' from loaded records.' : expanded || received.length <= 3 ? ' · All records loaded.' : '.'}</p>
        {expanded && query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? 'Loading earlier records…' : 'Load earlier records'}
        </Button>}
      </div>}
      </div>
      {ledger.withdrawn > 0 && <p className="collection-footnote">Withdrawn recognition stays in the community record below and is excluded from this collection.</p>}
    </section>
  </div>;
}

function BannerCard({ record, compact = false }: { record: CommunityRecord; compact?: boolean }) {
  const category = bannerCategory(record.event.value);
  const presentation = BANNER_CATEGORIES[category];
  const Icon = CATEGORY_ICONS[category];
  const receipt = communityReceiptUrl(record);
  const date = new Date(record.event.observedAt * 1000);
  if (compact) return <li className="banner-preview-card">
    <Image src="/images/honors-pennant.png" alt="" width={80} height={120} unoptimized loading="lazy" />
    <div><span className="banner-confirmed"><ShieldCheck size={12} aria-hidden="true" />{record.network === 'devnet' ? 'Devnet confirmed' : 'Localnet confirmed'}</span>
      <h5>{presentation.title}</h5>
      <p>From {record.event.actorId.slice(0, 8)} · <time dateTime={date.toISOString()}>{date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} UTC</time></p>
      {receipt && <a href={receipt} target="_blank" rel="noopener noreferrer" aria-label={`View ${presentation.label.toLowerCase()} banner receipt`}>View receipt <ExternalLink size={12} aria-hidden="true" /></a>}
    </div>
  </li>;
  return <li className={`gratitude-exhibit gratitude-exhibit-${category}`}>
    <figure>
      <div className="gratitude-art">
        <Image src="/images/honors-pennant.png" alt="" width={1024} height={1536} unoptimized loading="lazy" />
        <div className="gratitude-inscription">
          <Icon size={28} strokeWidth={1.4} aria-hidden="true" />
          <span>{presentation.label}</span>
          <h5>{presentation.title}</h5>
          <i>SAFETY GUARD</i>
        </div>
      </div>
      <figcaption>
        <span className="banner-confirmed"><ShieldCheck size={13} aria-hidden="true" /> {record.network === 'devnet' ? 'Devnet confirmed' : 'Localnet confirmed'}</span>
        <div className="banner-giver"><span>From community member</span><code>{record.event.actorId.slice(0, 8)}…{record.event.actorId.slice(-4)}</code></div>
        <time dateTime={date.toISOString()}>{date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })} · UTC</time>
        <div className="banner-receipt-row"><span>Given freely</span>{receipt && <a href={receipt} target="_blank" rel="noopener noreferrer" aria-label={`View ${presentation.label.toLowerCase()} banner receipt`}>View receipt <ExternalLink size={13} aria-hidden="true" /></a>}</div>
        <details className="banner-dedication"><summary>Dedication details</summary>
          <p>Platform-attested appreciation · No points awarded.</p>
          <dl><dt>From community reference</dt><dd>{record.event.actorId}</dd>
            <dt>To community reference</dt><dd>{record.event.subjectId}</dd>
            <dt>Journey reference</dt><dd>{record.event.journeyId}</dd></dl>
        </details>
      </figcaption>
    </figure>
  </li>;
}
