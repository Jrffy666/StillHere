import { DurableObject } from 'cloudflare:workers';
import { directoryName } from './accounts';
import { allocateContributions } from './guarding';
import { ruleAssessment, sendNotification } from './integrations';
import { hasAgentConcern, buildAgentHandoff, renderAgentSummary, renderAgentCheckIn, redactAgentText, parseAgentToolCall, type AgentContext, type AgentRun, type AgentToolCall, type AgentToolResult, type AgentTrigger } from './agent';
import { createMockProvider, runProviderDecision, AGENT_PROVIDER_LEASE_MS } from './agent-provider';
import { assistanceInputSchema, defaultAssistance, assistanceEnabled, notificationAuthorized, notificationDispatchAuthorized, aiConsentInputSchema, LIVE_AI_NOTICE_VERSION } from './assistance';
import { canUseLiveAi, openAiAvailable, liveAiContext, nextSemanticDecision, MAX_JOURNEY_AI_REQUESTS, MAX_JOURNEY_AI_RESERVED_TOKENS, AI_REQUEST_COOLDOWN_MS } from './ai-runtime';
import { prepareOpenAIRequest, runOpenAIAssessmentWithDeadline, OpenAIProviderError } from './openai-provider';
import { validateSemanticAssessment, renderSemanticQuestion } from './agent-semantic';
import type { ChainMember, ChainSnapshot } from './chain-types';
import { tripSnapshotSchema } from './snapshots';
import { captureCommunityEvents, randomCommunityReference, type SourceCommunityState, type SourceCommunityEvent } from './community-events';
import type { CommunityRecordView, CommunityCorrectionView } from './community-types';
import { fail, isClosed, isParticipant, ok, summary, type CreateTrip, type Notification, type Outcome, type Person, type Trip, type TripAction, type TripSummary, type WorkerEnv, type GratitudeKind, type GratitudeView } from './types';

interface StoredTrip {
  paidAiBudget?: {requests:number;reservedTokens:number;inputTokens:number;outputTokens:number;totalTokens:number;lastRequestAt:number};
  providerBudget?: {decisions:number;inputChars:number;runs:Record<string,{decisions:number;inputChars:number}>};
  community?:SourceCommunityState;
  communityEvents?:SourceCommunityEvent[];
  gratitude?: {id:string;guardianId:string;kind:GratitudeKind;createdAt:number;status:'pending'|'recorded'|'cancelled';nextAttemptAt:number;inFlightUntil:number}[];
  chainApplications?: Record<string, {candidate:Person;revoked:boolean}>;
  chainSequence?: number;
  chainSlot?: number;
  closedAt?: number;
  schemaVersion: number;
  trip: Trip;
  rewardEligible: boolean;
  staleAlerted: boolean;
  lastNotificationAt: number;
  monitoringStartedAt: number | null;
  indexVersion: number;
  indexedVersion: number;
  assessmentVersion: number;
  aiNextCheckInAt: number | null;
  aiMissedCheckIns: number;
  automatedEscalationSent: boolean;
  notificationJobs: Record<string, {attempts:number;retryAt:number;inFlightUntil:number}>;
}
const agent: Person = {id:'agent',name:'Safety Guard'};
const pendingRun = (run: AgentRun) => run.status === 'queued' || run.status === 'running';

