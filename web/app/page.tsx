'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  useSessionValue,
  useClientReady,
  useInvite,
} from '@/lib/session-storage';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ArrowRight,
  ArrowUpRight,
  ShieldCheck,
  HeartHandshake,
  Route,
  Sparkles,
  Plus,
  CircleHelp,
  Leaf,
  LockKeyhole,
  Check,
  Clock3,
  RefreshCw,
  AlertCircle,
  ExternalLink,
  LogOut,
  Users,
  Wallet,
  Hexagon,
  Radio,
  ChevronRight,
  Layers3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CreateJourney } from '@/components/create-journey';
import { TripDetail, type ActionBody } from '@/components/trip-detail';
import { GuardianInvitation } from '@/components/human-guarding';
import { AccountPanel } from '@/components/account-panel';
import { JourneyChain, submitChainOperation } from '@/components/journey-chain';
import { ChainProof, type ChainConfig } from '@/components/chain-proof';
import { MemberProfileCard } from '@/components/member-profile';
import { api, errorMessage, timeLabel } from '@/lib/api';
import type { Session, Trip, TripList, TripSummary, User } from '@/lib/types';

interface Config {
  ai: { provider: string; configured: boolean; model: string | null };
  notifications: { provider: string; configured: boolean };
  voice: { configured: boolean };
  chain: ChainConfig;
  chainV2: { configured: boolean; programId: string | null; network: string };
}
type Tab = 'journeys' | 'community' | 'impact' | 'about';
const titles: Record<Tab, string> = {
  journeys: 'My journeys',
  community: 'Guard network',
  impact: 'My community profile',
  about: 'How it works',
};
const isTrip = (trip: Trip | TripSummary | undefined): trip is Trip =>
  Boolean(trip && 'origin' in trip);
