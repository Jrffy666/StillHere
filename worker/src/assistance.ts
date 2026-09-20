import { z } from 'zod';
import type { Trip, Notification } from './types';

export const ASSISTANCE_NOTICE_VERSION = 'openai-assistance-v1' as const;
export const LIVE_AI_NOTICE_VERSION = 'openai-assistance-v2' as const;
export const aiConsentInputSchema=z.object({consent:z.boolean(),noticeVersion:z.literal(LIVE_AI_NOTICE_VERSION)}).strict();
export const aiConsentSchema=z.object({accepted:z.boolean(),noticeVersion:z.literal(LIVE_AI_NOTICE_VERSION),updatedAt:z.number().int().nonnegative().safe()}).strict();
export type AiConsent = z.infer<typeof aiConsentSchema>;
export const assistanceInputSchema = z.object({
  automatedCheckIns:z.boolean(), timeoutContact:z.boolean(), liveAiConsent:z.boolean(),
  noticeVersion:z.enum([ASSISTANCE_NOTICE_VERSION,LIVE_AI_NOTICE_VERSION]),
}).strict();
export const assistanceSchema = assistanceInputSchema.extend({updatedAt:z.number().int().nonnegative().safe()}).strict();
export type Assistance = z.infer<typeof assistanceSchema>;
export const escalationSchema = z.object({cause:z.enum(['explicit_help','user_authorized_timeout_policy','model_concern']),at:z.number().int().nonnegative().safe(),sourceId:z.string().max(100).optional()}).strict();
export type Escalation = z.infer<typeof escalationSchema>;
export const defaultAssistance = ():Assistance => ({automatedCheckIns:true,timeoutContact:false,liveAiConsent:false,noticeVersion:ASSISTANCE_NOTICE_VERSION,updatedAt:0});
export const assistanceEnabled = (trip:Trip) => (trip.assistance ?? defaultAssistance()).automatedCheckIns;
export function notificationAuthorized(trip:Trip, cause = trip.escalation?.cause):boolean {
  if (!trip.notificationConsent || !trip.emergencyContact) return false;
  return cause === 'explicit_help' || cause === 'user_authorized_timeout_policy' && trip.escalation?.cause === cause && trip.guardMode === 'ai' && assistanceEnabled(trip) && trip.assistance?.timeoutContact === true;
}
export function notificationDispatchAuthorized(trip:Trip, notice:Notification):boolean {
  return trip.demo || notice.cause !== undefined && notificationAuthorized(trip,notice.cause);
}
