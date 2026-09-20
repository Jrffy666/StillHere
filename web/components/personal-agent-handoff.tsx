'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Download, HeartHandshake } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { api, errorMessage, timeLabel } from '@/lib/api';
import { personalAgentPresence } from '@/lib/personal-agent';
import type { Trip } from '@/lib/types';

const noticeVersion = 'personal-agent-v1';
const watchCommand = 'npm run agent -- watch --connection "$env:USERPROFILE\\Downloads\\stillhere-agent-connection.json" --allow-processing --max-minutes 20 --max-turns 12';

export function PersonalAgentHandoff({ trip, token, viewerId, busy, now }: {
  trip: Trip; token: string; viewerId: string; busy: boolean; now: number;
}) {
  const cache = useQueryClient();
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [feedback, setFeedback] = useState('');
  const [agentName, setAgentName] = useState('Personal agent'), [minutes, setMinutes] = useState(20), [consent, setConsent] = useState(false);
  const value = trip.personalAgent, presence = personalAgentPresence(value, now);
  const rider = trip.rider.id === viewerId, guardian = trip.guardian?.id === viewerId;
  const closed = trip.status === 'arrived' || trip.status === 'cancelled';
  if (trip.demo || (!value && (closed || !guardian || trip.status !== 'active'))) return null;
  const canRequest = guardian && !closed && trip.status === 'active' && (!value || presence.ended);
  const disabled = busy || saving;
  async function manage(action: 'request' | 'approve' | 'connect' | 'revoke') {
    if (disabled) return;
    setSaving(true); setError(''); setFeedback('');
    try {
      const body = action === 'request' ? { action, agentName: agentName.trim(), minutes, consent, noticeVersion }
        : action === 'approve' ? { action, delegationId: value!.id, consent, noticeVersion }
        : { action, delegationId: value!.id };
      const response = await api<{ trip: Trip; connection?: unknown }>(`/trips/${trip.id}/delegation`, token, body);
      await cache.cancelQueries({ queryKey: ['trip', viewerId, trip.id] });
      cache.setQueryData(['trip', viewerId, trip.id], { trip: response.trip });
      void cache.invalidateQueries({ queryKey: ['trips'] });
      if (action === 'connect' && response.connection) {
        const blob = new Blob([JSON.stringify(response.connection, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'stillhere-agent-connection.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setFeedback('Connection downloaded. Keep it private: it authorizes this agent for this journey until expiry.');
      } else setFeedback(action === 'request' ? 'Your rider can now review this handoff.' : action === 'approve' ? 'Permission granted. The guardian can now connect their agent.' : 'Agent permission withdrawn. Human controls remain available.');
      setConsent(false);
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setSaving(false); }
  }
  const processingNotice = <p className="simple-note">Recent messages from you and the current consenting companion, saved rider concerns and limited journey status can be processed by this guardian’s personal agent and its model provider. Exact coordinates and account/contact fields are excluded, but personal details typed in chat may remain. Withdrawal stops future access; it cannot recall data already shared.</p>;
  return <section className={`personal-agent-handoff ${presence.active ? 'personal-agent-present' : ''}`} aria-label="Personal agent handoff">
    <div className="personal-agent-heading"><Bot size={18} aria-hidden="true" /><div><strong>{presence.label}</strong>{value && <p>{value.agentName} · brought by {value.ownerName}</p>}</div></div>
    {value && <>
      {value.status === 'requested' && <p className="simple-note">A proposed handoff for this journey only. Your human guardian has not been replaced by an agent.</p>}
      {value.status === 'connecting' && <p className="simple-note">The runtime has connected. Agent coverage starts after its first accepted response.</p>}
      {presence.active && <p className="simple-note">Automated companionship until {timeLabel(value.expiresAt)}. The human guardian can return at any time.</p>}
      {(value.status === 'active' || value.status === 'connecting' || presence.ended) && <p className="simple-note">Last processed update: {value.lastProcessedAt ? timeLabel(value.lastProcessedAt) : 'None yet'}. {presence.ended || value.status === 'active' && !presence.active ? 'A personal agent is not currently providing coverage. Use the human relay or help controls when needed.' : 'Connectivity alone does not prove a response.'}</p>}
      {rider && value.status === 'requested' && !closed && <div className="personal-agent-form">
        {processingNotice}
        <label htmlFor={`rider-agent-consent-${trip.id}`} className="personal-agent-consent"><Checkbox id={`rider-agent-consent-${trip.id}`} checked={consent} onCheckedChange={setConsent} disabled={disabled} /><span>I allow this named agent to assist on this journey and process the context described above.</span></label>
        <Button disabled={disabled || !consent} onClick={() => void manage('approve')}>Allow this agent</Button>
      </div>}
      {guardian && !closed && ['approved', 'connecting', 'active'].includes(value.status) && <details className="personal-agent-setup" open={value.status === 'approved'}>
        <summary>Connect my agent</summary>
        <p className="simple-note">Download the private connection file and run the command in your local StillHere project. Before a runtime connects, downloading again invalidates the previous file. To switch a connected runtime, withdraw permission and request a new handoff.</p>
        {value.status === 'approved' && <Button variant="outline" disabled={disabled} onClick={() => void manage('connect')}><Download size={14} />{value.connectionIssued ? 'Replace connection file' : 'Download connection file'}</Button>}
        <pre className="codex-code">{watchCommand}</pre>
        <p className="simple-note">Use the actual filename if your browser renamed it. Keep the computer awake and this terminal running. The runner uses your Codex login and allowance; it stops at its time or turn limit. Delete the connection file when finished. MCP setup is in the project’s personal-agent client guide.</p>
      </details>}
      {!closed && !presence.ended && (rider || guardian) && <Button variant="ghost" disabled={disabled} onClick={() => void manage('revoke')}>{value.status === 'requested' && rider ? 'Decline handoff' : 'Withdraw agent permission'}</Button>}
      {value.receipts.length > 0 && <details className="personal-agent-history"><summary>Agent service · {value.receipts.length} recent execution records</summary><p className="simple-note">Server-recorded automated actions. These do not add human check-ins or contribution points. Runtime and model claims are not independently verified.</p>{value.receipts.slice(-5).reverse().map(receipt => <article key={receipt.id}><time>{timeLabel(receipt.at)}</time><p>{receipt.summary}</p><ul>{receipt.actions.map((action, index) => <li key={`${receipt.id}:${index}`}>{action.detail}</li>)}</ul></article>)}</details>}
    </>}
    {canRequest && <details className="personal-agent-setup"><summary><HeartHandshake size={15} aria-hidden="true" /> Let my agent help while I rest</summary>
      <div className="personal-agent-form">
        <label htmlFor={`agent-name-${trip.id}`}>Agent name</label><Input id={`agent-name-${trip.id}`} value={agentName} onChange={event => setAgentName(event.target.value)} maxLength={40} disabled={disabled} />
        <label htmlFor={`agent-minutes-${trip.id}`}>Permission duration</label><select id={`agent-minutes-${trip.id}`} value={minutes} onChange={event => setMinutes(Number(event.target.value))} disabled={disabled}>{[5, 10, 20, 30, 60, 120].map(value => <option key={value} value={value}>{value} minutes</option>)}</select>
        {processingNotice}
        <label htmlFor={`guardian-agent-consent-${trip.id}`} className="personal-agent-consent"><Checkbox id={`guardian-agent-consent-${trip.id}`} checked={consent} onCheckedChange={setConsent} disabled={disabled} /><span>I authorize my own agent and permit processing of my eligible messages. My rider must agree separately.</span></label>
        <Button disabled={disabled || !consent || !agentName.trim() || trip.assistance?.automatedCheckIns === false} onClick={() => void manage('request')}>Ask rider to allow handoff</Button>
        {trip.assistance?.automatedCheckIns === false && <p className="simple-note">Your rider has disabled automated assistance.</p>}
      </div>
    </details>}
    {Boolean(trip.personalAgentHistory?.length) && <details className="personal-agent-history"><summary>Earlier agent handoffs</summary>{trip.personalAgentHistory!.slice().reverse().map(previous => <article key={previous.id}><strong>{previous.agentName} · {previous.ownerName}</strong><p className="simple-note">{personalAgentPresence(previous, now).label} · {timeLabel(previous.endedAt ?? previous.expiresAt)} · {previous.receipts.length} retained execution records</p>{previous.receipts.slice(-2).map(receipt => <p key={receipt.id} className="simple-note">{timeLabel(receipt.at)} · {receipt.summary}</p>)}</article>)}</details>}
    {error && <p role="alert" className="inline-error">{error}</p>}{feedback && <output className="simple-note">{feedback}</output>}
  </section>;
}
