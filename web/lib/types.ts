export interface Person {
  wallet?: string | null;
  id: string;
  name: string;
  simulated?: boolean;
}
export interface GuardRequest {
  id: string;
  kind: 'initial' | 'relay';
  candidate: Person;
  createdAt: number;
  expiresAt: number;
}
export interface RelayRequest {
  id: string;
  requestedBy: Person;
  requestedAt: number;
  expiresAt: number;
}
export interface GuardContribution {
  guardian: Person;
  checkIns: number;
  startedAt: number;
  endedAt: number | null;
  points: number;
  reputation: number;
  rewardStatus: 'pending' | 'credited' | 'ineligible' | 'demo';
}
export interface User {
  communityNoticeVersion?: string | null;
  wallet?: string | null;
  recoveryConfigured?: boolean;
  id: string;
  name: string;
  points: number;
  reputation: number;
  completedGuards: number;
}
export type GratitudeKind = 'companionship' | 'thoughtfulness' | 'relay';
export interface MemberProfile {
  id: string;
  name: string;
  bio: string;
  points: number;
  reputation: number;
  completedGuards: number;
  contributions: { points: number; reputation: number }[];
  gratitude: Record<GratitudeKind, number> & { total: number };
}
export interface JourneyGratitude {
  eligibleGuardians: { id: string; name: string }[];
  banners: {
    guardianId: string;
    kind: GratitudeKind;
    createdAt: number;
    status: 'pending' | 'recorded';
  }[];
}
export interface Session {
  token: string;
  user: User;
}
export interface Place {
  label: string;
  lat: number;
  lng: number;
}
export interface TripSummary {
  riderProfile?: { id: string; name: string } | null;
  chainEnabled?: boolean;
  id: string;
  demo: boolean;
  status: 'open' | 'active' | 'arrived' | 'cancelled';
  createdAt: number;
  checkInIntervalSeconds: number;
  rewardPoints: number;
  requestKind: 'initial' | 'relay' | null;
  requestId: string | null;
  requestExpiresAt: number | null;
  application: { id: string; expiresAt: number } | null;
}
export interface PersonalAgentView {
  id: string; ownerId: string; ownerName: string; agentName: string;
  status: 'requested' | 'approved' | 'connecting' | 'active' | 'revoked' | 'expired' | 'unavailable' | 'ended';
  createdAt: number; expiresAt: number; riderApprovedAt: number | null; connectedAt: number | null;
  lastSeenAt: number | null; lastProcessedAt: number | null; nextResponseDueAt: number | null;
  lastActionAt: number | null; endedAt: number | null; endReason: string | null; connectionIssued: boolean;
  receipts: {id: string; jobId: string; at: number; summary: string; actions: {name: string; outcome: string; detail: string}[]}[];
}
export interface Trip {
  personalAgent?: PersonalAgentView | null;
  personalAgentHistory?: PersonalAgentView[];
  codexDemo?: {id:string;status:'pending'|'consumed'|'cancelled';expiresAt:number}|null;
  assistance?: {automatedCheckIns:boolean;timeoutContact:boolean;liveAiConsent:boolean;noticeVersion:'openai-assistance-v1'|'openai-assistance-v2';updatedAt:number};
  aiConsent?:Record<string,{accepted:boolean;noticeVersion:'openai-assistance-v2';updatedAt:number}>;
  liveAiAvailable?:boolean;
  escalation?: {cause:'explicit_help'|'user_authorized_timeout_policy'|'model_concern';at:number;sourceId?:string};
  agent?: {
    concerns?: {id:string;observedAt:number;receivedAt:number;text:string}[];
    structuredHandoff?: {snapshotAt:number} | null;
    provider: 'mock'|'openai'|'codex_local';
    liveModel: boolean;
    fallbackReason?:string|null;
    semanticHandoff?:{source?:'openai'|'codex_local';model?:string;promptVersion?:string;snapshotAt:number;usage?:{inputTokens:number;outputTokens:number;totalTokens:number}|null;assessment:{findings:{kind:string;topic:string;sourceIds:string[]}[]};context:{messages:{id:string;at:number;role:string;text:string}[];unresolvedConcerns?:{id:string;observedAt:number;text:string}[]}}|null;
    followUpAt: number | null;
    handoffSummary: string | null;
    runs: {
      id: string;
      trigger: { kind: 'takeover' | 'rider-message' | 'follow-up' | 'stale-location' | 'notification-failure' | 'codex-import' };
      status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
      createdAt: number;
      updatedAt: number;
      attempts: number;
      summary?: string;
      error?: string;
      steps: {
        id: string;
        call: { name: string };
        status: 'pending' | 'succeeded' | 'rejected';
        result?: { ok: boolean; code: string; detail: string; context?: { location: { stale: boolean; ageSeconds: number }; messages: unknown[] } };
      }[];
    }[];
  };
  chainEnabled?: boolean;
  privacyExpiresAt?: number | null;
  id: string;
  demo: boolean;
  status: TripSummary['status'];
  rider: { id: string; name: string };
  guardian: { id: string; name: string; simulated?: boolean } | null;
  guardMode: 'waiting' | 'human' | 'ai';
  guardianRequests: GuardRequest[];
  relay: RelayRequest | null;
  contributions: GuardContribution[];
  origin: Place;
  destination: Place;
  location: { lat: number; lng: number; updatedAt: number };
  createdAt: number;
  updatedAt: number;
  checkInIntervalSeconds: number;
  nextCheckInAt: number | null;
  lastGuardianCheckInAt: number | null;
  risk: 'normal' | 'attention' | 'urgent';
  ai: { mode: 'rules' | 'openai' | 'codex_local'; lastAssessment: string };
  messages: {
    automatedBy?:'rules'|'openai'|'codex_local'|'personal_agent';
    id: string;
    at: number;
    senderId: string;
    senderName: string;
    role: 'rider' | 'guardian' | 'agent' | 'system';
    text: string;
  }[];
  events: {
    id: string;
    at: number;
    type: string;
    title: string;
    detail: string;
  }[];
  notifications: {
    id: string;
    at: number;
    status: 'queued' | 'sent' | 'failed' | 'acknowledged' | 'simulated';
    channel: 'webhook' | 'demo' | 'none';
    message: string;
    detail: string;
  }[];
  reward: {
    points: number;
    reputation: number;
    status: 'pending' | 'credited' | 'demo' | 'ineligible';
  };
  shareUrl?: string;
  emergencyContact?: { name: string; contact: string };
  notificationConsent: boolean;
}
export interface TripList {
  trips: TripSummary[];
  myTrips: (Trip | TripSummary)[];
}
export const PLACES: Place[] = [
  { label: 'University of Waterloo', lat: 43.4723, lng: -80.5449 },
  { label: 'Waterloo Public Square', lat: 43.463, lng: -80.5221 },
  { label: 'Conestoga Mall', lat: 43.4974, lng: -80.5283 },
  { label: 'Kitchener City Hall', lat: 43.4516, lng: -80.4936 },
  { label: 'Wilfrid Laurier University', lat: 43.4738, lng: -80.5275 },
];
