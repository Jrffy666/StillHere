'use client';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';
import { ArrowRight, Check, HeartHandshake, Send, LocateFixed, ExternalLink, AlertCircle, Clock3 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { JourneyMap } from '@/components/journey-map';
import { HumanGuarding, JourneyParticipation } from '@/components/human-guarding';
import { JourneyPrivacy } from '@/components/journey-privacy';
import { JourneyAssistance } from '@/components/journey-assistance';
import { JourneyGratitudeCard } from '@/components/journey-gratitude';
import { MemberProfileButton } from '@/components/member-profile';
import { JourneyCommunityRecords } from '@/components/community-records';
import { errorMessage, timeLabel } from '@/lib/api';
import { journeyProgress } from '@/lib/journey-progress';
import type { Trip, User } from '@/lib/types';

export type ActionBody = { action: string; requestId?: string; text?: string; lat?: number; lng?: number; scenario?: string };
export function TripDetail({ trip, user, token, busy, act, onProfile }: {
  trip: Trip; user: User; token: string; busy: boolean;
  act: (body: ActionBody) => Promise<void>; onProfile: () => void;
}) {
  const [text, setText] = useState(''),
    [now, setNow] = useState(() => Date.now()),
    [info, setInfo] = useState('');
  const [locationBusy, setLocationBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const watching = useRef<number | null>(null),
    lastLocation = useRef(0);
  const messageViewport = useRef<HTMLDivElement>(null);
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
    const viewport = messageViewport.current;
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [trip.messages.length, historyOpen, closed]);
  useEffect(
    () => () => {
      if (watching.current !== null)
        navigator.geolocation.clearWatch(watching.current);
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
  const progress = journeyProgress(trip);
  const assignedGuardian = !rider && trip.guardian?.id === user.id;
  const [mapOpen, setMapOpen] = useState(false);
  const conversation = <article className="chat-card">
    {!closed && <div className="card-header"><h3><HeartHandshake size={17} />Conversation</h3></div>}
    {closed && trip.messages.length > 35 && <p className="simple-note">Showing the latest 35 messages.</p>}
    <div ref={messageViewport} className="messages" aria-live={closed ? 'off' : 'polite'} aria-relevant="additions">
      {trip.messages.length === 0 ? <p className="simple-note">{closed ? 'No messages on this journey.' : 'Say hello to your travel companion.'}</p> : trip.messages.slice(-35).map(message => <div key={message.id} className={'message ' + (message.senderId === user.id ? 'mine' : '') + (message.role === 'agent' ? ' agent-message' : '')}>
        <div><strong>{message.senderId === user.id ? 'You' : message.role === 'agent' ? 'Automated reminder' : message.senderName}</strong><time>{timeLabel(message.at)}</time></div><p>{message.text}</p>
      </div>)}
    </div>
    {!closed && <form className="message-form" onSubmit={event => void send(event).catch(() => {})}>
      <Input aria-label="Message your companion" placeholder="Write a message…" maxLength={1500} value={text} onChange={event => setText(event.target.value)} />
      <Button size="icon" type="submit" aria-label="Send message" disabled={busy || !text.trim()}><Send size={16} /></Button>
    </form>}
  </article>;
  return <>
    {trip.demo && <p className="simple-notice">Sample journey · Simulated participation earns no community contribution.</p>}
    <div className={`journey-workspace ${closed ? 'journey-workspace-ended' : ''}`}>
    <div className="journey-focus">
    <section className="simple-journey" aria-label="Current journey">
      <div className="simple-journey-heading">
        <div><span className="simple-label">{closed ? 'Journey ended' : rider ? 'You are the rider' : 'You are the guardian'}</span>
          <h2>{trip.origin.label}<ArrowRight size={17} />{trip.destination.label}</h2></div>
        <span className={'status-pill ' + (!closed && trip.risk === 'urgent' ? 'urgent' : '')}>
          {trip.status === 'arrived' ? 'Arrived' : trip.status === 'cancelled' ? 'Cancelled' : trip.status === 'open' ? 'Waiting for a guardian' : trip.risk === 'urgent' ? 'Help requested' : 'In progress'}
        </span>
      </div>
      <div className="simple-people">
        <div><strong>{rider ? trip.guardian?.name || 'No guardian yet' : trip.rider.name}</strong>
          <span>{rider ? 'Guardian' : 'Rider'}</span></div>
        {rider && trip.guardian && !trip.guardian.simulated && <MemberProfileButton memberId={trip.guardian.id} name={trip.guardian.name} token={token} viewerId={user.id} />}
        {!rider && <MemberProfileButton memberId={trip.rider.id} name={trip.rider.name} token={token} viewerId={user.id} />}
      </div>
      {!closed && trip.guardian && <div className={'simple-checkin ' + (progress.firstCheckInNeeded ? 'first-checkin' : '')}>
        <div><strong>{progress.firstCheckInNeeded ? assignedGuardian ? 'Start with your first check-in' : 'Waiting for the guardian’s first check-in' : trip.guardMode !== 'human' ? 'A human check-in is needed' : seconds === 0 ? 'Guardian check-in overdue' : 'Next guardian check-in'}
          </strong><p>{progress.firstCheckInNeeded ? 'A guardian must check in before arrival to earn a contribution.' : trip.lastGuardianCheckInAt ? 'Last check-in: ' + timeLabel(trip.lastGuardianCheckInAt) + '. Check-ins confirm availability.' : 'No human has confirmed availability yet.'}</p>
          {seconds !== null && <span className="simple-timer"><Clock3 size={15} />{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</span>}</div>
        {assignedGuardian ? <Button disabled={busy} onClick={() => void act({ action: trip.guardMode === 'ai' ? 'resume' : 'check-in' }).catch(() => {})}>
          <Check size={17} />{trip.guardMode === 'ai' ? 'Resume & check in' : 'I am here · Check in'}
        </Button> : null}
      </div>}
      {!closed && rider && <>
        <div className="simple-primary-actions">
          <Button disabled={busy} onClick={() => void act({ action: 'arrive' }).catch(() => {})}><Check size={16} />I’ve arrived</Button>
          <Button variant="outline" disabled={busy || trip.status !== 'active'} onClick={() => void act({ action: 'check-in' }).catch(() => {})}>I am okay</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void act({ action: 'help', text: 'I need help. Please check my journey.' }).catch(() => {})}><AlertCircle size={16} />I need help</Button>
        </div>
        {progress.checkedGuardians === 0 && !trip.demo && <p className="simple-note">No guardian has checked in. Arriving now will close the journey without contribution points.</p>}
        {trip.risk === 'urgent' && <p className="simple-notice">Help is requested in this app. This does not call emergency services.</p>}
      </>}
      {!closed && assignedGuardian && trip.guardMode === 'human' && <Button variant="ghost" disabled={busy} onClick={() => void act({ action: 'takeover' }).catch(() => {})}>I am unavailable — request cover</Button>}
      {closed && <div className="simple-completion">
        <strong>{progress.noContributionAtArrival ? 'No contribution earned on this journey' : trip.status === 'cancelled' ? 'Journey cancelled' : rider ? 'You have arrived' : 'Your rider has arrived'}</strong>
        <p>{trip.demo ? 'This sample creates no official community contribution.' : progress.noContributionAtArrival ? 'No guardian check-in was recorded before arrival. Arrival is on chain, but it does not award contribution points.' : trip.status === 'cancelled' ? 'Cancelled journeys award no completion points. You can still thank a guardian who checked in.' : 'Check the contribution receipts below for publication status. Your profile counts only confirmed records.'}</p>
        {!trip.demo && <Button variant="outline" onClick={onProfile}>View my contributions</Button>}
      </div>}
    </section>
    {info && <output className="notice">{info}<button onClick={() => setInfo('')} aria-label="Dismiss notification">×</button></output>}
    {!closed && <HumanGuarding trip={trip} user={user} token={token} now={now} busy={busy} act={act} share={share} />}
    {closed && rider && !trip.demo && <JourneyGratitudeCard trip={trip} token={token} viewerId={user.id} />}
    </div>
    {!closed && <div className="journey-conversation">{conversation}</div>}
      <section className="journey-secondary" aria-label="Journey details">
        <JourneyAssistance trip={trip} token={token} viewerId={user.id} busy={busy} act={act} />
        {!trip.demo && <details className="simple-details journey-receipts">
          <summary>Contribution & chain receipts</summary>
          <JourneyParticipation trip={trip} viewerId={user.id} />
          <JourneyCommunityRecords tripId={trip.id} token={token} viewerId={user.id} />
        </details>}
        {trip.demo && trip.contributions.length > 0 && <details className="simple-details">
          <summary>Sample participation</summary><JourneyParticipation trip={trip} viewerId={user.id} />
        </details>}
        {closed && <details className="simple-details conversation-history" open={historyOpen} onToggle={event => setHistoryOpen(event.currentTarget.open)}>
          <summary>Conversation history</summary>{conversation}
        </details>}
        <details className="simple-details" onToggle={event => setMapOpen(event.currentTarget.open)}>
          <summary>Route & shared location</summary>
          {mapOpen && <JourneyMap trip={trip} />}
          <p className="simple-note">Last update {timeLabel(trip.location.updatedAt)} · Visible to journey participants.</p>
          {rider && !closed && <Button variant="outline" disabled={locationBusy || trip.demo || busy} onClick={toggleLocation}><LocateFixed size={15} />{sharing ? 'Pause location' : 'Share location'}</Button>}
          {trip.shareUrl && <a className="text-action" href={trip.shareUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Open Uber link<ExternalLink size={13} /></a>}
        </details>
        <details className="simple-details">
          <summary>Journey activity</summary>
          <div className="activity-list">{[...trip.events].reverse().map(event => <div className="activity-item" key={event.id}><div><strong>{event.title}</strong><p>{event.detail}</p></div><time>{timeLabel(event.at)}</time></div>)}</div>
        </details>
        {trip.notifications.length > 0 && <details className="simple-details"><summary>Contact alert status</summary>
          {trip.notifications.slice(-3).map(notification => <div className="notification-item" key={notification.id}><strong>{notification.status === 'simulated' ? 'Simulated' : notification.status === 'sent' ? 'Provider accepted' : notification.status === 'failed' ? 'Not delivered' : notification.status === 'acknowledged' ? 'Acknowledged' : 'Pending'}</strong><p>{notification.detail}</p></div>)}
        </details>}
        <JourneyPrivacy trip={trip} user={user} token={token} />
      </section>
    </div>
    {!closed && rider && <div className="cancel-row"><button disabled={busy} onClick={() => {
      if (window.confirm('Cancel this journey and stop check-ins?')) void act({ action: 'cancel' }).catch(() => {});
    }}>Cancel journey</button></div>}
  </>;
}
