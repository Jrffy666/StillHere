import type { AgentState } from './agent';
export interface Person { id: string; name: string; simulated?: boolean; wallet?: string | null }
export interface User extends Person { points: number; reputation: number; completedGuards: number; recoveryConfigured?: boolean; bio?: string; communityNoticeVersion?: string | null }
export type GratitudeKind = 'companionship' | 'thoughtfulness' | 'relay';
export interface CommunityMember {
  id: string; name: string; bio: string; points: number; reputation: number; completedGuards: number;
  contributions: {points:number;reputation:number}[];
  gratitude: {total:number;companionship:number;thoughtfulness:number;relay:number};
}
export interface GratitudeView {
  eligibleGuardians: {id:string;name:string}[];
  banners: {guardianId:string;kind:GratitudeKind;createdAt:number;status:'pending'|'recorded'}[];
}
export interface Place { label: string; lat: number; lng: number }
export interface TripMessage {
  id: string; at: number; senderId: string; senderName: string;
  role: 'rider' | 'guardian' | 'agent' | 'system'; text: string;
}
export interface TripEvent { id: string; at: number; type: string; title: string; detail: string }
export interface Notification {
  id: string; at: number;
  status: 'queued' | 'sent' | 'failed' | 'acknowledged' | 'simulated';
  channel: 'webhook' | 'demo' | 'none'; message: string; detail: string;
}
export interface GuardianRequest {
  id: string; kind: 'initial' | 'relay'; candidate: Person; createdAt: number; expiresAt: number;
}
export interface GuardianRelay { id: string; requestedBy: Person; requestedAt: number; expiresAt: number }
export interface GuardianContribution {
  guardian: Person; checkIns: number; startedAt: number; endedAt: number | null;
  points: number; reputation: number; rewardStatus: 'pending' | 'credited' | 'ineligible' | 'demo';
}
export interface Trip {
  agent?: AgentState;
  chainEnabled?: boolean; privacyExpiresAt?: number | null;
  id: string; demo: boolean; status: 'open' | 'active' | 'arrived' | 'cancelled';
  rider: Person; guardian: Person | null; guardMode: 'waiting' | 'human' | 'ai';
  guardianRequests: GuardianRequest[]; relay: GuardianRelay | null; contributions: GuardianContribution[];
  origin: Place; destination: Place; location: { lat: number; lng: number; updatedAt: number };
  createdAt: number; updatedAt: number; checkInIntervalSeconds: number;
  nextCheckInAt: number | null; lastGuardianCheckInAt: number | null;
  risk: 'normal' | 'attention' | 'urgent';
  ai: { mode: 'rules' | 'openai'; lastAssessment: string };
  messages: TripMessage[]; events: TripEvent[]; notifications: Notification[];
  reward: { points: number; reputation: number; status: 'pending' | 'credited' | 'demo' | 'ineligible' };
  shareUrl?: string; emergencyContact?: { name: string; contact: string }; notificationConsent: boolean;
}
export interface TripSummary {
  chainEnabled?: boolean;
  riderProfile?: {id:string;name:string} | null;
  id: string; demo: boolean; status: Trip['status']; createdAt: number;
  checkInIntervalSeconds: number; rewardPoints: number;
  requestKind: 'initial' | 'relay' | null; requestId: string | null; requestExpiresAt: number | null;
  application: { id: string; expiresAt: number } | null;
}
export interface CreateTrip {
  chainEnabled?: boolean;
  origin: Place; destination: Place; shareUrl?: string; checkInIntervalSeconds: number;
  emergencyContact?: {name: string; contact: string}; notificationConsent: boolean;
}
export interface TripAction {
  action: 'accept' | 'withdraw-application' | 'approve-guardian' | 'reject-guardian' | 'request-relay' | 'cancel-relay' | 'check-in' | 'takeover' | 'resume' | 'arrive' | 'cancel' | 'help' | 'message' | 'location' | 'simulate';
  requestId?: string; text?: string; lat?: number; lng?: number;
  scenario?: 'guardian-offline' | 'route-deviation' | 'stale-location' | 'notification-failure';
}
export type Outcome<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
export const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
export const fail = (status: number, error: string): Outcome<never> => ({ ok: false, status, error });
export const summary = (trip: Trip, viewerId?: string): TripSummary => {
  const now = Date.now();
  const requestKind = trip.demo ? null
    : trip.status === 'open' && trip.createdAt + 86400000 > now ? 'initial'
    : trip.status === 'active' && trip.relay && trip.relay.expiresAt > now ? 'relay' : null;
  const application = viewerId && requestKind ? trip.guardianRequests.find(item => item.candidate.id === viewerId && item.kind === requestKind && item.expiresAt > now) : undefined;
  return {
    chainEnabled: Boolean(trip.chainEnabled),
    riderProfile: {id:trip.rider.id,name:trip.rider.name},
    id: trip.id, demo: trip.demo, status: trip.status, createdAt: trip.createdAt,
    checkInIntervalSeconds: trip.checkInIntervalSeconds, rewardPoints: trip.reward.points,
    requestKind, requestId: requestKind === 'initial' ? trip.id : requestKind === 'relay' ? trip.relay!.id : null,
    requestExpiresAt: requestKind === 'initial' ? trip.createdAt + 86400000 : requestKind === 'relay' ? trip.relay!.expiresAt : null,
    application: application ? {id: application.id, expiresAt: application.expiresAt} : null,
  };
};
export const isClosed = (trip: Trip) => trip.status === 'arrived' || trip.status === 'cancelled';
export const isParticipant = (trip: Trip, id: string) => trip.rider.id === id || trip.guardian?.id === id;
export type WorkerEnv = Omit<Env,'SOLANA_PRIVATE_RPC_URL'|'COMMUNITY_ISSUER_SECRET_KEY'|'COMMUNITY_SPONSOR_SECRET_KEY'> & {
  OPENAI_API_KEY?: string; NOTIFICATION_WEBHOOK_URL?: string; NOTIFICATION_WEBHOOK_SECRET?: string;
  NOTIFICATION_ACK_SECRET?: string; ELEVENLABS_API_KEY?: string;
  OPERATOR_SECRET?: string;
  SOLANA_PRIVATE_RPC_URL?: string;
  COMMUNITY_ISSUER_SECRET_KEY?: string; COMMUNITY_SPONSOR_SECRET_KEY?: string;
};
