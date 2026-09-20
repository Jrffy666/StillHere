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
import { AccountAccess } from '@/components/account-access';
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
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [saved, setSaved] = useState('');
  async function run(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setSaved('');
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
            setCurrentPassword('');
            setNewPassword('');
            setPasswordConfirmation('');
            setSaved('');
            setError('');
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
        {saved && <output className="simple-notice">{saved}</output>}
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
              {user.username && <span>Username: <strong>@{user.username}</strong></span>}
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
            {!user.username && <AccountAccess mode="upgrade" session={session} onSession={value => {
              onSession(value);
              setSaved('Login saved. Sign in with your username and password to return to this account.');
            }} />}
            {user.username && <details>
              <summary>Change password</summary>
              <p>Changing your password signs out your other sessions. Your history stays with this account.</p>
              <form className="account-password-form" onSubmit={event => {
                event.preventDefault();
                void run(async () => {
                  if (newPassword !== passwordConfirmation) throw new Error('The new passwords do not match.');
                  const value = await api<Session>('/auth/password', session.token, { currentPassword, newPassword });
                  setCurrentPassword(''); setNewPassword(''); setPasswordConfirmation('');
                  onSession(value);
                  setSaved('Password changed. Your other sessions have been signed out.');
                });
              }}>
                <input type="hidden" name="username" autoComplete="username" value={user.username} />
                <label className="field-label" htmlFor="account-current-password">Current password</label>
                <Input id="account-current-password" name="current-password" type="password" autoComplete="current-password" value={currentPassword} maxLength={128} required disabled={busy} onChange={event => setCurrentPassword(event.target.value)} />
                <label className="field-label" htmlFor="account-new-password">New password</label>
                <Input id="account-new-password" name="new-password" type="password" autoComplete="new-password" value={newPassword} minLength={12} maxLength={128} required disabled={busy} onChange={event => setNewPassword(event.target.value)} />
                <p className="field-hint">At least 12 characters.</p>
                <label className="field-label" htmlFor="account-confirm-password">Confirm new password</label>
                <Input id="account-confirm-password" name="confirm-password" type="password" autoComplete="new-password" value={passwordConfirmation} minLength={12} maxLength={128} required disabled={busy} onChange={event => setPasswordConfirmation(event.target.value)} />
                <Button type="submit" disabled={busy}>Save new password</Button>
              </form>
            </details>}
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
                disabled={busy || (!user.wallet && !user.username)}
                onClick={() => void run(async () => {
                  if (user.wallet) await identity('revoke-sessions');
                  else onSession(await api<Session>('/auth/revoke-sessions', session.token, {}));
                  setSaved('Other sessions have been signed out.');
                })}
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
              Use the wallet already linked to your account. You can also close
              this panel and sign in with your username and password.
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
            Completing your request. If your wallet opens, review the message there.
          </output>
        )}
      </DialogContent>
    </Dialog>
  );
}
