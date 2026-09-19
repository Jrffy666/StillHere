'use client';
import { useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { CommunityRecordList, CommunityCorrectionNotice } from '@/components/community-records';
import { api, errorMessage } from '@/lib/api';
import { CORRECTION_REASONS, type CommunityRecord, type CommunityCorrection } from '@/lib/community';
import { signJourneyTransaction } from '@/lib/wallet';

interface Journal { records: CommunityRecord[]; nextCursor: string | null; correction: CommunityCorrection | null }
interface Preparation { correction: CommunityCorrection; transaction: string; admin: string; expiresAt: number }

export function CommunityOperations({ secret }: { secret: string }) {
  const [reference, setReference] = useState('');
  const [loadedReference, setLoadedReference] = useState('');
  const [journal, setJournal] = useState<Journal | null>(null);
  const [targetSequence, setTargetSequence] = useState('0');
  const [reason, setReason] = useState('1');
  const [prepared, setPrepared] = useState<Preparation | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setMessage(''); setFailed(false);
    try { await work(); } catch (failure) { setFailed(true); setMessage(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  async function read(journeyId: string, cursor?: string) {
    const value = await api<Journal>(`/admin/community/journeys/${journeyId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, secret);
    setJournal(previous => cursor && previous ? { ...value, records: [...new Map([...previous.records, ...value.records].map(record => [record.id, record])).values()] } : value);
    setLoadedReference(journeyId);
  }
  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPrepared(null);
    void run(() => read(reference));
  }
  return (
    <section className="community-operations">
      <h2>Community ledger corrections</h2>
      <p>Inspect the public journey reference before making a correction. A confirmed withdrawal excludes all of that journey’s contributions and banners while preserving its original records. It cannot be undone in this version.</p>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="ledger-journey">Public journey reference</label>
        <Input id="ledger-journey" value={reference} onChange={event => { setReference(event.target.value.trim()); setPrepared(null); }} placeholder="64-character community reference" maxLength={64} pattern="[0-9a-f]{64}" required />
        <Button type="submit" disabled={busy || !/^[0-9a-f]{64}$/.test(reference)}>Inspect records</Button>
      </form>
      {journal && loadedReference === reference && <>
        {journal.correction && <CommunityCorrectionNotice correction={journal.correction} network={journal.records[0]?.network} />}
        <CommunityRecordList records={journal.records} />
        {journal.nextCursor && <Button variant="outline" disabled={busy} onClick={() => void run(() => read(loadedReference, journal.nextCursor!))}>Load more records</Button>}
        <div className="relay-actions">
          <Button variant="outline" disabled={busy} onClick={() => void run(() => read(loadedReference))}>Refresh status</Button>
          <Button variant="outline" disabled={busy} onClick={() => void run(async () => { await api('/admin/community/retry', secret, { journeyId: loadedReference }); await read(loadedReference); setMessage('Publication retry queued. Confirmation is checked separately.'); })}>Retry publication</Button>
        </div>
        {journal.correction?.status !== 'finalized' && <>
          <label className="field-label" htmlFor="correction-target">Original event sequence (starts at 0)</label>
          <Input id="correction-target" type="number" min="0" step="1" value={targetSequence} onChange={event => { setTargetSequence(event.target.value); setPrepared(null); }} />
          <label className="field-label" htmlFor="correction-reason">Correction reason</label>
          <NativeSelect id="correction-reason" value={reason} onChange={event => { setReason(event.target.value); setPrepared(null); }}>
            {Object.entries(CORRECTION_REASONS).map(([key, label]) => <NativeSelectOption key={key} value={key}>{label}</NativeSelectOption>)}
          </NativeSelect>
          <p className="small-note">Reports remain private. The chain stores this reason category and an authorized withdrawal. An operator credential alone cannot sign it.</p>
          <Button variant="outline" disabled={busy || !/^\d+$/.test(targetSequence)} onClick={() => void run(async () => {
            const value = await api<Preparation>('/admin/community/corrections/prepare', secret, { journeyId: loadedReference, targetSequence: Number(targetSequence), reason: Number(reason) });
            setPrepared(value); setConfirmation('');
          })}>Prepare withdrawal for review</Button>
          {prepared && <div className="ledger-pending">
            <p>Withdraw all recognition for <code>{loadedReference}</code>.</p>
            <p>Reason: {CORRECTION_REASONS[prepared.correction.reason]}. Requires the administrator wallet <code>{prepared.admin}</code>.</p>
            <label className="field-label" htmlFor="correction-confirmation">Type WITHDRAW RECOGNITION</label>
            <Input id="correction-confirmation" value={confirmation} onChange={event => setConfirmation(event.target.value)} />
            <Button variant="destructive" disabled={busy || confirmation !== 'WITHDRAW RECOGNITION'} onClick={() => void run(async () => {
              if (Date.now() >= prepared.expiresAt) throw new Error('This preparation expired. Prepare a fresh withdrawal before signing.');
              const transaction = await signJourneyTransaction(prepared.transaction, prepared.admin);
              await api('/admin/community/corrections/submit', secret, { journeyId: loadedReference, transaction });
              setPrepared(null); await read(loadedReference); setMessage('Signed withdrawal saved for publication. It takes effect after chain confirmation.');
            })}>Sign and submit withdrawal</Button>
          </div>}
        </>}
      </>}
      {message && <p role={failed ? 'alert' : 'status'} className={failed ? 'inline-error' : 'small-note'}>{message}</p>}
    </section>
  );
}
