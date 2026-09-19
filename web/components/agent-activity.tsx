'use client';

import { Bot, Check, Clock3, CircleAlert, ArrowRightLeft } from 'lucide-react';
import { timeLabel } from '@/lib/api';
import type { Trip } from '@/lib/types';

const triggers = {
  takeover: 'Human guardian unavailable',
  'rider-message': 'Rider message received',
  'follow-up': 'Scheduled follow-up',
  'stale-location': 'Location update overdue',
  'notification-failure': 'Contact alert unconfirmed',
};
const tools: Record<string, string> = {
  get_journey_context: 'Check journey context',
  send_check_in: 'Send a check-in',
  schedule_follow_up: 'Schedule a follow-up',
  request_human_relay: 'Request a human guardian',
  notify_trusted_contact: 'Queue a trusted-contact alert',
};

export function AgentActivity({ trip }: { trip: Trip }) {
  const agent = trip.agent;
  if (!agent) return null;
  const runs = [...agent.runs].reverse().slice(0, 5);
  const active = trip.status === 'active' && trip.guardMode === 'ai';
  return (
    <article className="agent-card">
      <div className="card-header">
        <h3><Bot size={17} /> Companion activity</h3>
        <span className="agent-provider">OFFLINE MOCK</span>
      </div>
      <p className="agent-intro">A simulated decision-maker uses real journey tools. No live AI model is connected.</p>
      <div className="agent-state-row">
        <span><span className={`agent-status-dot ${active ? 'active' : ''}`} />{active ? 'Automated monitoring' : trip.status === 'active' ? 'Human monitoring' : trip.status === 'open' ? 'Companion on standby' : 'Monitoring ended'}</span>
        {active && agent.followUpAt && <span><Clock3 size={13} /> Follow-up {timeLabel(agent.followUpAt)}</span>}
      </div>
      {agent.handoffSummary && (
        <div className="agent-handoff">
          <strong><ArrowRightLeft size={14} /> For the next guardian</strong>
          <p>{agent.handoffSummary}</p>
          <span>Summary of the recorded run. Check current messages and alert status before taking over.</span>
        </div>
      )}
      {!runs.length ? (
        <p className="agent-empty">When a guardian becomes unavailable, the companion records its checks and actions here.{trip.demo ? ' Try “Guardian offline” above to start.' : ''}</p>
      ) : (
        <div className="agent-runs">
          {runs.map((run, index) => (
            <details className="agent-run" key={run.id} open={index === 0}>
              <summary>
                <span><strong>{triggers[run.trigger.kind]}</strong><time>{timeLabel(run.createdAt)}</time></span>
                <span className={`agent-run-status ${run.status}`}>{run.status}</span>
              </summary>
              {run.error && <p className="agent-run-note">{run.error}</p>}
              {run.steps.length === 0 && <p className="agent-run-note">{run.status === 'cancelled' ? 'No tools were executed.' : 'Waiting for the next attempt.'}</p>}
              <ol className="agent-steps">
                {run.steps.map(step => (
                  <li key={step.id}>
                    <span className={`agent-step-icon ${step.status}`}>
                      {step.status === 'succeeded' ? <Check size={14} /> : step.status === 'rejected' ? <CircleAlert size={14} /> : <Clock3 size={14} />}
                    </span>
                    <div>
                      <strong>{tools[step.call.name] ?? 'Journey action'} <small>{step.status}</small></strong>
                      <p>{step.result?.detail ?? 'Waiting to execute.'}</p>
                      {step.result?.context && <span className="agent-context-note">{step.result.context.messages.length} recent messages · Location {step.result.context.location.stale ? 'out of date' : 'recent'} ({Math.floor(step.result.context.location.ageSeconds)}s old at this check)</span>}
                    </div>
                  </li>
                ))}
              </ol>
            </details>
          ))}
        </div>
      )}
      <p className="agent-footnote">Only the rider approves a guardian. Alerts have separate delivery statuses.</p>
    </article>
  );
}
