import type { PersonalAgentView } from './types';

export function personalAgentPresence(value: PersonalAgentView | null | undefined, now: number) {
  if (!value) return { active: false, ended: true, label: 'Personal agent' };
  const ended = ['revoked', 'expired', 'unavailable', 'ended'].includes(value.status);
  const deadline = Math.min(value.expiresAt, value.lastSeenAt === null ? 0 : value.lastSeenAt + 45_000, value.nextResponseDueAt ?? Infinity);
  const active = value.status === 'active' && now < deadline;
  const labels: Record<PersonalAgentView['status'], string> = {
    requested: 'Awaiting rider permission', approved: 'Ready to connect', connecting: 'Waiting for the first response',
    active: active ? 'Personal agent is here' : 'Agent assistance unavailable',
    revoked: 'Agent permission withdrawn', expired: 'Agent permission expired', unavailable: 'Agent assistance unavailable', ended: 'Agent handoff ended',
  };
  return { active, ended, label: value.expiresAt <= now && !ended ? 'Agent permission expired' : labels[value.status] };
}
