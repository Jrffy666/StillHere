'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ExternalLink, History, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { communityReceiptUrl, communityRecordLabel, CORRECTION_REASONS, type CommunityRecord, type CommunityCorrection, type MemberRecordsResponse, type JourneyRecordsResponse } from '@/lib/community';

export function useCommunityRecords(memberId: string | undefined, token: string, viewerId: string) {
  return useInfiniteQuery({
    queryKey: ['community-records', viewerId, memberId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<MemberRecordsResponse>(`/members/${memberId}/records${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, token),
    getNextPageParam: page => page.ledger.nextCursor ?? undefined,
    enabled: Boolean(memberId),
    refetchInterval: 15000,
  });
}

export function CommunityRecordList({ records }: { records: CommunityRecord[] }) {
  if (!records.length) return <p className="ledger-empty">No community records yet. Every new member starts here.</p>;
  return (
    <ol className="ledger-records">
      {records.map(record => {
        const receipt = communityReceiptUrl(record);
        const status = record.status === 'finalized' ? 'Chain confirmed' : record.status === 'submitted' ? 'Submitted' : record.status === 'retry' ? 'Waiting to retry' : 'Pending on chain';
        return (
          <li className="ledger-record" key={record.id}>
            <div>
              <div className="ledger-record-heading"><strong>{communityRecordLabel(record)}</strong>
                <span className={`ledger-status ledger-status-${record.status}`}>{status}</span>
                {record.withdrawn && <span className="ledger-status ledger-status-withdrawn">Recognition withdrawn</span>}
              </div>
              <time dateTime={new Date(record.event.observedAt * 1000).toISOString()}>{new Date(record.event.observedAt * 1000).toLocaleString()}</time>
            </div>
            {receipt && <a href={receipt} target="_blank" rel="noopener noreferrer">View receipt <ExternalLink size={12} /></a>}
            <p>Platform-attested · Journey {record.event.journeyId.slice(0, 8)} · Event {record.event.sequence + 1}
              {record.event.kind === 'contribution' && <span className="ledger-value"> · {record.withdrawn ? 'Excluded from totals' : `+${record.points} points · +${record.reputation} reputation`}</span>}
            </p>
            {record.status === 'retry' && <p>Publication will retry automatically. This record is not yet chain confirmed.</p>}
            {record.withdrawn && <p>The original receipt remains public. A later correction excludes this journey’s recognition from current totals.</p>}
            {record.withdrawal && <CommunityCorrectionNotice correction={record.withdrawal} network={record.network} />}
            <details className="ledger-record-identifiers"><summary>Public identifiers</summary><p>Journey: <code>{record.event.journeyId}</code></p><p>Recorded actor: <code>{record.event.actorId === '0'.repeat(64) ? 'Automated relay' : record.event.actorId}</code></p><p>Recorded subject: <code>{record.event.subjectId}</code></p><p>Assignment: {record.event.assignment} · Rule version: 1</p></details>
          </li>
        );
      })}
    </ol>
  );
}

export function CommunityCorrectionNotice({ correction, network }: { correction: CommunityCorrection; network?: 'devnet' | 'localnet' }) {
  const finalized = correction.status === 'finalized';
  const receipt = network === 'devnet' && finalized && correction.recordAddress && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(correction.recordAddress)
    ? `https://explorer.solana.com/address/${correction.recordAddress}?cluster=devnet` : null;
  return <div className="ledger-pending">
    <strong>{finalized ? 'Recognition withdrawn' : 'Correction awaiting confirmation'}</strong>
    <p>{CORRECTION_REASONS[correction.reason]}. {finalized ? 'This journey’s contributions and banners are excluded from current totals; original history is retained.' : 'The original recognition remains until a withdrawal is confirmed.'} This version withdraws the whole journey’s recognition and cannot reinstate it.</p>
    {receipt && <a href={receipt} target="_blank" rel="noopener noreferrer">View correction receipt <ExternalLink size={12} /></a>}
  </div>;
}

export function MemberCommunityLedger({ query, compact = false }: { query: ReturnType<typeof useCommunityRecords>; compact?: boolean }) {
  const data = query.data?.pages[0];
  if (query.isError && !data) return <div className="profile-feedback" role="alert"><p>{errorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry community records</Button></div>;
  if (!data) return <output>Loading community records…</output>;
  const { ledger, legacy } = data;
  const pending = ledger.pending.contributions + ledger.pending.banners + ledger.pending.history;
  const records = [...new Map(query.data!.pages.flatMap(page => page.ledger.records).map(record => [record.id, record])).values()];
  return (
    <section className="community-ledger" aria-label="Verifiable community records">
      <div className="community-ledger-heading"><h4><ShieldCheck size={17} /> Community record</h4><span className="ledger-network">SOLANA {ledger.network.toUpperCase()}</span></div>
      <p className="ledger-description">Confirmed totals come from published platform attestations. They record participation and appreciation, not a guarantee of safety or character. Banners add no points.</p>
      {!compact && ledger.memberId && <details className="ledger-record-identifiers"><summary>Public community reference</summary><code>{ledger.memberId}</code></details>}
      {pending > 0 && <p className="ledger-pending">{pending} records awaiting confirmation · {ledger.pending.points} contribution points pending. These are separate from the confirmed totals.</p>}
      {!ledger.configured && ledger.memberId && <p className="ledger-pending">Publication is waiting for the community service to be ready. Saved records are not yet confirmed on chain.</p>}
      {ledger.withdrawn > 0 && <p className="ledger-description">{ledger.withdrawn} records belong to withdrawn recognition. Original history remains visible.</p>}
      {!compact && <>
        <CommunityRecordList records={records} />
        {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load more records'}</Button>}
        {query.isError && <p role="alert" className="inline-error">Records could not refresh. Previously loaded records are shown. <button onClick={() => void query.refetch()}>Retry</button></p>}
      </>}
      {(legacy.contributions > 0 || legacy.banners > 0) && <details className="ledger-legacy"><summary>Earlier application records</summary><p>{legacy.points} points · {legacy.contributions} credited journeys · {legacy.banners} banners. These predate the community ledger and are not included in its confirmed totals. Earlier V2 receipts, where available, remain in the signed-commitment view.</p></details>}
    </section>
  );
}

export function JourneyCommunityRecords({ tripId, token, viewerId }: { tripId: string; token: string; viewerId: string }) {
  const query = useInfiniteQuery({
    queryKey: ['journey-community', viewerId, tripId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<JourneyRecordsResponse>(`/trips/${tripId}/community${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`, token),
    getNextPageParam: page => page.community.nextCursor ?? undefined,
    refetchInterval: 10000,
  });
  const community = query.data?.pages[0].community;
  const records = [...new Map((query.data?.pages.flatMap(page => page.community.records) ?? []).map(record => [record.id, record])).values()];
  return (
    <article className="journey-community">
      <div className="community-ledger-heading"><h4><History size={18} /> Public guarding history</h4><span className="ledger-network">FREE PUBLICATION</span></div>
      {query.isError ? <div role="alert" className="profile-feedback"><p>{errorMessage(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Retry history</Button></div>
        : !community ? <output>Loading guarding history…</output>
        : !community.enabled ? <p className="ledger-description">This journey predates the community ledger. Its private history is not automatically published.</p>
        : <>
          <p className="ledger-description">Each accepted assignment and handoff has its own record. A relay request alone is not a completed handoff. Routes, messages and contact details are excluded.</p>
          {community.correction && <CommunityCorrectionNotice correction={community.correction} network={records[0]?.network} />}
          <CommunityRecordList records={records} />
          {query.hasNextPage && <Button variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? 'Loading…' : 'Load more records'}</Button>}
        </>}
    </article>
  );
}
