'use client';
import { useId, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, errorMessage } from '@/lib/api';
import type { Session } from '@/lib/types';

export type AccessMode = 'register' | 'login' | 'upgrade';

export function AccountAccess({ mode, onModeChange, session, onSession }: {
  mode: AccessMode;
  onModeChange?: (mode: 'register' | 'login') => void;
  session?: Session | null;
  onSession: (session: Session) => void;
}) {
  const id = useId();
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const registering = mode !== 'login';

  async function submit() {
    if (busy) return;
    setError('');
    if (registering && password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const result = await api<Session>(registering ? '/auth/register' : '/auth/login', mode === 'upgrade' ? session?.token : undefined, {
        username: username.trim().toLowerCase(), password,
        ...(registering ? { name: mode === 'upgrade' ? session?.user.name : name.trim() } : {}),
      });
      setPassword('');
      setConfirmation('');
      onSession(result);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return <div className="account-access">
    {onModeChange && <div className="account-access-switch" aria-label="Account access">
      <Button type="button" variant={mode === 'register' ? 'secondary' : 'ghost'} aria-pressed={mode === 'register'} disabled={busy} onClick={() => { setError(''); setPassword(''); setConfirmation(''); onModeChange('register'); }}>Create account</Button>
      <Button type="button" variant={mode === 'login' ? 'secondary' : 'ghost'} aria-pressed={mode === 'login'} disabled={busy} onClick={() => { setError(''); setPassword(''); setConfirmation(''); onModeChange('login'); }}>Sign in</Button>
    </div>}
    {mode === 'upgrade' && <p className="field-hint">Add a login to this account. Your journeys, contributions and banners stay with you.</p>}
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy}>
      {mode === 'register' && <>
        <label className="field-label" htmlFor={`${id}-name`}>Display name</label>
        <Input id={`${id}-name`} name="name" autoComplete="nickname" placeholder="Your name in the community" value={name} maxLength={60} required disabled={busy} onChange={event => setName(event.target.value)} />
      </>}
      <label className="field-label" htmlFor={`${id}-username`}>Username</label>
      <Input id={`${id}-username`} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="e.g. night_owl" value={username} minLength={3} maxLength={32} pattern="[A-Za-z0-9_]{3,32}" title="Use 3–32 letters, numbers or underscores." required disabled={busy} aria-describedby={registering ? `${id}-username-hint` : undefined} onChange={event => setUsername(event.target.value)} />
      {registering && <p id={`${id}-username-hint`} className="field-hint">3–32 letters, numbers or underscores. Use this to sign in again.</p>}
      <label className="field-label" htmlFor={`${id}-password`}>Password</label>
      <Input id={`${id}-password`} name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} minLength={registering ? 12 : 1} maxLength={128} required disabled={busy} aria-describedby={registering ? `${id}-password-hint` : undefined} onChange={event => setPassword(event.target.value)} />
      {registering && <>
        <p id={`${id}-password-hint`} className="field-hint">At least 12 characters. Save it in your password manager.</p>
        <label className="field-label" htmlFor={`${id}-confirmation`}>Confirm password</label>
        <Input id={`${id}-confirmation`} name="password-confirmation" type="password" autoComplete="new-password" value={confirmation} minLength={12} maxLength={128} required disabled={busy} onChange={event => setConfirmation(event.target.value)} />
      </>}
      {error && <p role="alert" className="inline-error">{error}</p>}
      <Button type="submit" className="primary-action" disabled={busy}>{busy ? 'Please wait…' : mode === 'upgrade' ? 'Save my account' : registering ? 'Create account' : 'Sign in'}<ArrowRight size={16} /></Button>
    </form>
    <p className="simple-note">{registering ? 'No email or wallet required. Email password reset is not available in this demo.' : 'Your saved journeys and contributions will appear after you sign in.'}</p>
  </div>;
}
