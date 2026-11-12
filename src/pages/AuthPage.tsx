import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { Me } from '../../shared/types';
import { ApiError, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { LogoMark } from '../components/Logo';
import { Spinner } from '../components/ui';

/** Only follow "next" links that stay inside the app. */
const safeNext = (raw: string | null) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

type LoginReply = { user?: Me; twoFactor?: { ticket: string } };

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { user, setUser, config, toast } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set once the password has been accepted for an account with two-step login.
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const signup = mode === 'signup';

  if (user && !busy) return <Navigate to={next} replace />;

  function enter(me: Me) {
    setUser(me);
    if (signup) toast(`Welcome to OTS, ${me.displayName}!`);
    navigate(next, { replace: true });
  }

  async function send(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await post<LoginReply>(path, body);
      if (res.user) return enter(res.user);
      if (res.twoFactor) setTicket(res.twoFactor.ticket);
      setBusy(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (signup && !ageConfirmed) return setError(`You need to be ${config.minAccountAge} or older to use OTS.`);
    void send(signup ? '/auth/register' : '/auth/login', signup ? { email, password, displayName, ageConfirmed } : { email, password });
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ user: Me }>('/auth/login/verify', { ticket, code });
      enter(res.user);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      setCode('');
      // Out of time or out of tries: back to the password.
      if (err instanceof ApiError && err.code === 'challenge_expired') setTicket(null);
    }
  }

  const other = `${signup ? '/login' : '/signup'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;
  const mark = (
    <span className="logo-tile">
      <LogoMark size={34} />
    </span>
  );

  if (ticket) {
    return (
      <div className="page page--narrow">
        <div className="authcard">
          {mark}
          <h1>One more step</h1>
          <p className="muted">{useRecovery ? 'Enter one of the recovery codes you saved when you turned on two-step login.' : 'Enter the 6-digit code from your authenticator app.'}</p>
          <form className="stack" onSubmit={submitCode}>
            <label className="field">
              <span>{useRecovery ? 'Recovery code' : 'Code'}</span>
              <input
                className="input input--code"
                value={code}
                onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase().slice(0, 9) : e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode={useRecovery ? 'text' : 'numeric'}
                autoComplete="one-time-code"
                placeholder={useRecovery ? 'ABCD-2345' : '000000'}
                autoFocus
              />
            </label>
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn--primary btn--block btn--lg" disabled={busy || code.length < 6}>
              {busy && <Spinner />} Log in
            </button>
          </form>
          <p className="authcard__switch">
            <button
              className="link"
              onClick={() => {
                setUseRecovery(!useRecovery);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Use my authenticator app' : "I can't use my app — use a recovery code"}
            </button>
          </p>
          <p className="authcard__switch">
            <button
              className="link"
              onClick={() => {
                setTicket(null);
                setCode('');
                setError(null);
              }}
            >
              Back
            </button>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="page page--narrow">
      <div className="authcard">
        {mark}
        <h1>{signup ? 'Join OTS' : 'Welcome back'}</h1>
        <p className="muted">{signup ? 'Find something to do tonight — or fill your own party.' : next !== '/' ? 'Log in to carry on where you left off.' : 'Log in to join activities and host your own.'}</p>

        <form className="stack" onSubmit={submit}>
          {signup && (
            <label className="field">
              <span>What should people call you?</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="nickname" maxLength={40} required minLength={2} placeholder="First name or nickname" />
            </label>
          )}
          <label className="field">
            <span>E-mail</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required placeholder="you@example.com" />
          </label>
          <label className="field">
            <span>
              Password {signup && <small>at least 8 characters</small>}
            </span>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} required minLength={signup ? 8 : 1} />
          </label>
          {signup && (
            <label className="checkrow">
              <input type="checkbox" checked={ageConfirmed} onChange={(e) => setAgeConfirmed(e.target.checked)} />
              <span>I'm {config.minAccountAge} or older.</span>
            </label>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary btn--block btn--lg" disabled={busy}>
            {busy && <Spinner />} {signup ? 'Create my account' : 'Log in'}
          </button>
        </form>

        <p className="authcard__switch">
          {signup ? 'Already have an account?' : 'New here?'} <Link to={other}>{signup ? 'Log in' : 'Create an account'}</Link>
        </p>

        {config.demoMode && !signup && (
          <div className="demologin">
            <p>
              <strong>Just looking?</strong> Use the demo account — it's already ID-verified.
            </p>
            <button className="btn btn--ghost btn--block" onClick={() => send('/auth/login', { email: 'demo@ots.app', password: 'demo1234' })} disabled={busy}>
              Log in as Demo
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
