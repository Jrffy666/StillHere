'use client';
import { useState, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { api, errorMessage } from '@/lib/api';
import { walletIdentity, type IdentityIntent } from '@/lib/wallet';
import type { Session, User } from '@/lib/types';

function download(name: string, content: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function AccountPanel({
  open,
  onOpenChange,
  session,
  user,
  onSession,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  session: Session | null;
  user?: User;
  onSession: (session: Session | null) => void;
  returnFocus?: RefObject<HTMLElement | null>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [accountId, setAccountId] = useState(''),
    [code, setCode] = useState(''),
    [issuedCode, setIssuedCode] = useState(''),
    [confirmation, setConfirmation] = useState('');
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function identity(intent: IdentityIntent) {
    const result = await walletIdentity(intent, session?.token, {
      ...(intent === 'recover' ? { accountId } : {}),
      ...(code ? { recoveryCode: code } : {}),
    });
    setIssuedCode(result.recoveryCode || '');
    setCode('');
    onSession({ token: result.token, user: result.user });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          onOpenChange(value);
          if (!value) {
            setIssuedCode('');
            setCode('');
            setConfirmation('');
          }
        }
      }}
    >
      <DialogContent className="account-dialog" finalFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>Your account & privacy</DialogTitle>
          <DialogDescription>
            Keep your identity across browsers, manage access, and control your
            private journey data.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="inline-error">
            {error}
          </p>
        )}
        {issuedCode && (
          <div className="recovery-card" aria-live="polite">
            <strong>Save your new recovery code now</strong>
            <p>
              This code is shown once. Store it somewhere private with your
              account ID. A new code invalidates the previous code.
            </p>
            <code>{issuedCode}</code>
            <Button
              variant="outline"
              onClick={() =>
                download(
                  'safety-guard-recovery.txt',
                  `Account ID: ${user?.id || accountId}\nRecovery code: ${issuedCode}\nKeep private. This can recover account access.\n`,
                  'text/plain',
                )
              }
            >
              Download recovery code
            </Button>
          </div>
        )}
        {session && user ? (
          <>
            <div className="account-facts">
              <strong>{user.name}</strong>
              <span>
                Account ID: <code>{user.id}</code>
              </span>
              <span>
                Wallet: <code>{user.wallet || 'Not linked'}</code>
              </span>
              <span>
                {user.recoveryConfigured
                  ? 'Recovery code configured'
                  : 'No recovery code configured'}
              </span>
            </div>
            <p className="small-note">
              Signing an account message does not transfer funds. Journey
              transactions use Devnet SOL. Your wallet address is public; your
              name and route stay off chain.
            </p>
            <div className="relay-actions">
              {!user.wallet && (
                <Button
                  disabled={busy}
                  onClick={() => void run(() => identity('bind'))}
                >
                  Link wallet
                </Button>
              )}
              <Button
                variant="outline"
                disabled={busy || !user.wallet}
                onClick={() => void run(() => identity('recovery-code'))}
              >
                Replace recovery code
              </Button>
              <Button
                variant="outline"
                disabled={busy || !user.wallet}
                onClick={() => void run(() => identity('revoke-sessions'))}
              >
                Revoke other sessions
              </Button>
            </div>
            {user.wallet && (
              <details>
                <summary>Replace your account wallet</summary>
                <p>
                  Enter your recovery code, then select the new wallet in your
                  wallet extension. Existing chain journeys still require their
                  original wallet.
                </p>
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label="Recovery code for wallet change"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <Button
                  disabled={busy || !code.trim()}
                  onClick={() => void run(() => identity('rotate'))}
                >
                  Sign with new wallet
                </Button>
              </details>
            )}
            <div className="relay-actions">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const data = await api('/account/export', session.token);
                    download(
                      'safety-guard-data.json',
                      JSON.stringify(data, null, 2),
                    );
                  })
                }
              >
                Export my data
              </Button>
            </div>
            <details>
              <summary>Delete my account</summary>
              <p>
                Private journeys you created will be erased, and your messages
                and profile will be removed from other journeys. Public
                blockchain receipts and minimal anti-replay records remain. This
                also ends your account access.
              </p>
              <label className="field-label" htmlFor="delete-confirmation">
                Type DELETE MY ACCOUNT
              </label>
              <Input
                id="delete-confirmation"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
              <Button
                variant="destructive"
                disabled={busy || confirmation !== 'DELETE MY ACCOUNT'}
                onClick={() =>
                  void run(async () => {
                    await api('/account/delete', session.token, {
                      confirmation,
                    });
                    onSession(null);
                    onOpenChange(false);
                  })
                }
              >
                Delete account and private data
              </Button>
            </details>
          </>
        ) : (
          <>
            <p className="field-hint">
              New here? Start with your name in My journeys, then link your
              wallet from your account.
            </p>
            <Button
              disabled={busy}
              onClick={() => void run(() => identity('login'))}
            >
              Sign in with linked wallet
            </Button>
            <details>
              <summary>Recover with a recovery code</summary>
              <p>
                Use your account ID and recovery code, and select a new wallet
                to secure the recovered account.
              </p>
              <Input
                aria-label="Account ID"
                placeholder="Account ID"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              />
              <Input
                type="password"
                autoComplete="off"
                aria-label="Recovery code"
                placeholder="Recovery code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button
                disabled={busy || !accountId || !code}
                onClick={() => void run(() => identity('recover'))}
              >
                Recover and link new wallet
              </Button>
            </details>
          </>
        )}
        {busy && (
          <output>
            Complete the request in your wallet, then keep this page open.
          </output>
        )}
      </DialogContent>
    </Dialog>
  );
}