export class TripRoom extends DurableObject<WorkerEnv> {
  private providerCalls = new Map<string,{revision:number;attempt:number;controller:AbortController}>();
  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS trip_state (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS erased (id INTEGER PRIMARY KEY CHECK(id = 1), at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS community_source (sequence INTEGER PRIMARY KEY,data TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 0,retry_at INTEGER NOT NULL DEFAULT 0)');
  }
  private load(): StoredTrip | null {
    const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM trip_state WHERE id = 1').toArray()[0];
    if (!row) return null;
    const state = {schemaVersion:1,monitoringStartedAt:null,indexVersion:1,indexedVersion:0,assessmentVersion:0,aiNextCheckInAt:null,aiMissedCheckIns:0,automatedEscalationSent:false,...JSON.parse(row.data)} as StoredTrip;
    state.trip.assistance ??= defaultAssistance();
    state.trip.liveAiAvailable=openAiAvailable(this.env);
    if (state.trip.relay) {
      const person = state.trip.relay.requestedBy;
      state.trip.relay.requestedBy = {id:person.id,name:person.name,...(person.wallet?{wallet:person.wallet}:{}),...(person.simulated?{simulated:true}:{})};
    }
    if (state.schemaVersion < 2) {
      const trip = state.trip;
      trip.guardianRequests = []; trip.relay = null;
      trip.contributions = trip.guardian ? [{guardian:trip.guardian,checkIns:state.rewardEligible || trip.reward.status === 'credited' ? 1 : 0,
        startedAt:state.monitoringStartedAt ?? trip.createdAt,endedAt:isClosed(trip) ? trip.updatedAt : null,
        points:trip.reward.status === 'credited' ? trip.reward.points : 0,reputation:trip.reward.status === 'credited' ? trip.reward.reputation : 0,
        rewardStatus:trip.reward.status}] : [];
      if (isClosed(trip) && trip.reward.status !== 'credited') allocateContributions(trip,trip.updatedAt,state.community?.members);
      state.schemaVersion = 2; state.indexVersion += 1; this.save(state);
    }
    if (isClosed(state.trip) && !state.closedAt) { state.closedAt=state.trip.updatedAt;this.save(state); }
    return state;
  }
  private save(state: StoredTrip): void {
    if(this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)throw new Error('Private journey data has been erased.');
    if (isClosed(state.trip) && !state.closedAt) state.closedAt = Date.now();
    state.trip.privacyExpiresAt = state.closedAt ? state.closedAt + (state.trip.demo ? 7 : 30) * 86400000 : null;
    state.trip.updatedAt = Date.now();
    state.trip.events = state.trip.events.slice(-200);
    state.trip.messages = state.trip.messages.slice(-150);
    if (state.trip.agent) {
      const harness = state.trip.agent;
      if (isClosed(state.trip) || state.trip.guardMode !== 'ai' || !assistanceEnabled(state.trip)) harness.followUpAt = null;
      for (const run of harness.runs.filter(pendingRun)) {
        if (isClosed(state.trip) || state.trip.guardMode !== 'ai' || !assistanceEnabled(state.trip) || run.revision !== state.assessmentVersion) {
          run.status = 'cancelled'; run.leaseUntil = 0; run.updatedAt = Date.now();
          run.error = 'The journey ended, human monitoring resumed, or newer participant input superseded this run.';
        }
      }
      harness.runs = harness.runs.slice(-20);
      for (const [id, call] of this.providerCalls) {
        const run = harness.runs.find(item=>item.id===id);
        if (!run || !pendingRun(run) || run.revision!==call.revision || run.attempts!==call.attempt) call.controller.abort();
      }
      if (state.providerBudget) for (const id of Object.keys(state.providerBudget.runs)) if (!harness.runs.some(run=>run.id===id)) delete state.providerBudget.runs[id];
    }
    if (!assistanceEnabled(state.trip)) state.aiNextCheckInAt = null;
    this.ctx.storage.transactionSync(()=>{
      const old=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM trip_state WHERE id=1').toArray()[0];
      const events=captureCommunityEvents(old?JSON.parse(old.data) as StoredTrip:null,state);
      for(const event of events)this.ctx.storage.sql.exec('INSERT INTO community_source(sequence,data) VALUES(?,?)',event.sequence,JSON.stringify(event));
      this.ctx.storage.sql.exec('INSERT OR REPLACE INTO trip_state VALUES (1,?)', JSON.stringify(state));
    });
  }
  private async deliverCommunity():Promise<void> {
    const rows=this.ctx.storage.sql.exec<{sequence:number;data:string}>('SELECT sequence,data FROM community_source WHERE delivered=0 ORDER BY sequence LIMIT 32').toArray();
    if(!rows.length)return;
    const retry=this.ctx.storage.sql.exec<{retry_at:number}>('SELECT retry_at FROM community_source WHERE sequence=?',rows[0].sequence).one().retry_at;
    if(retry>Date.now())return;
    const events=rows.map(row=>JSON.parse(row.data) as SourceCommunityEvent);
    for(const row of rows)this.ctx.storage.sql.exec('UPDATE community_source SET retry_at=? WHERE sequence=?',Date.now()+30000,row.sequence);
    await this.schedule();
    try {
      const accepted=await this.env.COMMUNITY.getByName(`journey:${events[0].journeyId}`).append(events);
      if(!accepted.ok)throw new Error('Community publication intent was not accepted');
      for(const row of rows)this.ctx.storage.sql.exec('UPDATE community_source SET delivered=1,retry_at=0 WHERE sequence=?',row.sequence);
    }catch{
      for(const row of rows)this.ctx.storage.sql.exec('UPDATE community_source SET retry_at=? WHERE sequence=? AND delivered=0',Date.now()+60000,row.sequence);
    }
  }
  async readCommunity(userId:string,cursor?:string):Promise<Outcome<{enabled:boolean;journeyId:string|null;records:CommunityRecordView[];nextCursor:string|null;correction:CommunityCorrectionView|null}>> {
    const state=this.load();if(!state)return fail(404,'Journey not found.');
    if(!isParticipant(state.trip,userId)&&!state.trip.contributions.some(item=>item.guardian.id===userId))return fail(403,'Only journey participants can inspect this record link.');
    if(!state.community)return ok({enabled:false,journeyId:null,records:[],nextCursor:null,correction:null});
    await this.deliverCommunity();await this.schedule();
    if(!this.load())return fail(410,'Private journey link has been erased.');
    const ledger=await this.env.COMMUNITY.getByName(`journey:${state.community.journeyId}`).journey(state.community.journeyId,cursor);
    if(!ledger.ok)return ledger;
    return ok({enabled:true,journeyId:state.community.journeyId,...ledger.value});
  }
  private event(trip: Trip, type: string, title: string, detail: string): void {
    trip.events.push({id:crypto.randomUUID(),at:Date.now(),type,title,detail});
  }
  private message(trip: Trip, person: Person, role: Trip['messages'][number]['role'], text: string): void {
    trip.messages.push({id:crypto.randomUUID(),at:Date.now(),senderId:person.id,senderName:person.name,role,text});
  }
  private async schedule(): Promise<void> {
    const state = this.load(),now = Date.now();
    const source=this.ctx.storage.sql.exec<{retryAt:number|null}>('SELECT MIN(retry_at) AS retryAt FROM community_source WHERE delivered=0').one();
    if(!state){if(source.retryAt!==null)await this.ctx.storage.setAlarm(Math.max(now+100,source.retryAt));else await this.ctx.storage.deleteAlarm();return;}
    const trip = state.trip;
    const times: number[] = [];
    if(source.retryAt!==null)times.push(source.retryAt);
    if (trip.privacyExpiresAt) times.push(trip.privacyExpiresAt);
    if (!isClosed(trip)) {
      // Unclaimed trips expire; active trips are bounded to six hours.
      times.push(trip.status === 'open' ? trip.createdAt + 86400000 : (state.monitoringStartedAt ?? trip.createdAt) + 6 * 3600000);
      if (trip.nextCheckInAt !== null) times.push(trip.nextCheckInAt);
      if (trip.guardMode === 'ai' && state.aiNextCheckInAt !== null) times.push(state.aiNextCheckInAt);
      if (trip.guardMode === 'ai' && trip.agent?.followUpAt) times.push(trip.agent.followUpAt);
      for (const run of trip.agent?.runs.filter(pendingRun) ?? []) times.push(Math.max(run.nextAttemptAt, run.leaseUntil));
      if (!state.staleAlerted && trip.status === 'active') times.push(trip.location.updatedAt + 120000);
      if (trip.relay) times.push(trip.relay.expiresAt);
      times.push(...trip.guardianRequests.map(item => item.expiresAt));
    }
    if (!trip.chainEnabled && trip.status === 'arrived' && trip.reward.status === 'pending') times.push(now + 15000);
    if (state.indexVersion !== state.indexedVersion) times.push(now + 15000);
    for (const job of Object.values(state.notificationJobs)) times.push(Math.max(job.retryAt, job.inFlightUntil));
    for (const entry of state.gratitude??[])if(entry.status==='pending')times.push(Math.max(entry.nextAttemptAt,entry.inFlightUntil));
    if (times.length) await this.ctx.storage.setAlarm(Math.max(now + 100, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }
  async initialize(id: string, rider: Person, input: CreateTrip, demo: boolean): Promise<Outcome<Trip>> {
    if (this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length) return fail(410,'This trip was erased.');
    if (this.load()) return fail(409,'Trip already exists.');
    const identity=demo?null:await this.env.USERS.getByName(rider.id).communityIdentity();
    if(this.load())return fail(409,'Trip already exists.');
    const now = Date.now();
    const trip: Trip = {
      id,demo,chainEnabled:!demo && Boolean(input.chainEnabled),status:demo?'active':'open',rider,guardian:demo?{id:`demo-${id}`,name:'Alex',simulated:true}:null,
      assistance:defaultAssistance(),
      guardianRequests:[],relay:null,contributions:[],
      guardMode:demo?'human':'waiting',origin:input.origin,destination:input.destination,
      location:{lat:input.origin.lat,lng:input.origin.lng,updatedAt:now},createdAt:now,updatedAt:now,
      checkInIntervalSeconds:input.checkInIntervalSeconds,nextCheckInAt:demo?now + input.checkInIntervalSeconds * 1000:null,
      lastGuardianCheckInAt:demo?now:null,risk:'normal',
      ai:{mode:'rules',lastAssessment:'Waiting for a check-in. Rules-based monitoring is available.'},
      agent:{provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null},messages:[],events:[],notifications:[],
      reward:{points:25,reputation:10,status:'pending'},shareUrl:input.shareUrl,emergencyContact:input.emergencyContact,notificationConsent:input.notificationConsent,
    };
    this.event(trip,'created',demo?'Demo trip started':'Guard request created',demo?'Alex is a simulated guardian. Trips, notifications, and rewards are clearly marked as a demo.':'Only your assigned guardian can access the private trip.');
    if (demo) this.message(trip,trip.guardian!,'guardian','Hi! I am Alex, your simulated guardian for this demo. I will check in while you head home.');
    this.save({schemaVersion:2,trip,rewardEligible:false,staleAlerted:false,lastNotificationAt:0,notificationJobs:{},monitoringStartedAt:demo?now:null,indexVersion:1,indexedVersion:0,assessmentVersion:0,aiNextCheckInAt:null,aiMissedCheckIns:0,automatedEscalationSent:false,
      ...(identity?{community:{journeyId:randomCommunityReference(),members:{[rider.id]:identity.memberId},sequence:0,assignment:0,guardians:[]}}:{})});
    await this.schedule();
    await this.env.GOVERNANCE.getByName('governance-v1').registerTrip(id);
    await this.schedule(); await this.syncIndexes();await this.deliverCommunity(); await this.schedule(); return ok(trip);
  }
  private expire(state: StoredTrip): boolean {
    const trip = state.trip, now = Date.now(); let changed = false;
    const deadline = trip.status === 'open' ? trip.createdAt + 86400000 : (state.monitoringStartedAt ?? trip.createdAt) + 6 * 3600000;
    if (!isClosed(trip) && now >= deadline) {
      trip.status = 'cancelled'; trip.nextCheckInAt = null; state.aiNextCheckInAt = null;
      allocateContributions(trip,now,state.community?.members); changed = true;
      this.event(trip,'expired','Trip monitoring expired','The maximum monitoring period ended. Start a new trip if needed.');
    }
    if (trip.relay && (isClosed(trip) || trip.relay.expiresAt <= now)) {
      if (!isClosed(trip)) this.event(trip,'relay-expired','Replacement request expired','The current guardian assignment and monitoring mode have not changed. A participant can request another replacement.');
      trip.relay = null; changed = true;
    }
    const previous = trip.guardianRequests.length;
    trip.guardianRequests = trip.guardianRequests.filter(item => !isClosed(trip) && item.expiresAt > now
      && (item.kind === 'initial' ? trip.status === 'open' : Boolean(trip.relay)));
    if (trip.guardianRequests.length !== previous) changed = true;
    if (changed) { state.indexVersion += 1; state.assessmentVersion += 1; }
    return changed;
  }
  private visible(userId: string): Outcome<Trip | TripSummary> {
    const state = this.load(); if (!state) return fail(404,'Trip not found.');
    if (isParticipant(state.trip,userId)) return ok(state.trip);
    const redacted = summary(state.trip,userId);
    return redacted.requestKind ? ok(redacted) : fail(403,'This trip is private.');
  }
  async read(userId: string): Promise<Outcome<Trip | TripSummary>> {
    const state = this.load(); if (!state) return fail(404,'Trip not found.');
    if (state.trip.privacyExpiresAt && state.trip.privacyExpiresAt <= Date.now()) { await this.purge(); return fail(410,'Private trip data has expired.'); }
    if (this.expire(state)) { this.save(state); await this.schedule(); }
    // Re-read authorization after asynchronous storage work; an old guardian may have been replaced.
    return this.visible(userId);
  }
  private gratitudeAccess(userId:string):Outcome<StoredTrip> {
    const state=this.load();if(!state)return fail(404,'Trip not found.');
    if(state.trip.rider.id!==userId)return fail(403,'Only the rider can view or send gratitude for this journey.');
    if(state.trip.privacyExpiresAt&&state.trip.privacyExpiresAt<=Date.now())return fail(410,'Private trip data has expired.');
    if(!isClosed(state.trip)||state.trip.demo)return fail(409,'Gratitude is available after a real journey ends, including cancellation.');
    return ok(state);
  }
  private eligibleGratitude(state:StoredTrip):{id:string;name:string}[] {
    const trip=state.trip;
    return [...new Map(trip.contributions.filter(item=>item.checkIns>0&&!item.guardian.simulated&&item.guardian.id!==trip.rider.id
      && (!state.community||state.community.guardians.some(slot=>slot.checkedIn&&slot.memberId===state.community!.members[item.guardian.id])))
      .map(item=>[item.guardian.id,{id:item.guardian.id,name:item.guardian.name}])).values()];
  }
  async readGratitude(userId:string):Promise<Outcome<GratitudeView>> {
    const access=this.gratitudeAccess(userId);if(!access.ok)return access;
    const available=new Map<string,{id:string;name:string}>();
    for(const guardian of this.eligibleGratitude(access.value)) {
      if((await this.env.GOVERNANCE.getByName('governance-v1').status(guardian.id)).deleted)continue;
      const profile=await this.env.USERS.getByName(guardian.id).communityProfile();
      if(profile)available.set(guardian.id,{id:profile.id,name:profile.name});
    }
    const current=this.gratitudeAccess(userId);if(!current.ok)return current;
    const eligibleGuardians=this.eligibleGratitude(current.value).flatMap(item=>available.has(item.id)?[available.get(item.id)!]:[]);
    const ids=new Set(eligibleGuardians.map(item=>item.id));
    const banners:GratitudeView['banners']=(current.value.gratitude??[]).flatMap(item=>item.status!=='cancelled'&&ids.has(item.guardianId)
      ?[{guardianId:item.guardianId,kind:item.kind,createdAt:item.createdAt,status:item.status}]:[]);
    return ok({eligibleGuardians,banners});
  }
  async sendGratitude(userId:string,guardianId:string,kind:GratitudeKind):Promise<Outcome<GratitudeView>> {
    if(!['companionship','thoughtfulness','relay'].includes(kind))return fail(400,'Choose a supported gratitude banner.');
    let access=this.gratitudeAccess(userId);if(!access.ok)return access;
    if(!this.eligibleGratitude(access.value).some(item=>item.id===guardianId))return fail(409,'Thank a guardian with a check-in recorded during their accepted assignment. Late aggregate history cannot authorize new recognition.');
    const [riderStatus,guardianStatus,recipient]=await Promise.all([
      this.env.GOVERNANCE.getByName('governance-v1').status(userId),this.env.GOVERNANCE.getByName('governance-v1').status(guardianId),
      this.env.USERS.getByName(guardianId).communityProfile(),
    ]);
    if(riderStatus.deleted||guardianStatus.deleted||!recipient)return fail(409,'This participant is unavailable.');
    if(access.value.community){
      const journal=await this.env.COMMUNITY.getByName(`journey:${access.value.community.journeyId}`).journey(access.value.community.journeyId);
      if(journal.ok&&journal.value.correction?.status==='finalized')return fail(409,'Recognition for this journey was withdrawn by a published correction.');
    }
    access=this.gratitudeAccess(userId);if(!access.ok)return access;
    if(!this.eligibleGratitude(access.value).some(item=>item.id===guardianId))return fail(409,'This guardian is no longer eligible.');
    const state=access.value;state.gratitude??=[];
    const previous=state.gratitude.find(item=>item.guardianId===guardianId);
    if(previous&&(previous.kind!==kind||previous.status==='cancelled'))return fail(409,'A gratitude banner has already been chosen for this guardian.');
    if(!previous) {
      state.gratitude.push({id:crypto.randomUUID(),guardianId,kind,createdAt:Date.now(),status:'pending',nextAttemptAt:Date.now(),inFlightUntil:0});
      this.save(state);
    }
    // Persist a wake-up before contacting another object. Retrying uses the same durable receipt ID.
    await this.schedule();await this.deliverGratitude();await this.deliverCommunity();await this.schedule();
    return this.readGratitude(userId);
  }
  private async deliverGratitude():Promise<void> {
    const entries=(this.load()?.gratitude??[]).filter(item=>item.status==='pending').map(item=>item.id);
    for(const id of entries) {
      let state=this.load();if(!state)return;
      let entry=state.gratitude?.find(item=>item.id===id);
      if(!entry||entry.status!=='pending'||Math.max(entry.nextAttemptAt,entry.inFlightUntil)>Date.now())continue;
      if(!isClosed(state.trip)||state.trip.demo||!this.eligibleGratitude(state).some(item=>item.id===entry!.guardianId)) {
        entry.status='cancelled';this.save(state);continue;
      }
      entry.inFlightUntil=Date.now()+30000;this.save(state);await this.schedule();
      try {
        const recipientStatus=await this.env.GOVERNANCE.getByName('governance-v1').status(entry.guardianId);
        const riderStatus=await this.env.GOVERNANCE.getByName('governance-v1').status(state.trip.rider.id);
        state=this.load();entry=state?.gratitude?.find(item=>item.id===id);
        if(!state||!entry||entry.status!=='pending')continue;
        if(recipientStatus.deleted||riderStatus.deleted){entry.status='cancelled';entry.inFlightUntil=0;this.save(state);continue;}
        const accepted=await this.env.USERS.getByName(entry.guardianId).recordGratitude(entry.id,entry.kind,entry.createdAt,Boolean(state.community));
        state=this.load();entry=state?.gratitude?.find(item=>item.id===id);
        if(!state||!entry||entry.status!=='pending')continue;
        entry.status=accepted?'recorded':'cancelled';entry.inFlightUntil=0;this.save(state);
      } catch {
        state=this.load();entry=state?.gratitude?.find(item=>item.id===id);
        if(state&&entry?.status==='pending'){entry.inFlightUntil=0;entry.nextAttemptAt=Date.now()+60000;this.save(state);}
      }
    }
  }
  private openRelay(state: StoredTrip, requestedBy: Person): void {
    const trip = state.trip;
    if (trip.demo || trip.status !== 'active' || trip.relay) return;
    const now = Date.now();
    trip.guardianRequests = [];
    trip.relay = {id:crypto.randomUUID(),requestedBy:{id:requestedBy.id,name:requestedBy.name,...(requestedBy.wallet?{wallet:requestedBy.wallet}:{})},requestedAt:now,expiresAt:now + 10 * 60000};
    state.indexVersion += 1;
    this.event(trip,'relay-requested','Looking for a replacement guardian','The rider will approve a replacement. The current assignment remains until approval.');
  }
  private guardianCheckIn(state: StoredTrip): void {
    const trip = state.trip, guardian = trip.guardian;
    if (!guardian) return;
    let contribution = trip.contributions.find(item => item.guardian.id === guardian.id);
    if (!contribution) {
      contribution = {guardian,checkIns:0,startedAt:Date.now(),endedAt:null,points:0,reputation:0,rewardStatus:'pending'};
      trip.contributions.push(contribution);
    }
    contribution.checkIns += 1; state.rewardEligible = true;
  }
  private queueNotification(state: StoredTrip, message: string, forceFailure = false): void {
    if (!state.trip.demo && !notificationAuthorized(state.trip)) return;
    if (!forceFailure && Date.now() - state.lastNotificationAt < 30000) return;
    state.lastNotificationAt = Date.now();
    const notice: Notification = {id:crypto.randomUUID(),at:Date.now(),cause:state.trip.escalation?.cause,status:forceFailure?'failed':'queued',channel:state.trip.demo?'demo':'none',message,
      detail:forceFailure?'Simulated provider failure. No message was sent.':'Waiting for the notification provider.'};
    state.trip.notifications.push(notice);
    if (!forceFailure) state.notificationJobs[notice.id] = {attempts:0,retryAt:Date.now(),inFlightUntil:0};
    this.event(state.trip,'notification',forceFailure?'Notification failed':'Escalation queued',forceFailure?'Demo scenario: contact someone you trust directly.':'Delivery and acknowledgement will be tracked separately.');
  }
  private takeover(state: StoredTrip, reason: string, requestedBy: Person = agent): void {
    state.trip.guardMode = 'ai'; state.trip.nextCheckInAt = null;
    state.aiNextCheckInAt = assistanceEnabled(state.trip) ? Date.now() + Math.max(60,state.trip.checkInIntervalSeconds) * 1000 : null;
    state.aiMissedCheckIns = 0;
    if (state.trip.status === 'open') { state.trip.status = 'active'; state.monitoringStartedAt = Date.now(); state.indexVersion += 1; }
    this.openRelay(state,requestedBy);
    if (state.trip.risk === 'normal') state.trip.risk = 'attention';
    if (!assistanceEnabled(state.trip)) {
      this.event(state.trip,'takeover','Guardian unavailable',`${reason} Automated check-ins are disabled. Replacement recruitment remains open.`);
      return;
    }
    this.event(state.trip,'takeover','Scheduled check-ins active',reason);
    const text = 'Your guardian has not confirmed availability. I am continuing check-ins using automated monitoring. Are you okay? Human help is not guaranteed; you can contact someone you trust at any time.';
    this.message(state.trip,agent,'agent',text);
    state.trip.ai = {mode:'rules',lastAssessment:text};
    this.queueAgent(state,'takeover');
  }

  private queueAgent(state: StoredTrip, kind: AgentTrigger['kind'], eventId = crypto.randomUUID(), messageId?: string): void {
    if (isClosed(state.trip) || state.trip.guardMode !== 'ai' || !assistanceEnabled(state.trip)) return;
    const harness = state.trip.agent ??= {provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null};
    if (harness.runs.some(run => run.trigger.id === eventId)) return;
    const now = Date.now();
    harness.runs.push({id:crypto.randomUUID(),trigger:{id:eventId,kind,at:now,...(messageId?{messageId}:{})},provider:'mock',
      status:'queued',createdAt:now,updatedAt:now,revision:state.assessmentVersion,steps:[],attempts:0,nextAttemptAt:now,leaseUntil:0});
  }

  private agentContext(state: StoredTrip): AgentContext {
    const trip = state.trip, now = Date.now();
    const ageSeconds = Math.max(0, Math.floor((now - trip.location.updatedAt) / 1000));
    return {now,status:trip.status,guardMode:trip.guardMode,risk:trip.risk,
      location:{updatedAt:trip.location.updatedAt,ageSeconds,stale:ageSeconds >= 120 || trip.location.updatedAt > now},
      messages:trip.messages.slice(-12).map(({id,at,role,text}) => ({id,at,role,text:redactAgentText(text,800)})),
      relayOpen:Boolean(trip.relay && trip.relay.expiresAt > now),
      notifications:trip.notifications.slice(-5).map(({id,status,detail}) => ({id,status,detail:detail.slice(0,500)})),
      contactAvailable:Boolean(trip.notificationConsent && trip.emergencyContact),
      escalationCause:trip.escalation?.cause ?? null,notificationAuthorized:notificationAuthorized(trip),
      unresolvedConcerns:trip.agent?.concerns ?? []};
  }

  /** Tools are scoped to this object. No tool can invoke participant actions or wallet operations. */
  private executeAgentTool(state: StoredTrip, call: AgentToolCall, run:AgentRun): AgentToolResult {
    const trip = state.trip;
    if (call.name !== 'get_journey_context' && !run.steps.some(step=>step.call.name==='get_journey_context' && step.status==='succeeded' && step.result?.context)) return {ok:false,code:'context_required',detail:'A successful current context read is required before any action.'};
    switch (call.name) {
      case 'get_journey_context': return {ok:true,code:'context_read',detail:'Read bounded private journey context at this timestamp.',context:this.agentContext(state)};
      case 'send_check_in':
        // Interpretation selects a server question; arbitrary provider prose is never published.
        {
          const live=Boolean(run.semantic)&&canUseLiveAi(this.env,trip);
          const text=live?renderSemanticQuestion(run.semantic!.assessment,run.semantic!.context):renderAgentCheckIn(run.trigger,this.agentContext(state));
          this.message(trip,agent,'agent',text);trip.messages.at(-1)!.automatedBy=live?'openai':'rules';
          if (trip.risk !== 'urgent') trip.ai = {mode:live?'openai':'rules',lastAssessment:text};
        }
        return {ok:true,code:'check_in_posted',detail:'Posted an automated message in this journey. This does not confirm anyone read it.'};
      case 'schedule_follow_up': {
        const due = Date.now() + call.arguments.delaySeconds * 1000;
        trip.agent!.followUpAt = Math.min(trip.agent!.followUpAt ?? due, due, state.aiNextCheckInAt ?? due);
        return {ok:true,code:'follow_up_scheduled',detail:'A server follow-up was scheduled without postponing baseline monitoring.'};
      }
      case 'request_human_relay':
        if (trip.demo) return {ok:true,code:'demo_relay',detail:'Demo only: a replacement would be requested. No real guardian was recruited.'};
        if (trip.relay && trip.relay.expiresAt > Date.now()) return {ok:true,code:'relay_already_open',detail:'Recruitment is already open. Rider approval is still required.'};
        if (trip.status !== 'active') return {ok:false,code:'relay_unavailable',detail:'Only an active journey can request a replacement.'};
        this.openRelay(state,agent);
        return {ok:true,code:'relay_requested',detail:'Opened recruitment. No guardian was approved or given private access.'};
      case 'notify_trusted_contact': {
        if (!trip.notificationConsent || !trip.emergencyContact) return {ok:false,code:'consent_required',detail:'No current consent and configured trusted contact. No notification was queued.'};
        if (!notificationAuthorized(trip)) return {ok:false,code:'explicit_concern_required',detail:'A model inference alone cannot trigger external contact notifications.'};
        if (trip.notifications.length) return {ok:true,code:'notification_already_exists',detail:'An existing notification owns delivery and retry. No second notification was queued.'};
        const count = trip.notifications.length;
        this.queueNotification(state,trip.escalation?.cause==='explicit_help'?'A journey participant requested help in Safety Guard. Please try to contact the rider.':'The rider authorized a notification after unanswered check-ins. Connectivity may be unavailable.');
        return trip.notifications.length > count
          ? {ok:true,code:'notification_queued',detail:'Queued a notification for the configured contact. Check notification status for delivery; no receipt is assumed.'}
          : {ok:true,code:'notification_rate_limited',detail:'A recent notification already covers this interval. No duplicate was queued.'};
      }
    }
  }

  /** Reserve once before network I/O; uncertain attempts are never paid again after eviction. */
  private async analyzeWithOpenAI(runId:string,attempt:number):Promise<void> {
    let state=this.load();if(!state)return;
    let run=state.trip.agent?.runs.find(item=>item.id===runId);
    if(!run||run.status!=='running'||run.attempts!==attempt||run.semanticAttempt||!canUseLiveAi(this.env,state.trip))return;
    const authorityContext=this.agentContext(state),id=crypto.randomUUID();
    const budget=state.paidAiBudget??={requests:0,reservedTokens:0,inputTokens:0,outputTokens:0,totalTokens:0,lastRequestAt:0};
    let reservedTokens:number,context:AgentContext;
    try{({reservedTokens,context}=prepareOpenAIRequest({model:this.env.OPENAI_MODEL,context:liveAiContext(state.trip,authorityContext)}));}
    catch {run.semanticAttempt={id,status:'failed',reservedTokens:0,error:'AI_INPUT_LIMIT'};Object.assign(state.trip.agent!,{fallbackReason:'AI_INPUT_LIMIT',provider:'mock',liveModel:false});this.save(state);return;}
    if(budget.requests>=MAX_JOURNEY_AI_REQUESTS||budget.reservedTokens+reservedTokens>MAX_JOURNEY_AI_RESERVED_TOKENS||Date.now()-budget.lastRequestAt<AI_REQUEST_COOLDOWN_MS){
      run.semanticAttempt={id,status:'failed',reservedTokens:0,error:'AI_JOURNEY_BUDGET_OR_COOLDOWN'};Object.assign(state.trip.agent!,{fallbackReason:'AI_JOURNEY_BUDGET_OR_COOLDOWN',provider:'mock',liveModel:false});this.save(state);return;
    }
    run.semanticAttempt={id,status:'reserved',reservedTokens};run.leaseUntil=Date.now()+AGENT_PROVIDER_LEASE_MS;
    budget.requests++;budget.reservedTokens+=reservedTokens;budget.lastRequestAt=Date.now();
    const controller=new AbortController(),activeCall={revision:run.revision,attempt,controller};this.providerCalls.set(runId,activeCall);
    this.save(state);
    let outcome:Awaited<ReturnType<typeof runOpenAIAssessmentWithDeadline>>|undefined;
    let failure:string|undefined,usage:import('./agent').ModelUsage|undefined;
    try {
      await this.schedule();
      const reservation=await this.env.GOVERNANCE.getByName('governance-v1').reserveAiBudget(id,reservedTokens);
      state=this.load();if(!state)return;this.expire(state);this.save(state);
      run=state.trip.agent?.runs.find(item=>item.id===runId);
      if(!reservation.allowed)failure='AI_GLOBAL_BUDGET';
      else if(!run||run.status!=='running'||run.attempts!==attempt||run.revision!==state.assessmentVersion||run.leaseUntil<=Date.now()||!canUseLiveAi(this.env,state.trip)||controller.signal.aborted||this.agentContextChanged(authorityContext,this.agentContext(state)))failure='AI_SUPERSEDED';
      else {
        run.leaseUntil=Date.now()+AGENT_PROVIDER_LEASE_MS;this.save(state);
        outcome=await runOpenAIAssessmentWithDeadline({apiKey:this.env.OPENAI_API_KEY!,model:this.env.OPENAI_MODEL,context,signal:controller.signal});
        usage=outcome.usage;
      }
    } catch(error) {
      failure=error instanceof OpenAIProviderError?error.code:'AI_UNAVAILABLE';
      usage=error instanceof OpenAIProviderError?error.usage:undefined;
    } finally {if(this.providerCalls.get(runId)===activeCall)this.providerCalls.delete(runId);}
    state=this.load();if(!state)return;this.expire(state);this.save(state);
    run=state.trip.agent?.runs.find(item=>item.id===runId);
    if(!run||run.semanticAttempt?.id!==id)return;
    if(usage){run.semanticAttempt.usage=usage;const ledger=state.paidAiBudget!;ledger.inputTokens+=usage.inputTokens;ledger.outputTokens+=usage.outputTokens;ledger.totalTokens+=usage.totalTokens;}
    if(run.status!=='running'||run.attempts!==attempt||run.revision!==state.assessmentVersion||run.leaseUntil<=Date.now()||!canUseLiveAi(this.env,state.trip)||controller.signal.aborted||this.agentContextChanged(authorityContext,this.agentContext(state))){
      run.semanticAttempt.status='discarded';run.semanticAttempt.error='AI_SUPERSEDED';this.save(state);return;
    }
    if(outcome&&!failure){
      const assessment=validateSemanticAssessment(outcome.assessment,context);
      run.semantic={...outcome,assessment,context,snapshotAt:context.now};run.semanticAttempt.status='completed';run.provider='openai';
      const harness=state.trip.agent!;harness.provider='openai';harness.liveModel=true;harness.fallbackReason=null;harness.concerns??=[];
      for(const finding of assessment.findings.filter(item=>item.kind==='concern'))for(const sourceId of finding.sourceIds){
        if(!sourceId.startsWith('message:'))continue;
        const source=context.messages.find(item=>`message:${item.id}`===sourceId&&item.role==='rider');
        if(source&&!harness.concerns.some(item=>item.id===source.id)&&harness.concerns.length<8)harness.concerns.push({id:source.id,observedAt:source.at,receivedAt:Date.now(),text:redactAgentText(source.text)});
      }
      this.event(state.trip,'ai-assessment','AI interpretation recorded','Source references passed validation. Interpretations are uncertain; no notification or community recognition is authorized by this result.');
    } else {
      run.semanticAttempt.status='failed';run.semanticAttempt.error=failure??'AI_UNAVAILABLE';
      state.trip.agent!.fallbackReason=run.semanticAttempt.error;state.trip.agent!.provider='mock';state.trip.agent!.liveModel=false;
      this.event(state.trip,'ai-fallback','Rules-based assistance continued','The AI request could not be used. Existing check-ins, human controls and explicit help remain available.');
    }
    this.save(state);
  }

  /** Persist a proposal before executing it; persist each local effect and result in one SQL write. */
  private async runAgent(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      let state = this.load(); if (!state) return;
      this.save(state);
      const run = state.trip.agent?.runs.find(item => pendingRun(item) && item.nextAttemptAt <= Date.now() && item.leaseUntil <= Date.now());
      if (!run) return;
      if (run.attempts >= 3 || Date.now() - run.createdAt > 600000) {
        run.status = 'failed'; run.error = 'Run retry or age limit reached. Baseline monitoring remains active.';
        run.updatedAt = Date.now(); this.save(state); continue;
      }
      if(run.semanticAttempt?.status==='reserved'){
        run.semanticAttempt.status='failed';run.semanticAttempt.error='AI_INTERRUPTED';
        Object.assign(state.trip.agent!,{fallbackReason:'AI_INTERRUPTED',provider:'mock',liveModel:false});
      }
      run.status = 'running'; run.attempts += 1; run.leaseUntil = Date.now() + AGENT_PROVIDER_LEASE_MS; run.updatedAt = Date.now();
      const attempt = run.attempts;
      this.save(state); await this.schedule();
      try {
        for (let turn = 0; turn < 10; turn++) {
          state = this.load(); if (!state) return;
          this.expire(state); this.save(state);
          let current = state.trip.agent?.runs.find(item => item.id === run.id);
          if (!current || current.status !== 'running' || current.attempts !== attempt || current.leaseUntil <= Date.now()) break;
          const previousContext = current.steps.find(item => item.call.name === 'get_journey_context' && item.status === 'succeeded')?.result?.context;
          if (previousContext && this.agentContextChanged(previousContext,this.agentContext(state))) {
            current.status = 'cancelled'; current.leaseUntil = 0; current.updatedAt = Date.now();
            current.error = 'Location freshness, risk, consent, or notification status changed. A new context check was queued.';
            this.queueAgent(state,current.trigger.kind,`${current.id}:refresh`,current.trigger.messageId);
            this.save(state); break;
          }
          if(previousContext&&current.steps.length===1&&!current.semanticAttempt&&canUseLiveAi(this.env,state.trip)){
            await this.analyzeWithOpenAI(current.id,attempt);continue;
          }
          let step = current.steps.find(item => item.status === 'pending');
          if (!step) {
            const budget = state.providerBudget ??= {decisions:0,inputChars:0,runs:{}};
            const runBudget = budget.runs[current.id] ??= {decisions:0,inputChars:0};
            const inputChars = JSON.stringify({trigger:current.trigger,steps:current.steps}).length;
            if (budget.decisions >= 240 || budget.inputChars + inputChars > 1200000 || runBudget.decisions >= 24 || runBudget.inputChars + inputChars > 120000) {
              current.status='failed';current.leaseUntil=0;current.error='Provider decision budget exhausted. Baseline monitoring remains active.';
              this.save(state);break;
            }
            budget.decisions++;budget.inputChars+=inputChars;runBudget.decisions++;runBudget.inputChars+=inputChars;
            current.leaseUntil=Date.now()+AGENT_PROVIDER_LEASE_MS;
            const controller = new AbortController();
            const activeCall = {revision:current.revision,attempt,controller};
            this.providerCalls.set(current.id,activeCall);
            this.save(state);await this.schedule();
            const decision = await (current.semantic&&canUseLiveAi(this.env,state.trip)
              ?Promise.resolve(nextSemanticDecision(current,this.agentContext(state)))
              :runProviderDecision({provider:createMockProvider(),trigger:current.trigger,steps:current.steps,signal:controller.signal}))
              .finally(()=>{if(this.providerCalls.get(run.id)===activeCall)this.providerCalls.delete(run.id);});
            state = this.load(); if (!state) return;
            this.expire(state); this.save(state);
            current = state.trip.agent?.runs.find(item => item.id === run.id);
            if (!current || current.status !== 'running' || current.attempts !== attempt || current.leaseUntil <= Date.now()) break;
            if (previousContext && this.agentContextChanged(previousContext,this.agentContext(state))) {
              current.status = 'cancelled'; current.leaseUntil = 0; current.updatedAt = Date.now();
              current.error = 'Journey context changed while a decision was pending. A new context check was queued.';
              this.queueAgent(state,current.trigger.kind,`${current.id}:refresh`,current.trigger.messageId);
              this.save(state); break;
            }
            if (decision.type === 'complete') {
              current.status = 'completed'; current.leaseUntil = 0; current.updatedAt = Date.now();
              const context=this.agentContext(state);
              current.summary = renderAgentSummary(current.steps,context); state.trip.agent!.handoffSummary = current.summary;
              state.trip.agent!.structuredHandoff = buildAgentHandoff(current.steps,context);
              if(current.semantic){
                state.trip.agent!.semanticHandoff=current.semantic;
                current.summary='OpenAI interpretations and complete source excerpts are available in the private AI interpretation panel.\n'+current.summary.replace('Offline mock run (rule inference, no LLM)','Server execution record for an OpenAI-assisted run').slice(0,3800);
                state.trip.agent!.handoffSummary=current.summary;state.trip.agent!.structuredHandoff!.mode='openai_assisted';
              }else{
                state.trip.agent!.provider='mock';state.trip.agent!.liveModel=false;
              }
              this.event(state.trip,'agent-run',current.semantic?'AI-assisted run completed':'Offline agent run completed',current.semantic?'Validated interpretations and actual tool results are available in the private handoff.':'Tool results and a handoff summary are available. No live language model was used.');
              this.save(state); break;
            }
            const call = parseAgentToolCall(decision.call);
            if (current.steps.length >= 8 || current.steps.some(item => item.call.name === call.name)) throw new Error('Tool budget exceeded');
            step = {id:`${current.id}:${current.steps.length}`,call,status:'pending',at:Date.now()};
            current.steps.push(step); this.save(state);
          }
          // Revalidate persisted calls after eviction; no await occurs between authorization, effect, and result.
          let call: AgentToolCall;
          try { call = parseAgentToolCall(step.call); }
          catch {
            step.status = 'rejected'; step.result = {ok:false,code:'invalid_arguments',detail:'The tool proposal did not match the allowlisted schema.'};
            current.status = 'failed'; current.error = 'Invalid tool proposal rejected.'; current.leaseUntil = 0;
            this.save(state); break;
          }
          if (current.steps.filter(item => item.call.name === call.name && item.status !== 'pending').length || current.steps.length > 8) throw new Error('Repeated tool rejected');
          step.result = this.executeAgentTool(state,call,current);
          step.status = step.result.ok ? 'succeeded' : 'rejected'; current.updatedAt = Date.now();
          this.save(state);
        }
      } catch {
        state = this.load(); if (!state) return;
        const current = state.trip.agent?.runs.find(item => item.id === run.id);
        if (current?.status === 'running' && current.attempts === attempt) {
          current.status = current.attempts >= 3 ? 'failed' : 'queued'; current.leaseUntil = 0;
          current.nextAttemptAt = Date.now() + 5000 * current.attempts; current.updatedAt = Date.now();
          current.error = 'The offline agent could not finish this attempt. Baseline monitoring remains active.';
          this.save(state);
        }
      }
      await this.schedule();
    }
  }

  private agentContextChanged(before: AgentContext, after: AgentContext): boolean {
    const notices = (context: AgentContext) => context.notifications.map(item => `${item.id}:${item.status}`).join('|');
    return before.location.stale !== after.location.stale || before.risk !== after.risk
      || before.contactAvailable !== after.contactAvailable || before.notificationAuthorized !== after.notificationAuthorized
      || before.escalationCause !== after.escalationCause || notices(before) !== notices(after);
  }
  async setAssistance(userId:string,input:unknown):Promise<Outcome<Trip>> {
    const parsed=assistanceInputSchema.safeParse(input);if(!parsed.success)return fail(400,'Invalid assistance settings.');
    let state=this.load();if(!state)return fail(404,'Journey not found.');
    if(state.trip.rider.id!==userId)return fail(403,'Only the rider can change assistance settings.');
    this.expire(state);if(isClosed(state.trip)){this.save(state);return fail(409,'This journey is closed.');}
    const wasEnabled=assistanceEnabled(state.trip);
    state.trip.assistance={...parsed.data,updatedAt:Date.now()};state.assessmentVersion++;
    state.trip.aiConsent??={};state.trip.aiConsent[userId]={accepted:parsed.data.liveAiConsent&&parsed.data.noticeVersion===LIVE_AI_NOTICE_VERSION,noticeVersion:LIVE_AI_NOTICE_VERSION,updatedAt:Date.now()};
    if(state.trip.agent){state.trip.agent.handoffSummary=null;state.trip.agent.structuredHandoff=null;state.trip.agent.semanticHandoff=null;state.trip.agent.provider='mock';state.trip.agent.liveModel=false;}
    if (!wasEnabled && parsed.data.automatedCheckIns && state.trip.guardMode==='ai') {
      state.aiNextCheckInAt=Date.now()+Math.max(60,state.trip.checkInIntervalSeconds)*1000;state.aiMissedCheckIns=0;
    }
    this.event(state.trip,'assistance-settings','Assistance preferences updated','Model processing requires server activation and current processing consent. Notification authority remains separate.');
    this.save(state);await this.schedule();await this.deliverNotifications();await this.schedule();
    state=this.load();return state?ok(state.trip):fail(410,'Private journey data has been erased.');
  }
  async setAiConsent(userId:string,input:unknown):Promise<Outcome<Trip>> {
    const parsed=aiConsentInputSchema.safeParse(input);if(!parsed.success)return fail(400,'Invalid AI processing choice.');
    const state=this.load();if(!state)return fail(404,'Journey not found.');
    if(!isParticipant(state.trip,userId))return fail(403,'Only current participants may change their own AI processing choice.');
    this.expire(state);if(isClosed(state.trip)){this.save(state);return fail(409,'This journey is closed.');}
    state.trip.aiConsent??={};state.trip.aiConsent[userId]={accepted:parsed.data.consent,noticeVersion:LIVE_AI_NOTICE_VERSION,updatedAt:Date.now()};
    if(state.trip.rider.id===userId)state.trip.assistance={...(state.trip.assistance??defaultAssistance()),liveAiConsent:parsed.data.consent,noticeVersion:LIVE_AI_NOTICE_VERSION,updatedAt:Date.now()};
    state.assessmentVersion++;
    if(state.trip.agent){state.trip.agent.semanticHandoff=null;state.trip.agent.handoffSummary=null;state.trip.agent.structuredHandoff=null;state.trip.agent.provider='mock';state.trip.agent.liveModel=false;}
    this.event(state.trip,'ai-consent','AI processing choice updated','This participant changed permission for future processing of their messages. Already transmitted requests cannot be recalled.');
    this.save(state);await this.schedule();
    const current=await this.read(userId);return current.ok&&'rider'in current.value?ok(current.value):current.ok?fail(403,'Private journey access changed.'):current;
  }
  async act(user: Person, action: TripAction): Promise<Outcome<Trip | TripSummary>> {
    const identity=action.action==='accept'?await this.env.USERS.getByName(user.id).communityIdentity():null;
    let state = this.load(); if (!state) return fail(404,'Trip not found.');
    if (this.expire(state)) { this.save(state); await this.schedule(); state = this.load()!; }
    const trip = state.trip;
    if (isClosed(trip)) return fail(409,'This trip is closed.');
    if (action.action === 'accept') {
      if(state.community&&!identity)return fail(409,'Accept the community public-record notice before volunteering.');
      if(state.community&&identity){
        if(!state.community.members[user.id]&&state.community.guardians.length>=16)return fail(409,'This journey has reached its guardian participation limit.');
        state.community.members[user.id]=identity.memberId;
      }
      if (trip.chainEnabled && !user.wallet) return fail(409,'Bind a wallet before applying to a chain-linked journey.');
      if (trip.rider.id === user.id) return fail(400,'You cannot guard your own trip.');
      if (trip.guardian?.id === user.id) return fail(409,'You are already the assigned guardian.');
      const request = summary(trip);
      if (!request.requestKind || action.requestId !== request.requestId) return fail(409,'This guard request is no longer available. Refresh the trip.');
      if (trip.guardianRequests.some(item => item.candidate.id === user.id)) return fail(409,'You already have a pending application.');
      if (trip.guardianRequests.length >= 5) return fail(409,'This request already has five pending applications.');
      const now = Date.now();
      trip.guardianRequests.push({id:crypto.randomUUID(),kind:request.requestKind,candidate:{id:user.id,name:user.name,...(user.wallet?{wallet:user.wallet}:{})},createdAt:now,expiresAt:Math.min(now + 5 * 60000,request.requestExpiresAt!)});
      state.indexVersion += 1;
      this.event(trip,'guardian-application','Guardian application received',`${user.name} requested to guard this trip. Private access requires rider approval.`);
      this.save(state); await this.schedule(); await this.syncIndexes(); await this.schedule();
      return this.read(user.id);
    }
    if (action.action === 'withdraw-application') {
      const application = trip.guardianRequests.find(item => item.id === action.requestId);
      if (!application) return fail(409,'This application is no longer pending.');
      if (application.candidate.id !== user.id) return fail(403,'Only the applicant can withdraw this application.');
      if(state.chainApplications?.[application.id])state.chainApplications[application.id].revoked=true;
      trip.guardianRequests = trip.guardianRequests.filter(item => item.id !== application.id);
      state.indexVersion += 1; this.save(state); await this.schedule(); await this.syncIndexes(); await this.schedule();
      return this.read(user.id);
    }
    if (!isParticipant(trip,user.id)) return fail(403,'Only approved trip participants can take this action.');
    const rider = trip.rider.id === user.id;
    // New human intent invalidates an in-flight model reply generated from older context.
    if (action.action !== 'location') state.assessmentVersion += 1;
    switch (action.action) {
      case 'approve-guardian':
      case 'reject-guardian': {
        if (trip.chainEnabled && action.action === 'approve-guardian') return fail(409,'Approve this application through the linked wallet transaction. Access changes after the guardian accepts on chain.');
        if (!rider) return fail(403,'Only the rider can decide guardian applications.');
        const application = trip.guardianRequests.find(item => item.id === action.requestId);
        if (!application || application.expiresAt <= Date.now() || application.kind !== summary(trip).requestKind) return fail(409,'This application is no longer pending.');
        if (action.action === 'reject-guardian') {
          if(state.chainApplications?.[application.id])state.chainApplications[application.id].revoked=true;
          trip.guardianRequests = trip.guardianRequests.filter(item => item.id !== application.id);
          this.event(trip,'guardian-rejected','Guardian application declined','The rider declined an application. No private access was granted.');
        } else {
          if(state.community){const ref=state.community.members[application.candidate.id];
            if(!ref)return fail(409,'The candidate must accept the community public-record notice.');
            if(state.community.guardians.length>=16&&!state.community.guardians.some(item=>item.memberId===ref))return fail(409,'This journey has reached its guardian participation limit.');}
          const now = Date.now(), previous = trip.guardian;
          const oldContribution = previous && trip.contributions.find(item => item.guardian.id === previous.id);
          if (oldContribution) oldContribution.endedAt = now;
          trip.guardian = application.candidate; trip.status = 'active'; trip.guardMode = 'human';
          state.monitoringStartedAt ??= now; state.rewardEligible = false;
          trip.lastGuardianCheckInAt = null; trip.nextCheckInAt = now + trip.checkInIntervalSeconds * 1000;
          state.aiNextCheckInAt = null; state.aiMissedCheckIns = 0;
          const contribution = trip.contributions.find(item => item.guardian.id === application.candidate.id);
          if (contribution) contribution.endedAt = null;
          else trip.contributions.push({guardian:application.candidate,checkIns:0,startedAt:now,endedAt:null,points:0,reputation:0,rewardStatus:'pending'});
          trip.guardianRequests = []; trip.relay = null;
          this.event(trip,'guardian-approved',previous?'Replacement guardian approved':'Guardian approved',`${application.candidate.name} is now assigned. An explicit guardian check-in is required for reward eligibility.`);
        }
        state.indexVersion += 1; break;
      }
      case 'request-relay': {
        if (trip.demo || trip.status !== 'active') return fail(409,'Replacement requests require an active real trip.');
        if (trip.relay) return fail(409,'A replacement request is already open.');
        this.openRelay(state,user); break;
      }
      case 'cancel-relay': {
        if (!trip.relay || trip.relay.id !== action.requestId) return fail(409,'This replacement request is no longer open.');
        for(const item of Object.values(state.chainApplications??{}))item.revoked=true;
        trip.relay = null; trip.guardianRequests = []; state.indexVersion += 1;
        this.event(trip,'relay-cancelled','Replacement request cancelled','Pending replacement applications were cleared. The current assignment and monitoring mode have not changed.'); break;
      }
      case 'check-in': {
        if (rider) {
          trip.risk = trip.escalation?.cause==='explicit_help'?'urgent':trip.agent?.concerns?.length?'attention':'normal';
          if(trip.escalation?.cause==='user_authorized_timeout_policy')delete trip.escalation;
          if (trip.agent) trip.agent.followUpAt = null;
          state.aiMissedCheckIns = 0; state.automatedEscalationSent = false;
          if (trip.guardMode === 'ai') state.aiNextCheckInAt = Date.now() + Math.max(60,trip.checkInIntervalSeconds) * 1000;
          this.event(trip,'rider-check-in','Rider checked in','The rider reported that they are okay.');
          this.message(trip,user,'rider',action.text || 'I am okay.');
        } else {
          this.guardianCheckIn(state);
          trip.lastGuardianCheckInAt = Date.now();
          if (trip.guardMode === 'human') trip.nextCheckInAt = Date.now() + trip.checkInIntervalSeconds * 1000;
          this.event(trip,'guardian-check-in','Guardian checked in','The guardian confirmed availability.');
        }
        break;
      }
      case 'takeover': this.takeover(state,'A participant reported that human monitoring is unavailable.',user); break;
      case 'resume': {
        if (rider) return fail(403,'Only the assigned guardian can resume human monitoring.');
        trip.guardMode = 'human'; trip.lastGuardianCheckInAt = Date.now();
        state.aiNextCheckInAt = null; state.aiMissedCheckIns = 0;
        trip.nextCheckInAt = Date.now() + trip.checkInIntervalSeconds * 1000; this.guardianCheckIn(state);
        this.event(trip,'resumed','Guardian resumed monitoring','The assigned guardian explicitly confirmed availability.'); break;
      }
      case 'arrive': {
        if (!rider) return fail(403,'Only the rider can confirm arrival.');
        trip.status = 'arrived'; trip.nextCheckInAt = null;
        state.indexVersion += 1;
        trip.guardianRequests = []; trip.relay = null; state.aiNextCheckInAt = null; allocateContributions(trip,Date.now(),state.community?.members);
        if (trip.chainEnabled) { trip.reward.status = 'pending'; for (const item of trip.contributions) { item.points=0; item.reputation=0; item.rewardStatus='pending'; } }
        this.event(trip,'arrived','Arrived safely','The rider confirmed arrival. Monitoring has ended.'); break;
      }
      case 'cancel': {
        if (!rider) return fail(403,'Only the rider can cancel a trip.');
        trip.status = 'cancelled'; trip.nextCheckInAt = null; trip.guardianRequests = []; trip.relay = null; state.aiNextCheckInAt = null; allocateContributions(trip,Date.now(),state.community?.members);
        state.indexVersion += 1;
        this.event(trip,'cancelled','Trip cancelled','Monitoring has ended and no contribution reward will be issued.'); break;
      }
      case 'help': {
        trip.risk = 'urgent';
        this.message(trip,user,rider?'rider':'guardian',action.text || 'I need help.');
        trip.escalation={cause:'explicit_help',at:Date.now(),sourceId:trip.messages.at(-1)!.id};
        this.event(trip,'help','Help requested','Escalation was requested explicitly.');
        const result = ruleAssessment(action.text || '',true); trip.ai = {mode:result.mode,lastAssessment:result.message};
        this.message(trip,agent,'agent',result.message);
        this.queueNotification(state,'A Safety Guard trip participant requested help. Please contact the rider.'); break;
      }
      case 'message': {
        if (!action.text?.trim()) return fail(400,'Message text is required.');
        this.message(trip,user,rider?'rider':'guardian',action.text);
        if (rider) {
          state.aiMissedCheckIns = 0;
          state.automatedEscalationSent = false;
          if(trip.escalation?.cause==='user_authorized_timeout_policy')delete trip.escalation;
          if (hasAgentConcern(action.text)) {
            const source=trip.messages.at(-1)!;
            const harness=trip.agent??={provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null};
            harness.handoffSummary=null;harness.structuredHandoff=null;harness.semanticHandoff=null;
            harness.concerns??=[];
            if(harness.concerns.length<8)harness.concerns.push({id:source.id,observedAt:source.at,receivedAt:Date.now(),text:redactAgentText(source.text)});
            else this.event(trip,'concern-capacity','Additional concern in conversation',`Eight earlier concerns remain pinned. Review additional source ${source.id} in conversation history.`);
            if(trip.escalation?.cause!=='explicit_help')trip.escalation={cause:'model_concern',at:Date.now(),sourceId:source.id};
            if(trip.risk==='normal')trip.risk='attention';
            trip.ai={mode:'rules',lastAssessment:'A possible concern was recorded from your message. Use Request help if you want to alert your trusted contact.'};
          }
          const latestRiderMessage = [...trip.messages].reverse().find(item => item.role === 'rider')!;
          if (trip.guardMode === 'ai') this.queueAgent(state,'rider-message',latestRiderMessage.id,latestRiderMessage.id);
        }
        break;
      }
      case 'resolve-concern': {
        if(!rider)return fail(403,'Only the rider can resolve a concern.');
        const concern=trip.agent?.concerns?.find(item=>item.id===action.requestId);
        if(!concern)return fail(404,'Unresolved concern not found.');
        trip.agent!.concerns=trip.agent!.concerns!.filter(item=>item.id!==concern.id);
        trip.agent!.handoffSummary=null;trip.agent!.structuredHandoff=null;trip.agent!.semanticHandoff=null;
        this.event(trip,'concern-resolved','Concern resolved by rider',`The rider resolved source ${concern.id}. This does not withdraw an explicit help request.`);
        break;
      }
      case 'location': {
        if (!rider) return fail(403,'Only the rider can share their location.');
        if (action.lat === undefined || action.lng === undefined) return fail(400,'Coordinates are required.');
        trip.location = {lat:action.lat,lng:action.lng,updatedAt:Date.now()}; state.staleAlerted = false; break;
      }
      case 'simulate': {
        if (!trip.demo || !rider) return fail(403,'Scenarios are available only to the rider of a demo trip.');
        if (action.scenario === 'guardian-offline') this.takeover(state,'Demo scenario: the simulated guardian missed a check-in.');
        else if (action.scenario === 'route-deviation') {
          if (trip.guardMode !== 'ai') this.takeover(state,'Demo scenario: offline companion handling a route concern.');
          trip.risk = trip.risk === 'urgent'?'urgent':'attention';
          trip.location = {lat:43.4695,lng:-80.5278,updatedAt:Date.now()};
          this.event(trip,'route-deviation','Unusual route reported','Simulated route deviation. A deviation is not proof of danger.');
          this.message(trip,user,'rider','Demo scenario: my ride appears to have changed route. Please check in with me.');
          this.queueAgent(state,'rider-message',trip.messages[trip.messages.length-1].id,trip.messages[trip.messages.length-1].id);
        } else if (action.scenario === 'stale-location') {
          trip.location.updatedAt = Date.now() - 180000; state.staleAlerted = true;
          trip.risk = trip.risk === 'urgent'?'urgent':'attention';
          this.event(trip,'stale-location','Location update is overdue','Demo scenario: GPS may be unavailable. The last position is not a live position.');
          this.message(trip,agent,'agent','Your location has not updated recently. This can happen when GPS or network access is unavailable. Are you okay?');
          this.queueAgent(state,'stale-location');
        } else if (action.scenario === 'notification-failure') {
          this.queueNotification(state,'Demo escalation request',true);
          this.queueAgent(state,'notification-failure',trip.notifications[trip.notifications.length-1].id);
        }
        else return fail(400,'Unknown demo scenario.');
        break;
      }
    }
    this.save(state); await this.schedule();
    await this.syncIndexes();
    await this.deliverNotifications();
    if (trip.status === 'arrived') await this.settleReward();
    if(action.action!=='help')await this.runAgent(); await this.deliverNotifications(); await this.syncIndexes();
    await this.deliverCommunity();await this.schedule(); return this.read(user.id);
  }
  private async deliverNotifications(): Promise<void> {
    const ids = Object.keys(this.load()?.notificationJobs ?? {});
    for (const id of ids) {
      let state = this.load(); if (!state) return;
      // Ending monitoring cancels unsent jobs; do not continue outbound work after closure.
      if (isClosed(state.trip)) {
        for (const pendingId of Object.keys(state.notificationJobs)) {
          const pending = state.trip.notifications.find(item => item.id === pendingId);
          if (pending?.status === 'queued') { pending.status = 'failed'; pending.detail = 'Journey monitoring ended before dispatch; no new send was attempted.'; }
        }
        state.notificationJobs = {}; this.save(state); return;
      }
      const job = state.notificationJobs[id];
      if (!job || job.retryAt > Date.now() || job.inFlightUntil > Date.now()) continue;
      const notice = state.trip.notifications.find(item => item.id === id); if (!notice) continue;
      if(!notificationDispatchAuthorized(state.trip,notice)) {
        notice.status='failed';notice.detail='Current notification authorization is absent or was revoked; no send was attempted.';
        delete state.notificationJobs[id];this.save(state);continue;
      }
      job.attempts += 1; job.inFlightUntil = Date.now() + 30000;
      if (!state.trip.demo && state.trip.notificationConsent && state.trip.emergencyContact && this.env.NOTIFICATIONS_ENABLED === 'true' && this.env.NOTIFICATION_WEBHOOK_URL && this.env.NOTIFICATION_WEBHOOK_SECRET) notice.channel = 'webhook';
      this.save(state); await this.schedule();
      // Refresh consent/lifecycle after yielding to schedule. Never dispatch an old snapshot.
      state = this.load(); if (!state || isClosed(state.trip)) continue;
      const liveNotice = state.trip.notifications.find(item => item.id === id);
      if (!liveNotice || !state.notificationJobs[id]) continue;
      if(!notificationDispatchAuthorized(state.trip,liveNotice)) {
        liveNotice.status='failed';liveNotice.detail='Notification authorization changed before dispatch; no send was attempted.';
        delete state.notificationJobs[id];this.save(state);continue;
      }
      const result = await sendNotification(this.env,state.trip,liveNotice);
      state = this.load(); if (!state) return;
      const current = state.trip.notifications.find(item => item.id === id);
      if (current && current.status !== 'acknowledged') Object.assign(current,result);
      const currentJob = state.notificationJobs[id];
      if (currentJob) {
        if (result.status === 'failed' && result.channel === 'webhook' && currentJob.attempts < 3) {
          currentJob.retryAt = Date.now() + currentJob.attempts * 15000; currentJob.inFlightUntil = 0;
        } else delete state.notificationJobs[id];
      }
      if (result.status === 'failed') this.queueAgent(state,'notification-failure',id);
      this.save(state);
    }
  }
  private async settleReward(): Promise<void> {
    let state = this.load(); if (!state || state.trip.status !== 'arrived' || state.trip.reward.status !== 'pending' || state.trip.demo) return;
    if (state.trip.chainEnabled) return;
    const ids = state.trip.contributions.filter(item => item.rewardStatus === 'pending' && item.checkIns > 0).map(item => item.guardian.id);
    for (const id of ids) {
      state = this.load(); if (!state) return;
      const contribution = state.trip.contributions.find(item => item.guardian.id === id);
      if (!contribution || contribution.rewardStatus !== 'pending') continue;
      const status = await this.env.GOVERNANCE.getByName('governance-v1').status(id);
      if (status.deleted || status.suspended) {
        state = this.load(); const entry = state?.trip.contributions.find(item=>item.guardian.id===id);
        if(state && entry){entry.rewardStatus='ineligible';entry.points=0;entry.reputation=0;this.save(state);} continue;
      }
      await this.env.USERS.getByName(id).credit(state.trip.id,contribution.points,contribution.reputation,Boolean(state.community));
      state = this.load(); if (!state) return;
      const current = state.trip.contributions.find(item => item.guardian.id === id);
      if (current && current.rewardStatus === 'pending') { current.rewardStatus = 'credited'; this.save(state); }
    }
    state = this.load(); if (!state || state.trip.reward.status !== 'pending') return;
    if (state.trip.contributions.some(item => item.rewardStatus === 'pending')) return;
    state.trip.reward.status = 'credited';
    this.event(state.trip,'reward','Contributions recorded','Eligible guardians shared one pool of 25 community points and 10 reputation. These are app points, not tokens or money.');
    this.save(state);
  }
  private async syncIndexes(): Promise<void> {
    const snapshot = this.load(); if (!snapshot || snapshot.indexVersion === snapshot.indexedVersion) return;
    // Retry inventory registration from the same alarm that repairs a interrupted create.
    await this.env.GOVERNANCE.getByName('governance-v1').registerTrip(snapshot.trip.id);
    const people = [snapshot.trip.rider,...snapshot.trip.contributions.map(item => item.guardian),...snapshot.trip.guardianRequests.map(item => item.candidate)];
    if (snapshot.trip.guardian) people.push(snapshot.trip.guardian);
    for (const person of new Map(people.filter(item => !item.simulated).map(item => [item.id,item])).values()) {
      await this.env.USERS.getByName(person.id).addTrip(snapshot.trip.id);
    }
    // The directory also remembers versions, so an older async write cannot restore a closed request.
    await this.env.LOBBY.getByName(directoryName(snapshot.trip.id)).update(summary(snapshot.trip),snapshot.indexVersion);
    const state = this.load(); if (!state) return;
    if (state.indexVersion === snapshot.indexVersion) state.indexedVersion = snapshot.indexVersion;
    this.save(state);
  }
  acknowledge(notificationId: string): Outcome<{acknowledged:boolean}> {
    const state = this.load(); if (!state) return fail(404,'Trip not found.');
    const notice = state.trip.notifications.find(item => item.id === notificationId);
    if (!notice) return fail(404,'Notification not found.');
    if (notice.channel !== 'webhook' || notice.status === 'simulated') return fail(409,'Only provider notifications can be acknowledged.');
    notice.status = 'acknowledged'; notice.detail = 'The configured notification provider reported a recipient acknowledgement.';
    delete state.notificationJobs[notice.id]; this.save(state); return ok({acknowledged:true});
  }
  async alarm(): Promise<void> {
    const state = this.load(); if (!state) {await this.deliverCommunity();await this.schedule();return;}
    if (state.trip.privacyExpiresAt && state.trip.privacyExpiresAt <= Date.now()) { await this.purge(); return; }
    const trip = state.trip, now = Date.now();
    if (this.expire(state)) this.save(state);
    if (!isClosed(trip)) {
      if (now >= (trip.status === 'open' ? trip.createdAt + 86400000 : (state.monitoringStartedAt ?? trip.createdAt) + 6 * 3600000)) {
        trip.status = 'cancelled'; trip.nextCheckInAt = null; trip.guardianRequests = []; trip.relay = null; state.aiNextCheckInAt = null; allocateContributions(trip,Date.now(),state.community?.members);
        state.indexVersion += 1;
        this.event(trip,'expired','Trip monitoring expired','The maximum monitoring period ended. Start a new trip if needed.');
      } else {
        if (trip.guardMode === 'human' && trip.nextCheckInAt !== null && trip.nextCheckInAt <= now) this.takeover(state,'The server detected a missed guardian check-in, even without an open browser.');
        if (trip.guardMode === 'ai' && assistanceEnabled(trip) && state.aiNextCheckInAt !== null && state.aiNextCheckInAt <= now) {
          state.aiMissedCheckIns += 1;
          state.aiNextCheckInAt = now + Math.max(60,trip.checkInIntervalSeconds) * 1000;
          this.event(trip,'agent-check-in','Automated check-in','The server scheduled a new check-in while the human guardian is unavailable.');
          this.message(trip,agent,'agent','Checking in: are you okay? Confirm your status when it is safe. An unanswered check-in may be caused by a closed browser or lost connectivity.');
          if (trip.agent) trip.agent.followUpAt = null;
          this.queueAgent(state,'follow-up');
          if (state.aiMissedCheckIns >= 2 && !state.automatedEscalationSent && trip.assistance?.timeoutContact && trip.notificationConsent) {
            state.automatedEscalationSent = true;
            if(trip.escalation?.cause!=='explicit_help')trip.escalation={cause:'user_authorized_timeout_policy',at:now};
            this.queueNotification(state,'The rider has not answered two automated check-ins while the guardian is unavailable. Please try to contact them. This may be due to lost connectivity.');
          }
        }
        if (trip.status === 'active' && !state.staleAlerted && trip.location.updatedAt + 120000 <= now) {
          state.staleAlerted = true;
          if (trip.risk === 'normal') trip.risk = 'attention';
          this.event(trip,'stale-location','Location update is overdue','No position update has arrived in two minutes. Last known location may be stale.');
          if(assistanceEnabled(trip))this.message(trip,agent,'agent','Your location has not updated for two minutes. Are you okay? Please open the app and check in when safe.');
          this.queueAgent(state,'stale-location');
        }
        if (trip.guardMode === 'ai' && trip.agent?.followUpAt && trip.agent.followUpAt <= now) {
          const due = trip.agent.followUpAt; trip.agent.followUpAt = null;
          this.queueAgent(state,'follow-up',`follow-up:${due}`);
        }
      }
      this.save(state);
    }
    // Persist the next wake-up before external work so an interrupted delivery can be recovered.
    await this.schedule();
    await this.syncIndexes();
    await this.deliverNotifications(); await this.runAgent(); await this.deliverNotifications();
    await this.syncIndexes(); await this.settleReward(); await this.deliverGratitude();await this.deliverCommunity(); await this.schedule();
  }

  /** Internal RPC only: the HTTP router never exposes this unredacted context. */
  chainContext(): Trip | null { return this.load()?.trip ?? null; }

  /** Retain the consent decision across automatic application expiry and delayed finality. */
  reserveChainApplication(applicationId:string,candidateId:string):Outcome<{reserved:boolean}> {
    const state=this.load();if(!state||!state.trip.chainEnabled||isClosed(state.trip))return fail(409,'This journey cannot accept a proposal.');
    const application=state.trip.guardianRequests.find(item=>item.id===applicationId&&item.candidate.id===candidateId&&item.expiresAt>Date.now());
    if(!application?.candidate.wallet)return fail(409,'The application expired or was withdrawn.');
    state.chainApplications??={};
    if(Object.keys(state.chainApplications).length>=100&&!state.chainApplications[applicationId])return fail(409,'This journey has reached its proposal limit.');
    state.chainApplications[applicationId]={candidate:application.candidate,revoked:false};this.save(state);return ok({reserved:true});
  }
  chainApplicationAvailable(applicationId:string,candidateId:string):boolean {
    const state=this.load();const item=state?.chainApplications?.[applicationId];
    return Boolean(state&&!isClosed(state.trip)&&item&&!item.revoked&&item.candidate.id===candidateId);
  }

  async applyChainSnapshot(snapshot:ChainSnapshot,members:ChainMember[],applicationId:string|null):Promise<Outcome<{applied:boolean}>> {
    let state=this.load();if(!state)return fail(410,'The private journey has been erased.');
    if(!state.trip.chainEnabled)return fail(409,'This trip is not chain-linked.');
    if(snapshot.slot<(state.chainSlot??0)||snapshot.sequence<(state.chainSequence??0))return ok({applied:false});
    const member=members.find(item=>item.wallet===snapshot.currentGuardian);
    const replacing=snapshot.state==='active'&&snapshot.sequence>(state.chainSequence??0)&&member;
    if(replacing&&!isClosed(state.trip)) {
      const application=applicationId&&state.chainApplications?.[applicationId];
      // A signed proposal may finalize after its UI timer; an explicitly withdrawn/rejected one is never promoted.
      if(!application||application.revoked||application.candidate.id!==member.person.id||application.candidate.wallet!==member.wallet)return fail(409,'The confirmed guardian has no current rider-approved application. Reopen recruitment and authorize a new proposal.');
      const restriction=await this.env.GOVERNANCE.getByName('governance-v1').status(member.person.id);
      state=this.load();if(!state)return fail(410,'The private journey was erased.');
      if(snapshot.slot<(state.chainSlot??0)||snapshot.sequence<=(state.chainSequence??0))return ok({applied:false});
      if(restriction.deleted||restriction.suspended)return fail(403,'The confirmed guardian is unavailable in the application.');
      if(isClosed(state.trip))return fail(409,'The application journey has ended.');
      const pending=applicationId&&state.chainApplications?.[applicationId];
      if(!pending||pending.revoked||pending.candidate.id!==member.person.id)return fail(409,'The application was withdrawn while confirmation was pending.');
      if(state.community){const ref=state.community.members[member.person.id];if(!ref)return fail(409,'The candidate must accept the community public-record notice.');
        if(state.community.guardians.length>=16&&!state.community.guardians.some(item=>item.memberId===ref))return fail(409,'This journey has reached its guardian participation limit.');}
      const trip=state.trip;const now=Date.now();
      const former=trip.contributions.find(item=>item.guardian.id===trip.guardian?.id);if(former)former.endedAt=now;
      trip.guardian={...member.person,wallet:member.wallet};trip.status='active';trip.guardMode='human';
      trip.lastGuardianCheckInAt=null;trip.nextCheckInAt=now+trip.checkInIntervalSeconds*1000;
      trip.guardianRequests=[];trip.relay=null;state.monitoringStartedAt??=now;state.aiNextCheckInAt=null;state.aiMissedCheckIns=0;
      const contribution=trip.contributions.find(item=>item.guardian.id===member.person.id);
      if(contribution)contribution.endedAt=null;
      else trip.contributions.push({guardian:trip.guardian,checkIns:0,startedAt:now,endedAt:null,points:0,reputation:0,rewardStatus:'pending'});
      state.indexVersion+=1;state.assessmentVersion+=1;
      this.event(trip,'chain-handoff','Signed guardian handoff confirmed','Rider authorization and the new guardian acceptance are finalized on chain. Private access has changed.');
    }
    state.chainSlot=snapshot.slot;state.chainSequence=snapshot.sequence;
    // A finalized signed check-in is also evidence of participation for free gratitude.
    // Keep one conservative count; chain allocations still exclusively control linked rewards.
    for(const entry of state.trip.contributions) {
      const participant=members.find(item=>item.person.id===entry.guardian.id);
      const allocation=snapshot.contributions.find(item=>item.wallet===participant?.wallet);
      if(allocation)entry.checkIns=Math.max(entry.checkIns,allocation.checkIns);
    }
    if(snapshot.state==='completed') {
      // Chain allocations are the authority for linked journeys; local check-in counts do not issue another pool.
      if(!isClosed(state.trip)){state.trip.status='arrived';state.trip.nextCheckInAt=null;state.aiNextCheckInAt=null;state.trip.relay=null;state.trip.guardianRequests=[];state.indexVersion+=1;}
      for(const entry of state.trip.contributions){
        const participant=members.find(item=>item.person.id===entry.guardian.id);
        const allocation=snapshot.contributions.find(item=>item.wallet===participant?.wallet);
        if(!allocation || allocation.checkIns===0){entry.rewardStatus='ineligible';entry.points=0;entry.reputation=0;}
        else {entry.points=allocation.points;entry.reputation=allocation.reputation;entry.rewardStatus=allocation.claimed?'credited':'pending';}
        entry.endedAt??=Date.now();
      }
      state.trip.reward.status=state.trip.contributions.some(item=>item.rewardStatus==='pending')?'pending':state.trip.contributions.some(item=>item.rewardStatus==='credited')?'credited':'ineligible';
    } else if(snapshot.state==='cancelled'&&!isClosed(state.trip)) {
      state.trip.status='cancelled';state.trip.nextCheckInAt=null;state.aiNextCheckInAt=null;state.trip.relay=null;state.trip.guardianRequests=[];allocateContributions(state.trip,Date.now(),state.community?.members);state.indexVersion+=1;
    }
    this.save(state);await this.schedule();await this.syncIndexes();
    for(const allocation of snapshot.contributions.filter(item=>item.claimed)) {
      const person=members.find(item=>item.wallet===allocation.wallet);if(!person)continue;
      const restriction=await this.env.GOVERNANCE.getByName('governance-v1').status(person.person.id);
      if(!restriction.deleted&&!restriction.suspended)await this.env.USERS.getByName(person.person.id).credit(state.trip.id,allocation.points,allocation.reputation,Boolean(state.community));
    }
    await this.deliverCommunity();await this.schedule();return ok({applied:true});
  }

  exportSnapshot():StoredTrip|null {
    const state=this.load();if(!state)return null;
    return {...state,...(state.community?{communityEvents:this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM community_source ORDER BY sequence').toArray().map(row=>JSON.parse(row.data) as SourceCommunityEvent)}:{})};
  }
  validateSnapshot(value:unknown,expectedId:string):boolean {
    const parsed=tripSnapshotSchema.safeParse(value);
    return parsed.success&&parsed.data.trip.id===expectedId;
  }
  async purge():Promise<void> {
    const state=this.load();if(!state)return;
    if(state.community&&!isClosed(state.trip)){
      state.trip.status='cancelled';state.trip.nextCheckInAt=null;state.aiNextCheckInAt=null;state.trip.relay=null;state.trip.guardianRequests=[];
      allocateContributions(state.trip,Date.now(),state.community?.members);this.save(state);
    }
    await this.schedule();
    await this.env.GOVERNANCE.getByName('governance-v1').recordDeletedTrip(state.trip.id);
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO erased VALUES (1,?)',Date.now());
    this.ctx.storage.sql.exec('DELETE FROM trip_state');await this.schedule();
    await this.env.LOBBY.getByName(directoryName(state.trip.id)).update({...summary(state.trip),requestKind:null,requestId:null,requestExpiresAt:null},state.indexVersion+1);
    if(state.trip.chainEnabled)await this.env.CHAIN.getByName(state.trip.id).purge();
    await this.deliverCommunity();await this.schedule();
  }
  async eraseForRider(userId:string):Promise<Outcome<{deleted:boolean}>> {
    const state=this.load();if(!state)return ok({deleted:true});
    if(state.trip.rider.id!==userId)return fail(403,'Only the rider may erase the private journey.');
    if(!isClosed(state.trip))return fail(409,'End the journey before erasing it. Public chain records cannot be erased.');
    await this.purge();return ok({deleted:true});
  }
  async scrubUser(userId:string):Promise<void> {
    let state=this.load();if(!state)return;
    if(state.trip.rider.id===userId){await this.purge();return;}
    state.trip.guardianRequests=state.trip.guardianRequests.filter(item=>item.candidate.id!==userId);
    state.gratitude=(state.gratitude??[]).filter(item=>item.guardianId!==userId);
    for(const [key,item] of Object.entries(state.chainApplications??{}))if(item.candidate.id===userId)delete state.chainApplications![key];
    for(const item of state.trip.contributions)if(item.guardian.id===userId)item.guardian={id:userId,name:'Deleted participant'};
    state.trip.messages=state.trip.messages.filter(item=>item.senderId!==userId);
    // Free-form history could quote the erased participant; keep minimal remaining state instead.
    state.trip.events=[];
    // Context snapshots and summaries may quote the erased participant's messages.
    state.trip.agent = {provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null};
    if(state.trip.aiConsent)delete state.trip.aiConsent[userId];
    state.assessmentVersion+=1;
    if(state.trip.guardian?.id===userId){state.trip.guardian=null;if(!isClosed(state.trip))this.takeover(state,'The assigned account was deleted. Human replacement is required.');}
    if(state.community)delete state.community.members[userId];
    state.indexVersion+=1;this.save(state);await this.schedule();await this.syncIndexes();
  }
  async restoreSnapshot(value:StoredTrip):Promise<boolean> {
    if(this.load()||this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)return false;
    value=tripSnapshotSchema.parse(value);
    if(await this.env.GOVERNANCE.getByName('governance-v1').isTripPurged(value.trip.id))return false;
    if(value.community){
      const source=value.communityEvents!;
      // The independent journal can be newer than a private-state backup. Never
      // overwrite that chronology or append a forced cancellation at an occupied sequence.
      let cursor:string|undefined;
      do{
        const page=await this.env.COMMUNITY.getByName(`journey:${value.community.journeyId}`).journey(value.community.journeyId,cursor);
        if(!page.ok)return false;
        for(const record of page.value.records)if(!source[record.event.sequence]||JSON.stringify(source[record.event.sequence])!==JSON.stringify(record.event))return false;
        cursor=page.value.nextCursor??undefined;
      }while(cursor);
      for(const row of this.ctx.storage.sql.exec<{sequence:number;data:string}>('SELECT sequence,data FROM community_source ORDER BY sequence').toArray()){
        if(!source[row.sequence]||JSON.stringify(source[row.sequence])!==row.data)return false;
      }
    }
    const ids=new Set([value.trip.rider.id,value.trip.guardian?.id,...value.trip.guardianRequests.map(item=>item.candidate.id),...value.trip.contributions.map(item=>item.guardian.id),...Object.values(value.chainApplications??{}).map(item=>item.candidate.id)]);
    const deleted=new Set<string>();
    for(const id of ids)if(id&&/^[0-9a-f-]{36}$/.test(id)&&(await this.env.GOVERNANCE.getByName('governance-v1').status(id)).deleted)deleted.add(id);
    if(deleted.has(value.trip.rider.id)){await this.env.GOVERNANCE.getByName('governance-v1').recordDeletedTrip(value.trip.id);this.ctx.storage.sql.exec('INSERT OR IGNORE INTO erased VALUES (1,?)',Date.now());return false;}
    if(deleted.size){
      value.trip.guardianRequests=value.trip.guardianRequests.filter(item=>!deleted.has(item.candidate.id));
      value.trip.messages=value.trip.messages.filter(item=>!deleted.has(item.senderId));value.trip.events=[];
      for(const entry of value.trip.contributions)if(deleted.has(entry.guardian.id))entry.guardian={id:entry.guardian.id,name:'Deleted participant'};
      if(value.trip.guardian&&deleted.has(value.trip.guardian.id))value.trip.guardian=null;
      for(const [id,entry] of Object.entries(value.chainApplications??{}))if(deleted.has(entry.candidate.id))delete value.chainApplications![id];
    }
    if(this.load()||this.ctx.storage.sql.exec('SELECT id FROM erased').toArray().length)return false;
    // An old backup must never restart an unattended journey or replay an external notification.
    value.notificationJobs={};value.trip.notifications=[];
    // New official publication intents keep their stable identities on restore. Legacy
    // gratitude retains its original cancellation policy and is never backfilled.
    value.gratitude=(value.gratitude??[]).filter(item=>!deleted.has(item.guardianId)).map(item=>({...item,status:!value.community&&item.status==='pending'?'cancelled':item.status,inFlightUntil:0}));
    value.trip.agent={provider:'mock',liveModel:false,runs:[],followUpAt:null,handoffSummary:null};
    value.trip.aiConsent={};if(value.trip.assistance)value.trip.assistance.liveAiConsent=false;
    if(value.community){
      for(const id of deleted)delete value.community.members[id];
      const source=value.communityEvents??[];delete value.communityEvents;
      this.ctx.storage.transactionSync(()=>{
        for(const event of source)this.ctx.storage.sql.exec('INSERT OR IGNORE INTO community_source(sequence,data) VALUES(?,?)',event.sequence,JSON.stringify(event));
        // Seed the exact restored state so forced closure appends instead of fabricating creation.
        this.ctx.storage.sql.exec('INSERT INTO trip_state VALUES(1,?)',JSON.stringify(value));
      });
    }
    if(!isClosed(value.trip)){value.trip.status='cancelled';value.trip.nextCheckInAt=null;value.aiNextCheckInAt=null;value.trip.relay=null;value.trip.guardianRequests=[];allocateContributions(value.trip,Date.now(),value.community?.members);}
    value.indexVersion+=1;value.indexedVersion=0;this.save(value);await this.schedule();await this.syncIndexes();await this.deliverCommunity();await this.schedule();return true;
  }
}
