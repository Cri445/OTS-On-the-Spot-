import { useEffect, useState } from 'react';
import { Copy, Download, KeyRound } from 'lucide-react';
import QRCode from 'qrcode';
import type { Me } from '../../shared/types';
import { errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { prettyCode } from '../lib/format';
import { Modal, Spinner } from './ui';

/** Turn two-step login on: scan the QR with an authenticator app, confirm with a code, keep the recovery codes. */
export function TwoFactorSetup({ onClose }: { onClose: () => void }) {
  const { setUser, toast } = useApp();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    post<{ secret: string; uri: string }>('/me/2fa/setup')
      .then(async (s) => {
        const qr = await QRCode.toDataURL(s.uri, { margin: 1, width: 220, color: { dark: '#12131a', light: '#ffffff' } });
        if (live) setSetup({ secret: s.secret, qr });
      })
      .catch((err) => live && setError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ recoveryCodes: string[]; user: Me }>('/me/2fa/enable', { code });
      setUser(res.user);
      setRecovery(res.recoveryCodes);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (recovery) {
    const text = recovery.map(prettyCode).join('\n');
    const save = () => {
      const url = URL.createObjectURL(new Blob([`OTS recovery codes\nEach code works once.\n\n${text}\n`], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'ots-recovery-codes.txt';
      link.click();
      URL.revokeObjectURL(url);
    };
    return (
      <Modal title="Save your recovery codes" onClose={onClose}>
        <p className="lede">Two-step login is on. If you ever lose your phone, one of these codes gets you in instead. Each works once, and they're only shown now.</p>
        <ul className="recovery">
          {recovery.map((c) => (
            <li key={c}>{prettyCode(c)}</li>
          ))}
        </ul>
        <div className="row">
          <button
            className="btn btn--ghost"
            onClick={async () => {
              await navigator.clipboard.writeText(text).catch(() => {});
              toast('Recovery codes copied.');
            }}
          >
            <Copy size={16} aria-hidden /> Copy
          </button>
          <button className="btn btn--ghost" onClick={save}>
            <Download size={16} aria-hidden /> Download
          </button>
        </div>
        <button className="btn btn--primary btn--block" onClick={onClose}>
          I've saved them
        </button>
      </Modal>
    );
  }

  return (
    <Modal title="Turn on two-step login" onClose={onClose}>
      {!setup && !error && (
        <div className="verify-state">
          <Spinner />
        </div>
      )}
      {setup && (
        <form className="stack" onSubmit={confirm}>
          <p className="lede">Scan this with an authenticator app — Google Authenticator, Microsoft Authenticator, 1Password, Authy and the like.</p>
          <img className="qr" src={setup.qr} alt="QR code to scan with your authenticator app" width={220} height={220} />
          <p className="fineprint">
            Can't scan? Enter this key in the app by hand: <code className="secret">{setup.secret.match(/.{1,4}/g)!.join(' ')}</code>
          </p>
          <label className="field">
            <span>The 6-digit code the app shows</span>
            <input className="input input--code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="000000" autoFocus />
          </label>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn--primary btn--block" disabled={busy || code.length !== 6}>
            {busy && <Spinner />} Turn on
          </button>
        </form>
      )}
      {!setup && error && (
        <>
          <p className="form-error" role="alert">
            {error}
          </p>
          <button className="btn btn--ghost btn--block" onClick={onClose}>
            Close
          </button>
        </>
      )}
    </Modal>
  );
}

/** Turn two-step login off again. The password is asked for, so a borrowed phone can't do it. */
export function TwoFactorDisable({ onClose }: { onClose: () => void }) {
  const { setUser, toast } = useApp();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ user: Me }>('/me/2fa/disable', { password });
      setUser(res.user);
      toast('Two-step login is off.', 'info');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Turn off two-step login?" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="lede">Your account will be protected by your password alone. Enter it to confirm.</p>
        <label className="field">
          <span>Password</span>
          <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn--dangerfill btn--block" disabled={busy || !password}>
          {busy ? <Spinner /> : <KeyRound size={16} aria-hidden />} Turn off
        </button>
      </form>
    </Modal>
  );
}
