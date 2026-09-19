'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import { CommunityOperations } from '@/components/community-operations';

interface Report {
  id: string;
  reporterId: string;
  subjectId: string;
  tripId: string;
  category: string;
  createdAt: number;
  status: string;
}
interface Audit {
  id: string;
  at: number;
  action: string;
  target: string;
  reason: string | null;
}
export default function Operations() {
  const [secret, setSecret] = useState(''),
    [reports, setReports] = useState<Report[]>([]),
    [audit, setAudit] = useState<Audit[]>([]),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [target, setTarget] = useState(''),
    [reason, setReason] = useState('safety');
  async function refresh(before?: Report) {
    const query = new URLSearchParams({
      status: 'open',
      limit: '50',
      ...(before
        ? { before: String(before.createdAt), beforeId: before.id }
        : {}),
    });
    const [a, b] = await Promise.all([
      api<{ reports: Report[] }>(`/admin/reports?${query}`, secret),
      api<{ audit: Audit[] }>('/admin/audit', secret),
    ]);
    setReports(a.reports);
    setAudit(b.audit);
    setConnected(true);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (e) {
      setMessage(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="operations-page">
      <Link href="/">← Back to Safety Guard</Link>
      <h1>Community operations</h1>
      <p>
        Review reports and restrict recruitment for accounts that misuse the
        service. Existing participants retain help and journey closure controls.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => refresh());
        }}
      >
        <label className="field-label" htmlFor="operator-secret">
          Operator credential
        </label>
        <Input
          id="operator-secret"
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setConnected(false);
            setReports([]);
            setAudit([]);
          }}
        />
        <p className="small-note">
          The credential stays in this page’s memory and is cleared when you
          leave or disconnect.
        </p>
        <Button disabled={busy || secret.length < 32}>Connect / refresh</Button>
        {connected && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setSecret('');
              setReports([]);
              setAudit([]);
              setConnected(false);
            }}
          >
            Disconnect
          </Button>
        )}
      </form>
      {message && (
        <p role="alert" className="inline-error">
          {message}
        </p>
      )}
      {connected && (
        <>
          <CommunityOperations secret={secret} />
          <section>
            <h2>Recent reports</h2>
            {reports.length ? (
              reports.map((item) => (
                <article className="human-relay-card" key={item.id}>
                  <strong>
                    {item.category} · {item.status}
                  </strong>
                  <p>
                    Reported account: <code>{item.subjectId}</code>
                    <br />
                    Journey: <code>{item.tripId}</code>
                    <br />
                    {new Date(item.createdAt).toLocaleString()}
                  </p>
                  {item.status === 'open' && (
                    <div className="relay-actions">
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `/admin/reports/${item.id}/resolve`,
                              secret,
                              { status: 'dismissed' },
                            );
                            await refresh();
                          })
                        }
                      >
                        Dismiss
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              `/admin/reports/${item.id}/resolve`,
                              secret,
                              { status: 'actioned' },
                            );
                            await refresh();
                          })
                        }
                      >
                        Mark reviewed & actioned
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => setTarget(item.subjectId)}
                      >
                        Review account restriction
                      </Button>
                    </div>
                  )}
                </article>
              ))
            ) : (
              <p>No open reports on this page.</p>
            )}
            <div className="relay-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void run(() => refresh())}
              >
                Newest open reports
              </Button>
              {reports.length === 50 && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(() => refresh(reports[reports.length - 1]))
                  }
                >
                  Older open reports
                </Button>
              )}
            </div>
          </section>
          <section>
            <h2>Account restriction</h2>
            <label className="field-label" htmlFor="restriction-account">
              Account ID
            </label>
            <Input
              id="restriction-account"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <label className="field-label" htmlFor="restriction-reason">
              Reason
            </label>
            <select
              id="restriction-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            >
              {[
                'safety',
                'abuse',
                'fraud',
                'spam',
                'appeal',
                'administrative',
              ].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
            <div className="relay-actions">
              <Button
                variant="destructive"
                disabled={busy || !target}
                onClick={() =>
                  void run(async () => {
                    await api(`/admin/users/${target}/suspension`, secret, {
                      suspended: true,
                      reason,
                    });
                    await refresh();
                    setMessage('Recruitment and reward access suspended.');
                  })
                }
              >
                Suspend recruitment
              </Button>
              <Button
                variant="outline"
                disabled={busy || !target}
                onClick={() =>
                  void run(async () => {
                    await api(`/admin/users/${target}/suspension`, secret, {
                      suspended: false,
                      reason,
                    });
                    await refresh();
                    setMessage('Account restriction lifted.');
                  })
                }
              >
                Lift restriction
              </Button>
            </div>
          </section>
          <section>
            <h2>Recent audit events</h2>
            <div className="operations-table">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((item) => (
                    <tr key={item.id}>
                      <td>{new Date(item.at).toLocaleString()}</td>
                      <td>{item.action}</td>
                      <td>
                        <code>{item.target}</code>
                      </td>
                      <td>{item.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
