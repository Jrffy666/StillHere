export interface CommunityEvent {
  journeyId: string;
  sequence: number;
  kind: 'created' | 'assigned' | 'check_in' | 'relay_requested' | 'closed' | 'contribution' | 'gratitude' | 'agent_service';
  actorId: string;
  subjectId: string;
  assignment: number;
  observedAt: number;
  value: number;
}
export interface CommunityRecord {
  id: string;
  event: CommunityEvent;
  points: number;
  reputation: number;
  status: 'pending' | 'submitted' | 'finalized' | 'retry';
  evidence: 'platform_attested';
  network: 'devnet' | 'localnet';
  programId: string | null;
  recordAddress: string | null;
  signature: string | null;
  finalizedAt: number | null;
  error: string | null;
  withdrawn: boolean;
  withdrawal?: CommunityCorrection | null;
}
export interface CommunityTotals {
  points: number; reputation: number; contributions: number; banners: number; history: number;
}
export interface MemberRecordsResponse {
  ledger: {
    memberId: string | null;
    evidence: 'platform_attested';
    network: 'devnet' | 'localnet';
    programId: string | null;
    configured: boolean;
    finalized: CommunityTotals;
    pending: CommunityTotals;
    withdrawn: number;
    records: CommunityRecord[];
    nextCursor: string | null;
  };
  legacy: { points: number; reputation: number; contributions: number; banners: number };
}
export interface JourneyRecordsResponse {
  community: {
    enabled: boolean;
    journeyId: string | null;
    records: CommunityRecord[];
    nextCursor: string | null;
    correction?: CommunityCorrection | null;
  };
}
export interface CommunityCorrection {
  journeyId: string; targetSequence: number; reason: 1 | 2 | 3 | 4;
  sequence: number; observedAt: number; status: CommunityRecord['status'];
  recordAddress: string | null; signature: string | null; finalizedAt: number | null; error: string | null;
}
export const CORRECTION_REASONS = {
  1: 'Incorrect evidence', 2: 'Duplicate identity', 3: 'Invalid authorization', 4: 'Administrative correction',
} as const;

export function communityReceiptUrl(record: CommunityRecord): string | null {
  if (record.network !== 'devnet' || record.status !== 'finalized') return null;
  if (record.recordAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(record.recordAddress)) {
    return `https://explorer.solana.com/address/${record.recordAddress}?cluster=devnet`;
  }
  return null;
}

export function communityRecordLabel(record: CommunityRecord): string {
  switch (record.event.kind) {
    case 'created': return 'Journey opened';
    case 'assigned': return `Guarding assignment ${record.event.assignment} began`;
    case 'check_in': return 'Guardian checked in';
    case 'agent_service': return ['Personal agent began accompanying', 'Personal agent service ended', 'Personal agent became unavailable', 'Human guardian returned after agent service'][record.event.value] ?? 'Personal agent service';
    case 'relay_requested': return 'A human relay was requested';
    case 'closed': return record.event.value === 1 ? 'Rider reported arrival' : record.event.value === 2 ? 'Journey cancelled' : 'Monitoring expired';
    case 'contribution': return 'Guarding contribution';
    case 'gratitude': return ['Appreciation banner', 'Thank you for being there', 'Thank you for listening', 'Thank you for taking over'][record.event.value] ?? 'Appreciation banner';
  }
}
