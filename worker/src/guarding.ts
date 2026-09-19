import type { Trip } from './types';

/** Freeze one reward pool once. Check-in frequency and repeated handoffs cannot enlarge it. */
export function allocateContributions(trip: Trip, now = Date.now(),memberRefs?:Record<string,string>): void {
  const eligible = trip.contributions.filter(item => item.checkIns > 0 && !item.guardian.simulated)
    .sort((a, b) => (memberRefs?.[a.guardian.id]??a.guardian.id).localeCompare(memberRefs?.[b.guardian.id]??b.guardian.id));
  for (const contribution of trip.contributions) {
    contribution.endedAt ??= now;
    const index = eligible.indexOf(contribution);
    const rewarded = !trip.demo && trip.status === 'arrived' && index >= 0;
    contribution.points = rewarded ? Math.floor(25 / eligible.length) + (index < 25 % eligible.length ? 1 : 0) : 0;
    contribution.reputation = rewarded ? Math.floor(10 / eligible.length) + (index < 10 % eligible.length ? 1 : 0) : 0;
    contribution.rewardStatus = trip.demo ? 'demo' : rewarded ? 'pending' : 'ineligible';
  }
  trip.reward.status = trip.demo ? 'demo' : trip.status === 'arrived' && eligible.length ? 'pending' : 'ineligible';
}
