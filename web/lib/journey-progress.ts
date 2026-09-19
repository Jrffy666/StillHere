import type { Trip } from './types';

// Application participation only. On-chain confirmation comes from community receipts.
export function journeyProgress(trip: Pick<Trip, 'demo' | 'status' | 'guardian' | 'contributions'>) {
  const checkedGuardians = trip.contributions.filter(item => !item.guardian.simulated && item.checkIns > 0);
  const currentCheckIns = trip.contributions.find(item => item.guardian.id === trip.guardian?.id)?.checkIns ?? 0;
  return {
    currentCheckIns,
    checkedGuardians: checkedGuardians.length,
    firstCheckInNeeded: !trip.demo && trip.status === 'active' && Boolean(trip.guardian) && currentCheckIns === 0,
    noContributionAtArrival: !trip.demo && trip.status === 'arrived' && checkedGuardians.length === 0,
  };
}
