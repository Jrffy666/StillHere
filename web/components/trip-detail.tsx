'use client';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import {
  ShieldCheck,
  ArrowRight,
  Check,
  HeartHandshake,
  Sparkles,
  Send,
  MapPin,
  Clock3,
  AlertCircle,
  Volume2,
  LocateFixed,
  CheckCheck,
  Link as LinkIcon,
  ExternalLink,
  Moon,
  Route,
  WifiOff,
  BellOff,
  Leaf,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JourneyMap } from '@/components/journey-map';
import { HumanGuarding } from '@/components/human-guarding';
import { AgentActivity } from '@/components/agent-activity';
import { JourneyPrivacy } from '@/components/journey-privacy';
import { JourneyGratitudeCard } from '@/components/journey-gratitude';
import { MemberProfileButton } from '@/components/member-profile';
import { JourneyCommunityRecords } from '@/components/community-records';
import { errorMessage, timeLabel, responseError } from '@/lib/api';
import type { Trip, User } from '@/lib/types';

export type ActionBody = {
  action: string;
  requestId?: string;
  text?: string;
  lat?: number;
  lng?: number;
  scenario?: string;
};
export function TripDetail({
  trip,
  user,
  token,
  busy,
  act,
  onProof,
  voiceConfigured,
}: {
  trip: Trip;
  user: User;
  token: string;
  busy: boolean;
  act: (body: ActionBody) => Promise<void>;
  onProof: () => void;
  voiceConfigured: boolean;
}) {
  const [text, setText] = useState(''),
    [now, setNow] = useState(() => Date.now()),
    [info, setInfo] = useState('');
  const [locationBusy, setLocationBusy] = useState(false),
    [voiceBusy, setVoiceBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const watching = useRef<number | null>(null),
    lastLocation = useRef(0),
    audio = useRef<HTMLAudioElement | null>(null),
    audioUrl = useRef<string | null>(null);
  const messagesEnd = useRef<HTMLDivElement>(null);
  const closed = trip.status === 'arrived' || trip.status === 'cancelled';
  const rider = user.id === trip.rider.id;
  const seconds = trip.nextCheckInAt
    ? Math.max(0, Math.ceil((trip.nextCheckInAt - now) / 1000))
    : null;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    messagesEnd.current?.scrollIntoView({
      behavior: 'instant',
      block: 'nearest',
    });
  }, [trip.messages.length]);
  useEffect(
    () => () => {
      if (watching.current !== null)
        navigator.geolocation.clearWatch(watching.current);
      audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
    },
    [],
  );
  useEffect(() => {
    if (closed && watching.current !== null) {
      navigator.geolocation.clearWatch(watching.current);
      watching.current = null;
      setSharing(false);
    }
  }, [closed]);
  async function send(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    await act({ action: 'message', text: text.trim() });
    setText('');
  }
  async function share() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?trip=${encodeURIComponent(trip.id)}`,
      );
      setInfo(
        'Invite copied. Your guardian should open it in a different browser or private window.',
      );
    } catch {
      setInfo(`Invite: ${window.location.origin}/?trip=${trip.id}`);
    }
  }
  function toggleLocation() {
    if (watching.current !== null) {
      navigator.geolocation.clearWatch(watching.current);
      watching.current = null;
      setSharing(false);
      setInfo('Location sharing paused. Your last update remains visible.');
      return;
    }
    if (!navigator.geolocation) {
      setInfo('Location sharing is unavailable in this browser.');
      return;
    }
    setLocationBusy(true);
    setInfo('');
    watching.current = navigator.geolocation.watchPosition(
      (position) => {
        setLocationBusy(false);
        setSharing(true);
        if (Date.now() - lastLocation.current < 10000) return;
        lastLocation.current = Date.now();
        void act({
          action: 'location',
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        }).catch((e) => setInfo(errorMessage(e)));
      },
      (error) => {
        setLocationBusy(false);
        setSharing(false);
        if (watching.current !== null)
          navigator.geolocation.clearWatch(watching.current);
        watching.current = null;
        setInfo(
          error.code === 1
            ? 'Location permission was not granted. You can continue with manual check-ins.'
            : 'A fresh location could not be obtained.',
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    );
  }
  async function speak() {
    setVoiceBusy(true);
    setInfo('');
    try {
      const response = await fetch(`/api/trips/${trip.id}/voice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        const body = await response.json();
        throw new Error(responseError(body, 'Voice is unavailable.'));
      }
      audio.current?.pause();
      if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
      audioUrl.current = URL.createObjectURL(await response.blob());
      audio.current = new Audio(audioUrl.current);
      await audio.current.play();
    } catch (e) {
      setInfo(errorMessage(e));
    } finally {
      setVoiceBusy(false);
    }
  }
  return (
    <>
      {trip.demo && (
        <div className="demo-banner">
          <span>
            <Sparkles size={15} />
            <strong>Demo journey</strong> Simulated guardian and location. No
            external alerts or real rewards.
          </span>
          <span>Try a scenario below</span>
        </div>
      )}
      {closed && rider && !trip.demo && <JourneyGratitudeCard trip={trip} token={token} viewerId={user.id} />}
      <div className="journey-toolbar">
        <div>
          <ShieldCheck size={19} />
          <span>
            {trip.status === 'arrived'
              ? 'Glad you made it.'
              : trip.status === 'cancelled'
                ? 'This journey has ended.'
                : 'Stay connected, on your terms.'}
            <small>
              {trip.status === 'arrived'
                ? trip.reward.status === 'demo'
                  ? 'Demo complete. No real points were issued.'
                  : trip.reward.status === 'credited'
                    ? 'Guardian contribution recorded in the app.'
                    : trip.reward.status === 'pending'
                      ? 'Guardian contribution credit is pending.'
                      : 'No guardian contribution credited.'
                : 'Your precise location is never written to the blockchain.'}
            </small>
          </span>
        </div>
        <div className="toolbar-actions">
          {trip.shareUrl && (
            <a
              className="text-action"
              href={trip.shareUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <LinkIcon size={14} />
              Uber link
              <ExternalLink size={11} />
            </a>
          )}
          {!trip.chainEnabled && (
            <Button variant="outline" onClick={onProof}>
              <Leaf size={15} />
              View contribution
            </Button>
          )}
          {!closed && rider && (
            <>
              <Button
                variant="outline"
                disabled={busy || trip.status !== 'active'}
                onClick={() => void act({ action: 'check-in' }).catch(() => {})}
              >
                <Check size={15} /> I am okay
              </Button>
              <Button
                variant="outline"
                disabled={locationBusy || trip.demo || busy}
                onClick={toggleLocation}
              >
                <LocateFixed size={15} />
                {sharing ? 'Pause location' : 'Share location'}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void act({
                    action: 'help',
                    text: 'I need help. Please alert my trusted contact.',
                  }).catch(() => {})
                }
              >
                <AlertCircle size={15} />I need help
              </Button>
              <Button
                disabled={busy || trip.status !== 'active'}
                onClick={() => void act({ action: 'arrive' }).catch(() => {})}
              >
                <CheckCheck size={16} />
                I’ve arrived
              </Button>
            </>
          )}
        </div>
      </div>
      <div className="journey-grid">
        <section className="journey-main">
          <article className="journey-card">
            <div className="card-header">
              <div>
                <span className="overline">
                  {closed ? 'JOURNEY HISTORY' : 'YOUR CURRENT JOURNEY'}
                </span>
                <h2>
                  {trip.origin.label} <ArrowRight size={17} />{' '}
                  {trip.destination.label}
                </h2>
              </div>
              <span
                className={`status-pill ${trip.risk === 'urgent' && !closed ? 'urgent' : ''}`}
              >
                {trip.status === 'arrived'
                  ? 'Arrived'
                  : trip.status === 'cancelled'
                    ? 'Cancelled'
                    : trip.status === 'open'
                      ? 'Awaiting a guardian'
                      : trip.risk === 'urgent'
                        ? 'Help requested'
                        : 'In progress'}
              </span>
            </div>
            <JourneyMap trip={trip} />
            <div className="route-summary">
              <div>
                <MapPin size={17} />
                <span>
                  SHARED LOCATION
                  <strong>
                    {trip.demo
                      ? 'Demo coordinates'
                      : `${trip.location.lat.toFixed(4)}, ${trip.location.lng.toFixed(4)}`}
                  </strong>
                </span>
              </div>
              <div>
                <Clock3 size={17} />
                <span>
                  LAST UPDATE
                  <strong>
                    {Math.max(
                      0,
                      Math.floor((now - trip.location.updatedAt) / 1000),
                    )}
                    s ago
                  </strong>
                </span>
              </div>
              <div>
                <LockIcon />
                <span>
                  VISIBILITY<strong>Journey participants</strong>
                </span>
              </div>
            </div>
          </article>
          {trip.demo && !closed && (
            <div className="scenario-bar">
              <span>TRY A HANDOFF</span>
              {[
                {
                  name: 'Guardian offline',
                  value: 'guardian-offline',
                  icon: Moon,
                },
                { name: 'Route change', value: 'route-deviation', icon: Route },
                {
                  name: 'Stale location',
                  value: 'stale-location',
                  icon: WifiOff,
                },
                {
                  name: 'Alert fails',
                  value: 'notification-failure',
                  icon: BellOff,
                },
              ].map((s) => (
                <Button
                  key={s.value}
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: 'simulate', scenario: s.value }).catch(
                      () => {},
                    )
                  }
                >
                  <s.icon size={14} />
                  {s.name}
                </Button>
              ))}
            </div>
          )}
          <AgentActivity trip={trip} />
          <article className="activity-card">
            <div className="card-header">
              <h3>Journey activity</h3>
              <span className="quiet-label">EVERY HANDOFF, ACCOUNTED FOR</span>
            </div>
            <div className="activity-list">
              {[...trip.events]
                .reverse()
                .slice(0, 9)
                .map((event, i) => (
                  <div className="activity-item" key={event.id}>
                    <span className={`event-dot ${i === 0 ? 'latest' : ''}`} />
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.detail}</p>
                    </div>
                    <time>{timeLabel(event.at)}</time>
                  </div>
                ))}
            </div>
          </article>
        </section>
        <aside className="journey-side">
          <article className="guardian-card">
            <div className="card-header">
              <h3>Your circle of care</h3>
              <HeartHandshake size={18} />
            </div>
            <div className="guardian-person">
              <div className="avatar guardian-avatar">
                {trip.guardian?.name.slice(0, 1) || '?'}
              </div>
              <div>
                <strong>
                  {trip.guardian?.name || 'Waiting for a guardian'}
                </strong>
                <span>
                  {trip.guardian?.simulated
                    ? 'Simulated community guardian'
                    : trip.guardian
                      ? 'Community guardian'
                      : 'Share your invite to get connected'}
                </span>
                {trip.guardian && !trip.guardian.simulated && <MemberProfileButton memberId={trip.guardian.id} name={trip.guardian.name} token={token} viewerId={user.id} />}
              </div>
              <span
                className={`presence ${!closed && trip.guardMode === 'human' && seconds !== null && seconds > 0 ? 'on' : ''}`}
              />
            </div>
            {!rider && <div className="circle-rider"><span>Accompanying {trip.rider.name}</span><MemberProfileButton memberId={trip.rider.id} name={trip.rider.name} token={token} viewerId={user.id} /></div>}
            <div
              className={`companion-row ${trip.guardMode === 'ai' ? 'engaged' : ''}`}
            >
              <span className="companion-icon">
                <Sparkles size={18} />
              </span>
              <div>
                <strong>Guard companion</strong>
                <span>
                  {closed
                    ? 'Journey closed'
                    : trip.guardMode === 'ai'
                      ? 'Scheduled reminders continue'
                      : 'Check-in reminders ready'}
                </span>
              </div>
              <span className="mini-tag">
                {trip.agent?.provider === 'mock' ? 'MOCK' : 'RULES'}
              </span>
            </div>
            {!closed && (
              <div className="checkin-panel">
                <div>
                  <span>
                    {trip.guardMode === 'human'
                      ? seconds === 0
                        ? 'Guardian check-in overdue'
                        : 'Next guardian check-in'
                      : trip.guardMode === 'waiting'
                        ? 'Waiting for rider approval'
                        : 'No human has confirmed coverage'}
                  </span>
                  <strong>
                    {seconds !== null
                      ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
                      : trip.guardMode === 'ai'
                        ? 'Reminders'
                        : '—'}
                  </strong>
                </div>
                <div className="countdown-track">
                  <span
                    style={{
                      width: `${seconds === null ? 100 : Math.min(100, (seconds / trip.checkInIntervalSeconds) * 100)}%`,
                    }}
                  />
                </div>
                <p>
                  {trip.guardMode === 'human'
                    ? 'A missed check-in opens a human relay request. Check-ins confirm availability, not safety.'
                    : 'Scheduled checks continue. A human guardian must be approved to join.'}
                </p>
                {trip.guardian && (
                  <p>
                    {trip.lastGuardianCheckInAt
                      ? `Last guardian check-in: ${timeLabel(trip.lastGuardianCheckInAt)}.`
                      : 'Waiting for the guardian’s first check-in.'}
                  </p>
                )}
              </div>
            )}
            {!closed && (
              <div className="guardian-actions">
                {!rider && trip.guardian?.id === user.id && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: trip.guardMode === 'ai' ? 'resume' : 'check-in',
                      }).catch(() => {})
                    }
                  >
                    <Check size={16} />
                    {trip.guardMode === 'ai'
                      ? 'Resume & check in'
                      : 'I am here · Check in'}
                  </Button>
                )}
                {trip.status === 'active' &&
                  trip.guardMode === 'human' &&
                  !rider && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void act({ action: 'takeover' }).catch(() => {})
                      }
                    >
                      <Moon size={15} />
                      I am unavailable
                    </Button>
                  )}
              </div>
            )}
          </article>
          <HumanGuarding
            trip={trip}
            user={user}
            token={token}
            now={now}
            busy={busy}
            act={act}
            share={share}
          />
          <article className="chat-card">
            <div className="card-header">
              <h3>
                <Sparkles size={15} /> Journey conversation
              </h3>
              {voiceConfigured && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Read latest companion message aloud"
                  disabled={voiceBusy}
                  onClick={() => void speak()}
                >
                  <Volume2 size={15} />
                </Button>
              )}
            </div>
            <div
              className="messages"
              aria-live="polite"
              aria-relevant="additions"
            >
              {trip.messages.length === 0 ? (
                <div className="chat-empty">
                  <HeartHandshake size={25} />
                  <p>Your check-ins and conversation will appear here.</p>
                </div>
              ) : (
                trip.messages.slice(-35).map((message) => (
                  <div
                    className={`message ${message.senderId === user.id ? 'mine' : ''} ${message.role === 'agent' ? 'agent-message' : ''}`}
                    key={message.id}
                  >
                    <div>
                      <strong>
                        {message.senderId === user.id
                          ? 'You'
                          : message.senderName}
                      </strong>
                      <time>{timeLabel(message.at)}</time>
                    </div>
                    <p>{message.text}</p>
                  </div>
                ))
              )}
              <div ref={messagesEnd} />
            </div>
            {!closed && (
              <form
                className="message-form"
                onSubmit={(event) => void send(event).catch(() => {})}
              >
                <Input
                  aria-label="Message your circle"
                  placeholder="A quick check-in…"
                  maxLength={1500}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
                <Button
                  size="icon"
                  type="submit"
                  aria-label="Send message"
                  disabled={busy || !text.trim()}
                >
                  <Send size={16} />
                </Button>
              </form>
            )}
          </article>
          {trip.notifications.length > 0 && (
            <article className="notification-card">
              <h3>Contact alerts</h3>
              {trip.notifications.slice(-3).map((n) => (
                <div
                  className={`notification-item ${n.status === 'failed' ? 'failed' : ''}`}
                  key={n.id}
                >
                  <div>
                    <strong>
                      {n.status === 'simulated'
                        ? 'Demo alert'
                        : n.status === 'sent'
                          ? 'Provider accepted'
                          : n.status === 'failed'
                            ? 'Not delivered'
                            : n.status === 'acknowledged'
                              ? 'Acknowledged'
                              : 'Pending'}
                    </strong>
                    <time>{timeLabel(n.at)}</time>
                  </div>
                  <p>{n.detail}</p>
                </div>
              ))}
            </article>
          )}
        </aside>
      </div>
      {info && (
        <output className="notice">
          {info}
          <button onClick={() => setInfo('')} aria-label="Dismiss notification">
            ×
          </button>
        </output>
      )}
      {!closed && rider && (
        <div className="cancel-row">
          <button
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'End this journey? Check-ins and companion monitoring will stop.',
                )
              )
                void act({ action: 'cancel' }).catch(() => {});
            }}
          >
            Cancel journey
          </button>
        </div>
      )}
      {!trip.demo && <JourneyCommunityRecords tripId={trip.id} token={token} viewerId={user.id} />}
      <JourneyPrivacy trip={trip} user={user} token={token} />
    </>
  );
}
function LockIcon() {
  return <ShieldCheck size={17} />;
}
