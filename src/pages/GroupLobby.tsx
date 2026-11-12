import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, CircleAlert, Copy, Crown, Hourglass, Share2, Ticket, UserMinus, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import type { GroupDTO, PayMode } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { whenLine } from '../components/ActivityCard';
import { PaymentSheet } from '../components/PaymentSheet';
import { VerifyIdModal } from '../components/VerifyIdModal';
import { CategoryIcon, Empty, LoadState, Spinner, UserAvatar, VerifiedBadge, cx } from '../components/ui';
import { plural } from '../lib/format';
import { useNow } from '../lib/use-load';
import { shareLink } from './ActivityPage';

const countdown = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The lobby where a group gathers before getting in together. Refreshes itself while people join and pay. */
export function GroupLobby() {
  const code = useParams().code!.toUpperCase();
  const { user, config, money, toast } = useApp();
  const navigate = useNavigate();
  const now = useNow(1000);
  const [group, setGroup] = useState<GroupDTO>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sheet, setSheet] = useState<'leader' | 'share' | 'verify' | null>(null);
  const lastStatus = useRef<string | undefined>(undefined);
  const settled = group?.status === 'confirmed' || group?.status === 'cancelled';

  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const res = await api<{ group: GroupDTO }>(`/groups/${code}`);
        if (!stop) {
          setGroup(res.group);
          setError(null);
        }
      } catch (err) {
        if (!stop) setError(errorMessage(err));
      }
    };
    void tick();
    // Once the group is confirmed or dissolved there is nothing left to watch.
    const id = settled ? undefined : setInterval(tick, 2500);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [code, settled, user?.verified]);

  // Tell people when the state changes under them.
  useEffect(() => {
    const previous = lastStatus.current;
    lastStatus.current = group?.status;
    if (!previous || !group || previous === group.status) return;
    if (previous === 'holding' && group.status === 'open') toast('The hold was released. Nobody has been charged.', 'info');
    if (group.status === 'confirmed') toast("You're all in! 🎉");
  }, [group, toast]);

  if (!group) {
    return (
      <div className="page">
        <LoadState loading={!error} error={error} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const { activity: a, members, viewer } = group;
  const free = a.priceCents === 0;
  const inviteUrl = `${window.location.origin}/g/${group.code}`;
  const leader = members.find((m) => m.isLeader)?.user;
  const me = members.find((m) => m.user.id === user?.id);
  const unpaid = members.filter((m) => !m.paid).length;
  const ready = group.blockers.length === 0;

  /** Run a group action and swap in the fresh state the server sends back. */
  async function act(name: string, path: string, body: unknown = {}): Promise<boolean> {
    setBusy(name);
    try {
      const res = await post<{ group?: GroupDTO }>(`/groups/${group!.code}/${path}`, body);
      if (res.group) setGroup(res.group);
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function lock(payMode?: PayMode) {
    await act('lock', 'lock', { payMode });
  }

  async function leave() {
    if (await act('leave', 'leave')) {
      toast(viewer.isLeader ? 'Group dissolved.' : 'You left the group.', 'info');
      navigate(`/a/${a.id}`);
    }
  }

  // These two reject on failure so the payment sheet can show why (e.g. a declined card).
  async function payForAll(paymentMethod: string) {
    const res = await post<{ group: GroupDTO }>(`/groups/${group!.code}/lock`, { payMode: 'leader', paymentMethod });
    setGroup(res.group);
    setSheet(null);
  }

  async function payShare(paymentMethod: string) {
    const res = await post<{ group: GroupDTO }>(`/groups/${group!.code}/pay`, { paymentMethod });
    setGroup(res.group);
    setSheet(null);
  }

  let action;
  if (group.status === 'cancelled') {
    action = (
      <Empty emoji="🫥" title="This group was dissolved">
        <p>You can still join on your own, or start a new group.</p>
        <Link to={`/a/${a.id}`} className="btn btn--primary">
          Back to the activity
        </Link>
      </Empty>
    );
  } else if (group.status === 'confirmed') {
    action = (
      <div className="lobby__done">
        <div className="lobby__confetti" aria-hidden>
          🎉
        </div>
        <h2>You're all in</h2>
        <p>{plural(members.length, 'ticket')} — one for each of you.</p>
        {viewer.isMember && (
          <Link to="/tickets" className="btn btn--primary btn--lg">
            <Ticket size={18} aria-hidden /> View my ticket
          </Link>
        )}
      </div>
    );
  } else if (!viewer.isMember) {
    action = (
      <div className="lobby__action">
        <h2>{leader?.displayName} invited you</h2>
        <p className="muted">Join the group and you all get in together — or nobody is charged.</p>
        <button className="btn btn--primary btn--block btn--lg" onClick={() => act('join', 'join')} disabled={busy !== null || group.status !== 'open'}>
          {busy === 'join' ? <Spinner /> : <Users size={18} aria-hidden />} Join the group
        </button>
        {group.status === 'holding' && <p className="fineprint">This group is locking in its spots right now, so it can't take new members.</p>}
      </div>
    );
  } else if (group.status === 'holding') {
    const left = Date.parse(group.holdExpiresAt ?? '') - now;
    action = (
      <div className="lobby__action">
        <div className="holdclock" role="timer" aria-live="off">
          <Hourglass size={20} aria-hidden />
          <div>
            <strong>{countdown(left)}</strong>
            <span>Your {members.length} spots are held</span>
          </div>
        </div>
        {viewer.paid ? (
          <p className="muted">
            <Check size={16} aria-hidden /> You've paid. Waiting for {plural(unpaid, 'more person', 'more people')} — nothing is charged until everyone has.
          </p>
        ) : (
          <button className="btn btn--primary btn--block btn--lg" onClick={() => setSheet('share')}>
            Pay my share · {money(group.shareCents)}
          </button>
        )}
        {viewer.isLeader && (
          <button className="btn btn--text" onClick={() => act('release', 'release')} disabled={busy !== null}>
            Release the hold
          </button>
        )}
        <p className="fineprint">If someone doesn't pay before the clock runs out, the spots are released and nobody is charged.</p>
      </div>
    );
  } else if (viewer.isLeader) {
    action = (
      <div className="lobby__action">
        <h2>{ready ? 'Ready when you are' : 'Almost there'}</h2>
        {group.blockers.length > 0 && (
          <ul className="blockers">
            {group.blockers.map((b) => (
              <li key={b}>
                <CircleAlert size={16} aria-hidden /> {b}
              </li>
            ))}
          </ul>
        )}
        {free ? (
          <button className="btn btn--primary btn--block btn--lg" onClick={() => lock()} disabled={!ready || busy !== null}>
            {busy === 'lock' && <Spinner />} Get all {members.length} of us in
          </button>
        ) : (
          <div className="payoptions">
            <button className="payoption" onClick={() => lock('split')} disabled={!ready || busy !== null}>
              <strong>Everyone pays their own</strong>
              <span>
                {money(group.shareCents)} each. Spots are held for {config.groupHoldMinutes} minutes while everyone pays.
              </span>
            </button>
            <button className="payoption" onClick={() => setSheet('leader')} disabled={!ready || busy !== null}>
              <strong>I'll pay for everyone</strong>
              <span>{money(group.totalCents)} on your card. Everyone's in straight away.</span>
            </button>
          </div>
        )}
        <p className="fineprint">{members.length === 2 ? 'Both of you get a spot, or neither does.' : `All ${members.length} of you get a spot, or none of you do.`} Nobody is left outside.</p>
      </div>
    );
  } else {
    action = (
      <div className="lobby__action">
        <h2>Waiting for {leader?.displayName}</h2>
        <p className="muted">
          {leader?.displayName} locks in the spots once everyone's here.{free ? '' : ` Your share will be ${money(group.shareCents)} unless they cover the group.`}
        </p>
        {me?.issues.includes('Needs to verify ID') && (
          <button className="btn btn--primary btn--block" onClick={() => setSheet('verify')}>
            Verify my ID
          </button>
        )}
      </div>
    );
  }

  const canInvite = group.status === 'open' && viewer.isMember;

  return (
    <div className="page">
      <div className="pagebar">
        <Link to={`/a/${a.id}`} className="backlink">
          <ArrowLeft size={18} aria-hidden /> Activity
        </Link>
      </div>

      <div className="lobby">
        <Link to={`/a/${a.id}`} className="lobby__activity">
          <CategoryIcon a={a} />
          <div>
            <span className="eyebrow">Partying up for</span>
            <h1>{a.title}</h1>
            <p className="muted">
              {whenLine(a, now).text} · {free ? 'Free' : `${money(a.priceCents)} each`} · {plural(a.spotsLeft, 'spot')} left
            </p>
          </div>
        </Link>

        {canInvite && (
          <section className="invite">
            <h2>Invite your friends</h2>
            <p className="muted">Send them this link. They join the group, then you all get in together.</p>
            <div className="invite__row">
              <input className="input" readOnly value={inviteUrl} aria-label="Invite link" onFocus={(e) => e.target.select()} />
              <button
                className="btn btn--ghost"
                onClick={async () => {
                  await navigator.clipboard.writeText(inviteUrl).catch(() => {});
                  toast('Invite link copied.');
                }}
              >
                <Copy size={16} aria-hidden /> Copy
              </button>
              {typeof navigator.share === 'function' && (
                <button className="btn btn--ghost" onClick={() => shareLink(inviteUrl, `Join my group for ${a.title}`, toast)}>
                  <Share2 size={16} aria-hidden /> Share
                </button>
              )}
            </div>
          </section>
        )}

        <section>
          <h2>
            {plural(members.length, 'person', 'people')} in the group <small>up to {config.maxGroupSize}</small>
          </h2>
          <ul className="members">
            {members.map((m) => (
              <li key={m.user.id} className={cx(m.issues.length > 0 && 'has-issue')}>
                <UserAvatar user={m.user} />
                <div className="members__who">
                  <strong>
                    {m.user.displayName}
                    {m.user.id === user?.id && <span className="muted"> (you)</span>}
                  </strong>
                  <div className="members__badges">
                    {m.isLeader && (
                      <span className="tag tag--featured">
                        <Crown size={12} aria-hidden /> Leader
                      </span>
                    )}
                    {m.user.verified && <VerifiedBadge />}
                    {m.issues.map((issue) => (
                      <span key={issue} className="tag tag--danger">
                        {issue}
                      </span>
                    ))}
                  </div>
                </div>
                {group.status === 'holding' && <span className={cx('paystate', m.paid && 'is-paid')}>{m.paid ? 'Paid' : 'Waiting…'}</span>}
                {group.status === 'open' && viewer.isLeader && !m.isLeader && (
                  <button className="iconbtn" onClick={() => act('remove', 'remove', { userId: m.user.id })} aria-label={`Remove ${m.user.displayName}`} title="Remove from group">
                    <UserMinus size={18} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {action}

        {viewer.isMember && group.status === 'open' && (
          <button className="btn btn--text btn--danger" onClick={leave} disabled={busy !== null}>
            {viewer.isLeader ? 'Dissolve the group' : 'Leave the group'}
          </button>
        )}
      </div>

      {sheet === 'leader' && (
        <PaymentSheet title="Pay for the group" lines={members.map((m) => ({ label: `1 spot · ${m.user.displayName}`, cents: group.shareCents }))} onPay={payForAll} onClose={() => setSheet(null)} />
      )}
      {sheet === 'share' && (
        <PaymentSheet
          title="Pay your share"
          lines={[{ label: `1 spot · ${a.title}`, cents: group.shareCents }]}
          note={<p>Your card is only charged once everyone in the group has paid.</p>}
          onPay={payShare}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'verify' && <VerifyIdModal onClose={() => setSheet(null)} />}
    </div>
  );
}
