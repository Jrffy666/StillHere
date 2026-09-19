'use client';
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSessionValue, useClientReady, useInvite } from '@/lib/session-storage';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, ShieldCheck, HeartHandshake, Route, Plus, RefreshCw, AlertCircle, LogOut, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { CreateJourney } from '@/components/create-journey';
import { TripDetail, type ActionBody } from '@/components/trip-detail';
import { GuardianInvitation } from '@/components/human-guarding';
import { AccountPanel } from '@/components/account-panel';
import { JourneyChain, submitChainOperation } from '@/components/journey-chain';
import { MemberProfileCard } from '@/components/member-profile';
import { api, errorMessage } from '@/lib/api';
import type { Session, Trip, TripList, TripSummary, User } from '@/lib/types';

interface Config { chainV2: { configured: boolean } }
type Tab = 'journeys' | 'community' | 'impact';
const titles: Record<Tab, string> = { journeys: 'My journeys', community: 'Guard network', impact: 'My profile' };
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
    [createOpen, setCreateOpen] = useState(false);
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
  async function join() {
    if (busy || !name.trim()) return;
    setBusy(true); setError('');
    try {
      const identity = await api<Session>('/session', undefined, { name: name.trim() });
      setRawSession(JSON.stringify(identity));
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
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
  const openRequests = (trips.data?.trips || []).filter(item => item.requestId && item.requestExpiresAt && item.requestKind);
  const savedCommitment = commitments.data?.journeys.find(item => item.id === receiptId);
  return (
    <div className="simple-app">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="simple-header">
        <Link href="/" className="simple-brand"><ShieldCheck size={23} /> safety<span>guard</span></Link>
        {session && <nav className="simple-nav" aria-label="Main navigation">
          {([{ id: 'journeys', icon: Route }, { id: 'community', icon: HeartHandshake }, { id: 'impact', icon: UserRound }] as const).map(item => (
            <Button key={item.id} variant="ghost" aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}>
              <item.icon size={16} />{titles[item.id]}
            </Button>
          ))}
        </nav>}
        <div className="simple-account">
          <Button variant="ghost" onClick={() => setAccountOpen(true)}><UserRound size={16} />{session ? 'Account' : 'Sign in with wallet'}</Button>
          {session && <Button variant="ghost" size="icon" aria-label="Sign out" disabled={busy} onClick={() => void logout()}><LogOut size={15} /></Button>}
        </div>
      </header>
      <main className="simple-main" id="main-content" tabIndex={-1}>
        {session && <div className="simple-heading">
          <div><h1>{titles[tab]}</h1><p>{tab === 'journeys' ? 'Choose a guardian. Check in. Arrive together.' : tab === 'community' ? 'Offer your time to someone on their way.' : 'Your contributions and the thanks you received.'}</p></div>
          {tab === 'journeys' && <Button onClick={() => setCreateOpen(true)}><Plus size={16} />New journey</Button>}
        </div>}
        {error && <div className="error-banner" role="alert"><AlertCircle size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {(trips.isError || selectedQuery.isError) && session && <div className="error-banner" role="alert">
          <span>{errorMessage(trips.error || selectedQuery.error)} Previously displayed information may be stale.</span>
          <Button variant="outline" onClick={() => { void trips.refetch(); void selectedQuery.refetch(); }}>Retry</Button>
        </div>}
        {!session ? <section className="simple-welcome">
          <ShieldCheck size={35} strokeWidth={1.5} />
          <h1>Go together.</h1><p>Find someone to accompany your journey, or be there for theirs. Always free.</p>
          <form onSubmit={event => { event.preventDefault(); void join(); }}>
            <label className="field-label" htmlFor="welcome-name">Your name</label>
            <Input id="welcome-name" placeholder="First name" value={name} maxLength={60} required onChange={event => setName(event.target.value)} />
            <Button type="submit" className="primary-action" disabled={busy || !name.trim() || !joined}>{busy ? 'Joining…' : 'Enter Safety Guard'}<ArrowRight size={16} /></Button>
          </form>
          <p className="simple-note">No wallet needed. Keep this tab open to retain your guest account. Member profiles and contributions are visible to the community.</p>
        </section> : tab === 'community' ? <section>
          {trips.isPending ? <output>Loading requests…</output> : openRequests.length ? <div className="simple-request-list">
            {openRequests.map(request => <article className="simple-request" key={request.id}>
              <div><span className="simple-label">{request.requestKind === 'relay' ? 'Relay requested' : 'Guardian requested'}</span>
                <h2>{request.riderProfile?.name || 'A community member'}</h2><p>Check in every {request.checkInIntervalSeconds} seconds.</p></div>
              <Button disabled={busy} onClick={() => choose(request)}>Review request<ArrowRight size={15} /></Button>
            </article>)}
          </div> : <Empty title="No open requests" text="New guardian and relay requests will appear here." action={<Button variant="outline" onClick={() => void trips.refetch()}><RefreshCw size={14} />Refresh</Button>} />}
          <p className="simple-note">Review each other’s profiles before joining. Route and conversation are shared after approval.</p>
        </section> : tab === 'impact' ? <>
          {user && <MemberProfileCard memberId={user.id} viewerId={user.id} token={session.token} editable />}
          {Boolean(commitments.data?.journeys.length) && <details className="simple-details">
            <summary>Wallet-signed journeys</summary>
            <p className="simple-note">Access signed commitments and claims, including journeys you handed over.</p>
            <label className="field-label" htmlFor="receipt-journey">Choose a signed journey</label>
            <NativeSelect id="receipt-journey" value={receiptId} onChange={event => setReceiptId(event.target.value)}>
              <NativeSelectOption value="">Select a journey</NativeSelectOption>
              {commitments.data?.journeys.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.id.slice(0, 8)} · {item.status}</NativeSelectOption>)}
            </NativeSelect>
            {savedCommitment && user && <JourneyChain key={receiptId} trip={savedCommitment} user={user} token={session.token} />}
          </details>}
          {commitments.isError && <p role="alert" className="inline-error">Signed journeys could not load. <button onClick={() => void commitments.refetch()}>Retry</button></p>}
        </> : <>
          {Boolean(trips.data?.myTrips.length) && <div className="simple-trip-picker">
            <label htmlFor="journey-picker">Journey</label>
            <NativeSelect id="journey-picker" value={selected} onChange={event => { const item = trips.data?.myTrips.find(trip => trip.id === event.target.value); if (item) choose(item); }}>
              {!trips.data?.myTrips.some(item => item.id === selected) && <NativeSelectOption value={selected}>Opened invitation</NativeSelectOption>}
              {trips.data?.myTrips.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.demo ? 'Sample journey' : isTrip(item) ? item.destination.label : 'Journey ' + item.id.slice(0, 8)} · {item.status}</NativeSelectOption>)}
            </NativeSelect>
          </div>}
          {current?.chainEnabled && user && <details className="simple-details" open>
            <summary>Wallet-signed commitment</summary>
            <JourneyChain key={'chain-' + current.id} trip={current} riderProfile={isTrip(current) ? current.rider : current.riderProfile} user={user} token={session.token} />
          </details>}
          {isTrip(current) && user ? <TripDetail key={current.id} trip={current} user={user} token={session.token} busy={busy} act={action} onProfile={() => setTab('impact')} />
            : current && !isTrip(current) ? <GuardianInvitation key={current.id} request={current} token={session.token} viewerId={session.user.id} busy={busy} act={action} />
            : selectedQuery.isError && selected ? <Empty title="Journey unavailable" text="Your access may have changed after a handoff." action={<Button onClick={() => setTab('community')}>Find another journey</Button>} />
            : (selectedQuery.isPending && selected) || trips.isPending ? <output>Loading your journeys…</output>
            : <Empty title="Where are you headed?" text="Start a journey and invite a guardian, or offer to accompany someone." action={<><Button onClick={() => setCreateOpen(true)}><Plus size={16} />New journey</Button><Button variant="outline" onClick={() => setTab('community')}>Guard someone</Button></>} />}
        </>}
        <footer className="simple-footer"><span>Free human companionship</span><span>Solana Devnet · Not an emergency service</span></footer>
      </main>
      {session && <CreateJourney open={createOpen} onOpenChange={setCreateOpen} token={session.token} chainAvailable={Boolean(user?.wallet && config.data?.chainV2.configured)} onCreated={choose} />}
      <AccountPanel open={accountOpen} onOpenChange={setAccountOpen} session={session} user={user} onSession={updateSession} />
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return <div className="simple-empty"><HeartHandshake size={30} strokeWidth={1.4} /><h2>{title}</h2><p>{text}</p><div>{action}</div></div>;
}
