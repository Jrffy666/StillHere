import type { CommunityRecord, CommunityTotals, MemberRecordsResponse } from './community';

export type BannerCategory = 'companionship' | 'thoughtfulness' | 'relay' | 'other';
export type BannerFilter = 'all' | BannerCategory;

export const BANNER_CATEGORIES = {
  companionship: { label: 'Companionship', title: 'Thank you for being there', number: '01' },
  thoughtfulness: { label: 'Thoughtfulness', title: 'Thank you for listening', number: '02' },
  relay: { label: 'Human relay', title: 'Thank you for taking over', number: '03' },
  other: { label: 'Appreciation', title: 'A gesture of gratitude', number: '04' },
} as const;

export function bannerCategory(value: number): BannerCategory {
  return value === 1 ? 'companionship' : value === 2 ? 'thoughtfulness' : value === 3 ? 'relay' : 'other';
}

// A member's history also contains gratitude they sent. Only its subject receives it.
// Newest page wins if a polling update overlaps a previously loaded page.
export function receivedBanners(pages: MemberRecordsResponse[]): CommunityRecord[] {
  const memberId = pages[0]?.ledger.memberId;
  if (!memberId) return [];
  const unique = new Map<string, CommunityRecord>();
  for (const page of pages) {
    if (page.ledger.memberId !== memberId) continue;
    for (const record of page.ledger.records) {
      if (!unique.has(record.id)) unique.set(record.id, record);
    }
  }
  return [...unique.values()]
    .filter(record => record.event.kind === 'gratitude'
      && record.event.subjectId === memberId
      && record.status === 'finalized' && !record.withdrawn)
    .sort((a, b) => b.event.observedAt - a.event.observedAt || a.id.localeCompare(b.id));
}

// Display milestones only. No new token, chain event, points, or character rating.
export function communityHonors(confirmed: CommunityTotals) {
  return [
    { id: 'first-watch', title: 'First watch', detail: '1 confirmed contribution',
      current: confirmed.contributions, target: 1, unit: 'contribution' },
    { id: 'first-thanks', title: 'A grateful connection', detail: '1 confirmed banner received',
      current: confirmed.banners, target: 1, unit: 'banner' },
    { id: 'steady-presence', title: 'A steady presence', detail: '5 confirmed contributions',
      current: confirmed.contributions, target: 5, unit: 'contributions' },
  ].map(honor => ({ ...honor, unlocked: honor.current >= honor.target,
    progress: Math.min(honor.target, Math.max(0, honor.current)) }));
}
