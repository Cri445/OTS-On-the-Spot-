import { useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import type { Me } from '../../shared/types';
import { errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { Spinner } from '../components/ui';

/** Only follow "next" links that stay inside the app. */
const safeNext = (raw: string | null) => (raw && raw.startsWith('/') && !raw.startsWith('//') ? raw : '/');

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const { user, setUser, config, toast } = useApp();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [adult, setAdult] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signup = mode === 'signup';

  if (user && !busy) return <Navigate to={next} replace />;

  async function send(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ user: Me }>(path, body);
      setUser(res.user);
      if (signup) toast(`Welcome to OTS, ${res.user.displayName}!`);
      navigate(next, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (signup && !adult) return setError("OTS is for adults. Confirm you're 18 or older.");
    void send(signup ? '/auth/register' : '/auth/login', signup ? { email, password, displayName, adult } : { email, password });
  }

  const other = `${signup ? '/login' : '/signup'}${next !== '/' ? `?next=${encodeURIComponent(next)}` : ''}`;

  return (
    <div className="page page--narrow">
      <div className="authcard">
        <div className="logo-mark logo-mark--lg" aria-hidden />
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
              <input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />
              <span>I'm 18 or older.</span>
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