export default function Home() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 1500, refetchOnWindowFocus: true },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <GuardApp />
    </QueryClientProvider>
  );
}
function GuardApp() {
  const cache = useQueryClient();
  const [rawSession, setRawSession] = useSessionValue('guard:session');
  const session = useMemo((): Session | null => {
    try {
      const parsed = JSON.parse(rawSession || 'null') as Session | null;
      return parsed &&
        typeof parsed.token === 'string' &&
        typeof parsed.user?.id === 'string' &&
        typeof parsed.user?.name === 'string'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }, [rawSession]);
  const joined = useClientReady();
  const invite = useInvite();
  const [tab, setTab] = useState<Tab>('journeys');
  const [name, setName] = useState(''),
    [chosenId, setSelected] = useState(''),
    [createOpen, setCreateOpen] = useState(false),
    [proofOpen, setProofOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => api<Config>('/config'),
    retry: 1,
    refetchInterval: 30000,
  });
  const userQuery = useQuery({
    queryKey: ['me', session?.user.id],
    queryFn: () => api<{ user: User }>('/me', session!.token),
    enabled: Boolean(session),
    refetchInterval: 8000,
  });
  const trips = useQuery({
    queryKey: ['trips', session?.user.id],
    queryFn: () => api<TripList>('/trips', session!.token),
    enabled: Boolean(session),
    refetchInterval: 4000,
  });
  const selected =
    chosenId ||
    invite ||
    trips.data?.myTrips.find(
      (t) => t.status === 'active' || t.status === 'open',
    )?.id ||
    trips.data?.myTrips[0]?.id ||
    '';
  const selectedQuery = useQuery({
    queryKey: ['trip', session?.user.id, selected],
    queryFn: () =>
      api<{ trip: Trip | TripSummary }>(`/trips/${selected}`, session!.token),
    enabled: Boolean(session && selected),
    refetchInterval: 2000,
  });
  const user = userQuery.data?.user || session?.user;
  const commitments = useQuery({
    queryKey: ['commitments', session?.user.id],
    queryFn: () =>
      api<{ journeys: Pick<Trip, 'id' | 'status' | 'chainEnabled'>[] }>(
        '/commitments',
        session!.token,
      ),
    enabled: Boolean(session && tab === 'impact'),
    refetchInterval: 15000,
  });
  const [receiptId, setReceiptId] = useState('');
  const current = selectedQuery.isError ? undefined : selectedQuery.data?.trip;
  function choose(trip: Trip | TripSummary) {
    setSelected(trip.id);
    setTab('journeys');
    cache.setQueryData(['trip', session?.user.id, trip.id], { trip });
    void cache.invalidateQueries({ queryKey: ['trips'] });
  }
  async function join(demo: boolean = false) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      let identity = session;
      if (!identity) {
        identity = await api<Session>('/session', undefined, {
          name: name.trim() || (demo ? 'Demo rider' : ''),
        });
        setRawSession(JSON.stringify(identity));
      }
      if (demo) {
        const { trip } = await api<{ trip: Trip }>(
          '/demo/start',
          identity.token,
          {},
        );
        setSelected(trip.id);
        cache.setQueryData(['trip', identity.user.id, trip.id], { trip });
        setTab('journeys');
        void cache.invalidateQueries({ queryKey: ['trips'] });
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function action(body: ActionBody, id = selected) {
    if (!session || busy) return;
    setBusy(true);
    setError('');
    try {
      if (body.action === 'approve-guardian' && current?.chainEnabled) {
        await submitChainOperation(
          id,
          session.token,
          'propose',
          body.requestId,
        );
        await cache.invalidateQueries({ queryKey: ['chain'] });
        return;
      }
      const { trip } = await api<{ trip: Trip | TripSummary }>(
        `/trips/${id}/actions`,
        session.token,
        body,
      );
      choose(trip);
      void cache.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      setError(errorMessage(e));
      void cache.invalidateQueries({ queryKey: ['trip', session.user.id, id] });
      void cache.invalidateQueries({ queryKey: ['trips'] });
      throw e;
    } finally {
      setBusy(false);
    }
  }
  function updateSession(value: Session | null) {
    setRawSession(value ? JSON.stringify(value) : null);
    setSelected('');
    cache.clear();
  }
  async function logout() {
    if (!session || busy) return;
    if (
      !user?.wallet &&
      !window.confirm(
        'This account has no linked wallet. Signing out will lose access. Continue?',
      )
    )
      return;
    setBusy(true);
    try {
      await api('/auth/logout', session.token, {});
      updateSession(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  const outstanding =
    trips.data?.myTrips.filter(
      (t) => t.status === 'open' || t.status === 'active',
    ).length || 0;
  const openRequests = (trips.data?.trips || []).filter(
    (trip) =>
      trip.requestId && trip.requestExpiresAt && trip.requestKind !== null,
  );
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="brand" href="/">
          <span className="brand-symbol">
            <ShieldCheck size={25} strokeWidth={1.8} />
          </span>
          <span>
            safety<span className="brand-light">guard</span>
            <i>THE HUMAN SAFETY NETWORK</i>
          </span>
        </Link>
        <div className="sidebar-label">
          WORKSPACE <span>01 — 04</span>
        </div>
        <nav aria-label="Main navigation">
          {[
            { id: 'journeys' as Tab, icon: Route },
            { id: 'community' as Tab, icon: HeartHandshake },
            { id: 'impact' as Tab, icon: Hexagon },
            { id: 'about' as Tab, icon: CircleHelp },
          ].map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              <item.icon size={19} />
              <span>{titles[item.id]}</span>
              {item.id === 'journeys' && outstanding > 0 && (
                <span className="nav-count">{outstanding}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-icon">
            <HeartHandshake size={21} />
          </span>
          <h3>
            Be someone’s
            <br />
            way home.
          </h3>
          <p>
            Your time makes a difference. Join a journey. Make a connection.
          </p>
          <button className="sidebar-cta" onClick={() => setTab('community')}>
            Join the network <ArrowUpRight size={15} />
          </button>
        </div>
        <div className="sidebar-network">
          <Layers3 size={19} />
          <div>
            <strong>Built on Solana</strong>
            <span>DEVNET · TEST NETWORK</span>
          </div>
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="workspace-label">Workspace</span>
            <ChevronRight size={13} />
            <strong>{titles[tab]}</strong>
          </div>
          <div className="topbar-right">
            <span
              className={`network-status ${config.isError ? 'unavailable' : ''}`}
            >
              <span />{' '}
              {config.isError
                ? 'Connection unavailable'
                : config.data
                  ? 'Solana Devnet'
                  : 'Connecting…'}
            </span>
            <Button
              variant="outline"
              className="wallet-button"
              onClick={() => setAccountOpen(true)}
            >
              <Wallet size={16} />
              {user?.wallet
                ? `${user.wallet.slice(0, 4)}…${user.wallet.slice(-4)}`
                : session
                  ? 'Account & wallet'
                  : 'Wallet sign in'}
            </Button>
            {user && (
              <>
                <span className="avatar user-avatar" title={user.name}>
                  {user.name.slice(0, 1).toUpperCase()}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Sign out"
                  onClick={() => void logout()}
                >
                  <LogOut size={15} />
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="page-content" id="main-content" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {tab === 'community'
                  ? 'SHOW UP. MAKE A DIFFERENCE.'
                  : tab === 'impact'
                    ? 'YOUR CONTRIBUTIONS, RECOGNIZED'
                    : 'HUMAN CONNECTION. ON-CHAIN COMMITMENT.'}
              </div>
              <h1>
                {tab === 'journeys'
                  ? user
                    ? `Welcome back, ${user.name}.`
                    : 'Your journey hub.'
                  : tab === 'community'
                    ? 'Find your next act of care.'
                    : tab === 'impact'
                      ? 'Your impact, on record.'
                      : 'A better way to get there.'}
              </h1>
              <p>
                {tab === 'journeys'
                  ? 'Your people. Your journey. A little more peace of mind.'
                  : tab === 'community'
                    ? 'Offer your time, meet the person, and accompany their journey.'
                    : tab === 'impact'
                      ? 'Your contributions to a more connected community.'
                      : 'A clear commitment, a thoughtful handoff, a shared arrival.'}
              </p>
            </div>
            {session && tab !== 'about' ? (
              <Button
                className="new-journey"
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={16} />
                New journey
              </Button>
            ) : (
              <span className="network-badge">
                <LockKeyhole size={13} />
                Private by design
              </span>
            )}
          </div>
          {error && (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              <span>{error}</span>
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {(trips.isError || selectedQuery.isError) && session && (
            <div className="error-banner" role="alert">
              <AlertCircle size={17} />
              <span>
                {errorMessage(trips.error || selectedQuery.error)} Previously
                displayed information may be stale.
              </span>
              <Button
                variant="outline"
                onClick={() => {
                  void trips.refetch();
                  void selectedQuery.refetch();
                }}
              >
                <RefreshCw size={13} />
                Retry
              </Button>
            </div>
          )}
          {tab === 'about' ? (
            <About config={config.data} />
          ) : !session ? (
            <>
              <section className="welcome-grid">
                <article className="welcome-panel">
                  <span className="pill">
                    <Radio size={14} /> POWERED BY PEOPLE
                  </span>
                  <h2>
                    Go together.
                    <br />
                    <span>Get home.</span>
                  </h2>
                  <p>
                    A real person on the other end of your journey. Choose your
                    guardian, stay connected, and pass the watch when life
                    happens.
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void join();
                    }}
                  >
                    <label className="field-label" htmlFor="welcome-name">
                      Start with your name
                    </label>
                    <Input
                      id="welcome-name"
                      placeholder="Your first name"
                      value={name}
                      maxLength={60}
                      required
                      onChange={(e) => setName(e.target.value)}
                    />
                    <Button
                      type="submit"
                      className="primary-action"
                      disabled={busy || !name.trim() || !joined}
                    >
                      {busy ? 'Creating your account…' : 'Enter Safety Guard'}
                      <ArrowRight size={17} />
                    </Button>
                  </form>
                  <button
                    className="demo-link"
                    onClick={() => void join(true)}
                    disabled={busy || !joined}
                  >
                    <Sparkles size={14} />
                    Explore a demo journey
                    <ArrowUpRight size={13} />
                  </button>
                  <span className="small-note">
                    No wallet needed to start. Your guest session stays in this
                    tab. Your name, introduction and contributions are always visible to community members. Before your first real journey, you will review how public Solana community records work.
                  </span>
                </article>
                <GuardIdentityCard />
              </section>
              <Steps />
            </>
          ) : tab === 'community' ? (
            <section className="community-area">
              <div className="community-intro">
                <Users size={25} />
                <div>
                  <h2>Guardian &amp; relay requests</h2>
                  <p>
                    Journey details stay private until the rider approves you.
                    Apply when you can commit to regular check-ins.
                  </p>
                </div>
              </div>
              {trips.isPending ? (
                <p className="muted">Finding open journeys…</p>
              ) : openRequests.length ? (
                <div className="community-grid">
                  {openRequests.map((t) => (
                    <article className="open-trip" key={t.id}>
                      <span className="pill">
                        {t.requestKind === 'relay'
                          ? 'RELAY REQUESTED'
                          : 'GUARDIAN REQUESTED'}
                      </span>
                      <h3>{t.riderProfile?.name || 'A community member'} needs a guardian</h3>
                      <p>
                        Journey {t.id.slice(0, 8)} · Created{' '}
                        {timeLabel(t.createdAt)}
                      </p>
                      <div>
                        <Clock3 size={15} />
                        Check in every {t.checkInIntervalSeconds}s
                        <span>Volunteer companionship · Free</span>
                      </div>
                      <Button disabled={busy} onClick={() => choose(t)}>
                        Review request
                        <HeartHandshake size={16} />
                      </Button>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty
                  title="All quiet in the network."
                  text="No open journeys right now. A friend's invite will appear here when they create a journey."
                  action={
                    <Button
                      variant="outline"
                      onClick={() => void trips.refetch()}
                    >
                      <RefreshCw size={14} />
                      Check again
                    </Button>
                  }
                />
              )}
              <div className="tip-card">
                <ShieldCheck size={20} />
                <p>
                  To try both roles, create a journey here and open its invite
                  in a private window with a different name.
                </p>
              </div>
            </section>
          ) : tab === 'impact' ? (
            <>
              {user && <MemberProfileCard memberId={user.id} viewerId={user.id} token={session.token} editable />}
              {commitments.data?.journeys.length ? (
                <article className="human-relay-card">
                  <h3>Your chain journeys</h3>
                  <p>
                    Receipts and reward claims stay accessible after another
                    guardian takes over.
                  </p>
                  <label className="field-label" htmlFor="receipt-journey">
                    Choose a journey
                  </label>
                  <select
                    id="receipt-journey"
                    value={receiptId}
                    onChange={(e) => setReceiptId(e.target.value)}
                  >
                    <option value="">Select a journey receipt</option>
                    {commitments.data.journeys.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.id.slice(0, 8)} · {item.status}
                      </option>
                    ))}
                  </select>
                </article>
              ) : null}
              {session &&
                user &&
                commitments.data?.journeys.find(
                  (item) => item.id === receiptId,
                ) && (
                  <JourneyChain
                    key={receiptId}
                    trip={commitments.data.journeys.find(
                      (item) => item.id === receiptId,
                    )!}
                    user={user}
                    token={session.token}
                  />
                )}
              <div className="tip-card">
                <Leaf size={22} />
                <div>
                  <h3>Earned through showing up.</h3>
                  <p>
                    A completed journey shares one fixed pool of 25 points and
                    10 reputation equally among guardians who checked in.
                    Repeated check-ins or handoffs cannot enlarge the pool.
                    Community records are published automatically; pending
                    contributions stay separate until chain confirmation.
                  </p>
                </div>
              </div>
              <JourneyHistory
                journeys={(trips.data?.myTrips || []).filter(isTrip)}
                onChoose={choose}
              />
            </>
          ) : (
            <>
              {trips.data && trips.data.myTrips.length > 1 && (
                <div className="trip-switcher">
                  {trips.data.myTrips.slice(0, 8).map((t) => (
                    <button
                      className={selected === t.id ? 'selected' : ''}
                      onClick={() => choose(t)}
                      key={t.id}
                    >
                      {t.demo
                        ? 'Demo'
                        : isTrip(t)
                          ? t.destination.label
                          : t.application
                            ? 'Awaiting approval'
                            : 'Guardian request'}
                      <span>{t.status}</span>
                    </button>
                  ))}
                </div>
              )}
              {current?.chainEnabled && user && (
                <JourneyChain
                  key={`chain-${current.id}`}
                  trip={current}
                  riderProfile={isTrip(current) ? current.rider : current.riderProfile}
                  user={user}
                  token={session.token}
                />
              )}
              {isTrip(current) && user ? (
                <TripDetail
                  key={current.id}
                  trip={current}
                  user={user}
                  token={session.token}
                  busy={busy}
                  act={action}
                  onProof={() => setProofOpen(true)}
                  voiceConfigured={Boolean(config.data?.voice.configured)}
                />
              ) : current && !isTrip(current) ? (
                <GuardianInvitation
                  key={current.id}
                  request={current}
                  token={session.token}
                  viewerId={session.user.id}
                  busy={busy}
                  act={action}
                />
              ) : selectedQuery.isError && selected ? (
                <Empty
                  title="Journey unavailable"
                  text="This journey could not be loaded. Your access may have changed after a handoff."
                  action={
                    <>
                      <Button
                        variant="outline"
                        onClick={() => void selectedQuery.refetch()}
                      >
                        Try again
                      </Button>
                      <Button onClick={() => setTab('community')}>
                        Find a guardian request
                      </Button>
                    </>
                  }
                />
              ) : selectedQuery.isPending && selected ? (
                <div className="loading-state">
                  <RefreshCw size={22} />
                  <span>Connecting to your journey…</span>
                </div>
              ) : (
                <>
                  <section className="welcome-grid">
                    <article className="welcome-panel signed-in-welcome">
                      <span className="pill">
                        <Radio size={14} /> YOUR NEXT JOURNEY
                      </span>
                      <h2>
                        Your next stop.
                        <br />
                        <span>Someone along.</span>
                      </h2>
                      <p>
                        Start a journey and share an invite with your guardian.
                        Approve who joins and arrange a human relay when needed.
                      </p>
                      <Button
                        className="primary-action"
                        onClick={() => setCreateOpen(true)}
                      >
                        Start a guarded journey
                        <Plus size={17} />
                      </Button>
                      <button
                        className="demo-link"
                        disabled={busy}
                        onClick={() => void join(true)}
                      >
                        <Sparkles size={15} />
                        Explore a demo journey
                        <ArrowUpRight size={13} />
                      </button>
                    </article>
                    <GuardIdentityCard />
                  </section>
                  <Steps />
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <ShieldCheck size={14} /> Human care. Verifiable contributions.
            </span>
            <span>
              {config.data?.ai.provider === 'mock'
                ? 'Offline mock companion'
                : 'Rules-based companion'}{' '}
              ·{' '}
              {config.data?.notifications.configured
                ? 'Alerts connected'
                : 'External alerts not connected'}
            </span>
          </footer>
        </div>
        {session && (
          <CreateJourney
            open={createOpen}
            onOpenChange={setCreateOpen}
            token={session.token}
            chainAvailable={Boolean(
              user?.wallet && config.data?.chainV2?.configured,
            )}
            onCreated={choose}
          />
        )}
        <AccountPanel
          open={accountOpen}
          onOpenChange={setAccountOpen}
          session={session}
          user={user}
          onSession={updateSession}
        />
        {isTrip(current) && !current.chainEnabled && (
          <ChainProof
            key={current.id}
            trip={current}
            config={config.data?.chain}
            open={proofOpen}
            onOpenChange={setProofOpen}
          />
        )}
      </main>
    </div>
  );
}
function Steps() {
  return (
    <>
      <div className="section-heading">
        <h2>A little connection. A lot of peace of mind.</h2>
        <span>THE GUARD FLOW</span>
      </div>
      <section className="steps-grid">
        {[
          {
            icon: Plus,
            title: 'Create a journey',
            text: 'Choose your destination and invite someone to look out for you.',
          },
          {
            icon: HeartHandshake,
            title: 'Connect. Check in. Relay.',
            text: 'Choose a guardian, exchange check-ins, and approve a replacement when needed.',
          },
          {
            icon: ShieldCheck,
            title: 'Close the journey. Say thanks.',
            text: 'End your journey independently. A free appreciation banner is always optional.',
          },
        ].map((s, i) => (
          <article className="step-card" key={s.title}>
            <div className="step-top">
              <s.icon size={21} />
              <span>0{i + 1}</span>
            </div>
            <h3>{s.title}</h3>
            <p>{s.text}</p>
          </article>
        ))}
      </section>
    </>
  );
}
function GuardIdentityCard() {
  return (
    <article
      className="guard-identity-card"
      aria-label="Free community companionship"
    >
      <div className="identity-card-top">
        <span>
          <ShieldCheck size={14} /> THE GUARD COMMITMENT
        </span>
        <span className="identity-chain-tag">SOLANA</span>
      </div>
      <div className="identity-art">
          <Image
          src="/images/guard-shield.png"
          alt="Glass shield with a chrome orbit and a green glow"
          width={1536}
          height={1024}
            priority
            unoptimized
        />
      </div>
      <div className="identity-card-copy">
        <span className="identity-kicker">REAL PEOPLE. SHARED PURPOSE.</span>
        <h2>
          Good company.
          <br />
          Verifiable impact.
        </h2>
        <p>Give your time. Share a journey. Recognize the care.</p>
      </div>
      <div className="identity-rewards">
        <div>
          <strong>
            FREE
          </strong>
          <span>Volunteer companionship</span>
        </div>
        <div>
          <strong>
            OPEN
          </strong>
          <span>Community contributions</span>
        </div>
        <span className="reward-mark">
          <Hexagon size={28} strokeWidth={1.2} />
        </span>
      </div>
      <p className="identity-fineprint">
        Community profiles are visible before you choose each other.
      </p>
    </article>
  );
}
function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty-state">
      <HeartHandshake size={34} />
      <h2>{title}</h2>
      <p>{text}</p>
      {action}
    </div>
  );
}
function JourneyHistory({
  journeys,
  onChoose,
}: {
  journeys: Trip[];
  onChoose: (trip: Trip) => void;
}) {
  return (
    <>
      <div className="section-heading">
        <h2>Your journey history</h2>
        <span>{journeys.length} JOURNEYS</span>
      </div>
      {journeys.length ? (
        <div className="history-list">
          {journeys.map((t) => (
            <button key={t.id} onClick={() => onChoose(t)}>
              <Route size={20} />
              <div>
                <strong>
                  {t.origin.label} → {t.destination.label}
                </strong>
                <span>
                  {t.demo ? 'Demo journey' : 'Community journey'} ·{' '}
                  {new Date(t.createdAt).toLocaleDateString()}
                </span>
              </div>
              <span className="status-pill">{t.status}</span>
              <ArrowRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <Empty
          title="Your first act of care starts here."
          text="Guard a community journey to begin building your contribution history."
        />
      )}
    </>
  );
}
function About({ config }: { config?: Config }) {
  return (
    <>
      <Steps />
      <div className="about-grid">
        <article className="information-card">
          <h2>Human care, with an agreed handoff.</h2>
          <p>
            A guardian applies to a clear check-in commitment, and the rider
            approves access. If they need a break or miss a check-in, a relay
            request opens. The rider approves a replacement before access
            changes. Scheduled reminders continue while no human has confirmed
            coverage.
          </p>
          <p>
            This prototype coordinates check-ins. It does not verify a driver’s
            behavior or replace emergency services.
          </p>
        </article>
        <article className="information-card">
          <h2>Your contribution, with a record.</h2>
          <p>
            New guarding history, contributions and appreciation banners are
            recorded on Solana under community identifiers. Safety Guard sponsors
            publication so a wallet or payment is not required. Routes, names
            and conversations stay off chain.
          </p>
          <p>
            Contributions cannot be bought or transferred. Platform attestations
            identify what the service recorded; they do not independently prove
            real-world safety. Demo journeys earn no community recognition.
          </p>
        </article>
      </div>
      <div className="section-heading">
        <h2>What is connected</h2>
        <span>NO GUESSWORK</span>
      </div>
      <div className="integration-list">
        {[
          {
            title: 'Journey state & timers',
            value: config ? 'Cloudflare Durable Objects' : 'Connecting…',
            ok: Boolean(config),
          },
          {
            title: 'Companion intelligence',
            value: config?.ai.provider === 'mock'
              ? 'Offline mock agent · no live AI API'
              : 'Deterministic rules fallback',
            ok: config?.ai.provider === 'mock',
          },
          {
            title: 'Contact notifications',
            value: config?.notifications.configured
              ? 'Notification provider connected'
              : 'Not connected · no external delivery',
            ok: Boolean(config?.notifications.configured),
          },
          {
            title: 'Voice',
            value: config?.voice.configured
              ? 'ElevenLabs connected'
              : 'Not connected',
            ok: Boolean(config?.voice.configured),
          },
          {
            title: 'Blockchain receipts',
            value: config?.chain.configured
              ? 'Solana configured · deployment checked before signing'
              : 'Not deployed / configured',
            ok: Boolean(config?.chain.configured),
          },
          {
            title: 'Uber',
            value: 'Shared links only · no automatic telemetry',
            ok: false,
          },
        ].map((i) => (
          <div key={i.title}>
            <span>{i.title}</span>
            <strong>
              {i.ok ? <Check size={15} /> : <Clock3 size={15} />} {i.value}
            </strong>
          </div>
        ))}
      </div>
      <div className="tip-card">
        <LockKeyhole size={20} />
        <p>
          Journey details are hidden from public listings. Map providers receive
          the viewed map area. If configured, AI receives message context and
          authorized contact providers receive alert details. Demo alerts never
          leave this app.
        </p>
      </div>
      <a
        className="text-action"
        href="https://hackthenorth2026.devpost.com/"
        target="_blank"
        rel="noopener noreferrer"
      >
        Built for Hack the North 2026
        <ExternalLink size={13} />
      </a>
    </>
  );
}
