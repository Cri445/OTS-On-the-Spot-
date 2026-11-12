import { useState } from 'react';
import { BadgeCheck, LogOut, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { Me } from '../../shared/types';
import { api, errorMessage } from '../api';
import { useApp } from '../app-context';
import { VerifyIdModal } from '../components/VerifyIdModal';
import { Avatar, Spinner } from '../components/ui';

export function Profile() {
  const { user, setUser, logout, toast } = useApp();
  const navigate = useNavigate();
  const me = user!;
  const [displayName, setDisplayName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const dirty = displayName.trim() !== me.displayName || bio.trim() !== me.bio;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api<{ user: Me }>('/me', { method: 'PATCH', body: { displayName, bio } });
      setUser(res.user);
      toast('Profile saved.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function signOut() {
    try {
      await logout();
      navigate('/');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  }

  return (
    <div className="page page--narrow">
      <div className="profilehead">
        <Avatar name={me.displayName} color={me.avatarColor} size={72} />
        <div>
          <h1 className="pagetitle">{me.displayName}</h1>
          <p className="muted">{me.email}</p>
        </div>
      </div>

      <section className={`card idcard ${me.verified ? 'is-verified' : ''}`}>
        {me.verified ? (
          <>
            <BadgeCheck size={36} aria-hidden />
            <div>
              <h2>ID verified</h2>
              <p className="muted">
                You can join ID-only activities. Their hosts see your legal name, <strong>{me.legalName}</strong>, on the door list — nobody else does.
              </p>
            </div>
          </>
        ) : (
          <>
            <ShieldCheck size={36} aria-hidden />
            <div>
              <h2>Verify your ID</h2>
              <p className="muted">Some hosts only let in guests who've scanned their ID, so they know who's coming. It takes a minute and you only do it once.</p>
              <button className="btn btn--primary" onClick={() => setVerifying(true)}>
                Verify my ID
              </button>
            </div>
          </>
        )}
      </section>

      <form className="card stack" onSubmit={save}>
        <h2>About you</h2>
        <label className="field">
          <span>Name shown to others</span>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} minLength={2} required />
        </label>
        <label className="field">
          <span>
            Bio <small>optional</small>
          </span>
          <textarea className="input" rows={3} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={280} placeholder="A line about you" />
        </label>
        <button className="btn btn--primary" disabled={!dirty || saving}>
          {saving && <Spinner />} Save
        </button>
      </form>

      <button className="btn btn--ghost btn--block" onClick={signOut}>
        <LogOut size={18} aria-hidden /> Log out
      </button>

      {verifying && <VerifyIdModal onClose={() => setVerifying(false)} />}
    </div>
  );
}
