import { useRef, useState } from 'react';
import { BadgeCheck, Camera, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import type { Me } from '../../shared/types';
import { api, errorMessage, upload } from '../api';
import { useApp } from '../app-context';
import { TwoFactorDisable, TwoFactorSetup } from '../components/TwoFactor';
import { VerifyIdModal } from '../components/VerifyIdModal';
import { Spinner, UserAvatar, cx } from '../components/ui';
import { shrinkImage } from '../lib/images';

export function Profile() {
  const { user, setUser, logout, toast } = useApp();
  const navigate = useNavigate();
  const me = user!;
  const [displayName, setDisplayName] = useState(me.displayName);
  const [bio, setBio] = useState(me.bio);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sheet, setSheet] = useState<'verify' | '2fa-on' | '2fa-off' | null>(null);
  const file = useRef<HTMLInputElement>(null);
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

  async function changePicture(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (!picked) return;
    setUploading(true);
    try {
      const small = await shrinkImage(picked, { maxSide: 512, square: true });
      const res = await upload<{ user: Me }>('/me/avatar', small);
      setUser(res.user);
      toast('Profile picture updated.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setUploading(false);
    }
  }

  async function removePicture() {
    try {
      const res = await api<{ user: Me }>('/me/avatar', { method: 'DELETE' });
      setUser(res.user);
    } catch (err) {
      toast(errorMessage(err), 'error');
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
        <button className="avatarbtn" onClick={() => file.current?.click()} disabled={uploading} aria-label="Change profile picture">
          <UserAvatar user={me} size={96} />
          <span className="avatarbtn__badge">{uploading ? <Spinner label="Uploading" /> : <Camera size={16} aria-hidden />}</span>
        </button>
        <input ref={file} type="file" accept="image/*" hidden onChange={changePicture} />
        <div>
          <h1 className="pagetitle">{me.displayName}</h1>
          <p className="muted">{me.email}</p>
          <div className="profilehead__links">
            <button className="link" onClick={() => file.current?.click()} disabled={uploading}>
              {me.avatarUrl ? 'Change picture' : 'Add a picture'}
            </button>
            {me.avatarUrl && (
              <button className="link" onClick={removePicture}>
                Remove
              </button>
            )}
            <Link className="link" to={`/u/${me.id}`}>
              View public profile
            </Link>
          </div>
        </div>
      </div>

      <section className={cx('card idcard', me.verified && 'is-verified')}>
        {me.verified ? (
          <>
            <BadgeCheck size={36} aria-hidden />
            <div>
              <h2>ID verified</h2>
              <p className="muted">
                You can join ID-only activities and ones with an age limit. Their hosts see your legal name, <strong>{me.legalName}</strong>, on the door list — nobody else does.
              </p>
            </div>
          </>
        ) : (
          <>
            <ShieldCheck size={36} aria-hidden />
            <div>
              <h2>Verify your ID</h2>
              <p className="muted">Some hosts only let in guests who've scanned their ID — to know who's coming, or to check an age limit. It takes a minute and you only do it once.</p>
              <button className="btn btn--primary" onClick={() => setSheet('verify')}>
                Verify my ID
              </button>
            </div>
          </>
        )}
      </section>

      <section className={cx('card idcard', me.twoFactorEnabled && 'is-verified')}>
        <KeyRound size={36} aria-hidden />
        <div>
          <h2>Two-step login {me.twoFactorEnabled && <span className="tag tag--secure">On</span>}</h2>
          {me.twoFactorEnabled ? (
            <>
              <p className="muted">When you log in we ask for a code from your authenticator app as well as your password.</p>
              <button className="btn btn--ghost" onClick={() => setSheet('2fa-off')}>
                Turn off
              </button>
            </>
          ) : (
            <>
              <p className="muted">Add a second step when you log in: a 6-digit code from an authenticator app on your phone. Someone who learns your password still can't get in.</p>
              <button className="btn btn--primary" onClick={() => setSheet('2fa-on')}>
                Turn on
              </button>
            </>
          )}
        </div>
      </section>

      <form className="card stack" onSubmit={save}>
        <h2>About you</h2>
        <label className="field">
          <span>Name shown to others</span>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} minLength={2} required />
        </label>
        <label className="field">
          <span>
            Bio <small>shown on your public profile</small>
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

      {sheet === 'verify' && <VerifyIdModal onClose={() => setSheet(null)} />}
      {sheet === '2fa-on' && <TwoFactorSetup onClose={() => setSheet(null)} />}
      {sheet === '2fa-off' && <TwoFactorDisable onClose={() => setSheet(null)} />}
    </div>
  );
}
