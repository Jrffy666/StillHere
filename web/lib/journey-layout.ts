import type { JourneyGratitude, Trip } from './types';

// Compact only a current, checked-in human assignment with nothing to review.
export function canCompactRelay(trip: Pick<Trip, 'status' | 'guardMode' | 'guardian' | 'risk' | 'contributions' | 'lastGuardianCheckInAt' | 'nextCheckInAt' | 'relay' | 'guardianRequests'>, now: number) {
  return trip.status === 'active' && trip.guardMode === 'human' && Boolean(trip.guardian)
    && trip.risk === 'normal' && Boolean(trip.lastGuardianCheckInAt)
    && trip.nextCheckInAt !== null && trip.nextCheckInAt > now
    && trip.contributions.some(item => item.guardian.id === trip.guardian?.id && item.checkIns > 0)
    && !(trip.relay && trip.relay.expiresAt > now)
    && !trip.guardianRequests.some(request => request.expiresAt > now);
}

// "recorded" is application delivery, not blockchain confirmation.
export function gratitudeSummary(gratitude: JourneyGratitude | undefined) {
  const eligible = gratitude?.eligibleGuardians ?? [];
  const saved = eligible.filter(guardian => gratitude?.banners.some(banner => banner.guardianId === guardian.id && banner.status === 'recorded')).length;
  return { saved, allSaved: eligible.length > 0 && saved === eligible.length };
}
