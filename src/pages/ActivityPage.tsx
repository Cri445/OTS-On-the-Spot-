import { useState } from 'react';
import { ArrowLeft, CalendarClock, DoorOpen, EyeOff, MapPin, Navigation, Pencil, Share2, ShieldCheck, Star, Ticket, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { categoryOf, tagLabel } from '../../shared/catalog';
import type { ActivityDetail } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { PinMap } from '../components/maps';
import { PaymentSheet } from '../components/PaymentSheet';
import { VerifyIdModal } from '../components/VerifyIdModal';
import { Avatar, CategoryIcon, LoadState, Modal, SpotsBar, Spinner, VerifiedBadge, VibeChip, cx } from '../components/ui';
import { formatDateTime, formatWhen, phaseOf, plural, prettyCode, timingLabel } from '../lib/format';
import { useLoad, useNow } from '../lib/use-load';

export async function shareLink(url: string, title: string, toast: (text: string) => void) {
  try {
    if (navigator.share) await navigator.share({ title, url });
    else {
      await navigator.clipboard.writeText(url);
      toast('Link copied.');
    }
  } catch {
    /* the share sheet was dismissed */
  }
}

export function ActivityPage() {
  const id = Number(useParams().id);
  const { user, toast } = useApp();
  const now = useNow();
  const { data: a, error, loading, reload, setData } = useLoad(() => api<{ activity: ActivityDetail }>(`/activities/${id}`).then((r) => r.activity), [id, user?.id]);

  if (!a) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const phase = phaseOf(a, now);
  const category = categoryOf(a.category);

  return (
    <div className="page page--wide">
      <div className="pagebar">
        <Link to="/" className="backlink">
          <ArrowLeft size={18} aria-hidden /> Map
        </Link>
        <button className="btn btn--ghost btn--sm" onClick={() => shareLink(window.location.href, a.title, toast)}>
          <Share2 size={16} aria-hidden /> Share
        </button>
      </div>

      <div className="detail">
        <header className="detail__head">
          <div className={`hero hero--${a.vibe}`}>
            <CategoryIcon a={a} size="lg" />
            <div className="hero__chips">
              <VibeChip vibe={a.vibe} />
              <span className="tag">{category.label}</span>
              {a.featured && (
                <span className="tag tag--featured">
                  <Star size={12} fill="currentColor" aria-hidden /> Featured
                </span>
              )}
              {phase === 'live' && (
                <span className="tag tag--live">
                  <span className="live-dot" aria-hidden /> Happening now
                </span>
              )}
              {phase === 'cancelled' && <span className="tag tag--danger">Cancelled</span>}
              {phase === 'ended' && <span className="tag">Ended</span>}
            </div>
          </div>
          <h1>{a.title}</h1>
          <div className="hostline">
            <Avatar name={a.host.displayName} color={a.host.avatarColor} size={32} />
            <span>
              Hosted by <strong>{a.host.displayName}</strong>
            </span>
            {a.host.verified && <VerifiedBadge />}
          </div>

          <dl className="facts">
            <div>
              <dt>
                <CalendarClock size={16} aria-hidden /> When
              </dt>
              <dd>
                {formatWhen(a, new Date(now))}
                <small>{timingLabel(a, now)}</small>
              </dd>
            </div>
            <div>
              <dt>
                <MapPin size={16} aria-hidden /> Where
              </dt>
              <dd>
                {a.address ?? 'Exact address after you join'}
                {a.approximate && (
                  <small>
                    <EyeOff size={12} aria-hidden /> The pin shows the rough area
                  </small>
                )}
              </dd>
            </div>
            <div>
              <dt>
                <ShieldCheck size={16} aria-hidden /> Who can join
              </dt>
              <dd>
                {a.security === 'verified' ? 'ID-verified guests only' : 'Open to everyone'}
                <small>{a.security === 'verified' ? 'The host knows who is on the list' : 'Any OTS member'}</small>
              </dd>
            </div>
          </dl>
        </header>

        <aside className="detail__side">
          <JoinPanel a={a} now={now} onChange={setData} reload={reload} />
        </aside>

        <div className="detail__body">
          {a.description && (
            <section>
              <h2>About</h2>
              <p className="prose">{a.description}</p>
            </section>
          )}
          {a.tags.length > 0 && (
            <section>
              <h2>What it's like</h2>
              <div className="tags tags--lg">
                {a.tags.map((t) => (
                  <span key={t} className="tag">
                    {tagLabel(t)}
                  </span>
                ))}
              </div>
            </section>
          )}
          <section>
            <h2>Who's going</h2>
            {a.goingCount === 0 ? (
              <p className="muted">Nobody yet — be the first.</p>
            ) : a.going ? (
              <ul className="going">
                {a.going.map((g, i) => (
                  <li key={i}>
                    <Avatar name={g.displayName} color={g.avatarColor} size={30} /> {g.displayName}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{plural(a.goingCount, 'person is', 'people are')} going. You'll see who once you're in.</p>
            )}
          </section>
          <section>
            <h2>Where</h2>
            <PinMap pos={{ lat: a.lat, lng: a.lng }} approximate={a.approximate} className="map-canvas--inline" />
            {a.approximate ? (
              <p className="muted">The host shares the exact address with guests only. It's somewhere in the highlighted area.</p>
            ) : (
              <a className="link" href={`https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}`} target="_blank" rel="noreferrer">
                <Navigation size={14} aria-hidden /> Get directions
              </a>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function JoinPanel({ a, now, onChange, reload }: { a: ActivityDetail; now: number; onChange: (a: ActivityDetail) => void; reload: () => Promise<void> }) {
  const { user, config, money, toast } = useApp();
  const navigate = useNavigate();
  const [sheet, setSheet] = useState<'pay' | 'verify' | 'cancel' | null>(null);
  const [busy, setBusy] = useState(false);
  const phase = phaseOf(a, now);
  const price = a.priceCents === 0 ? 'Free' : money(a.priceCents);
  const loginUrl = `/login?next=${encodeURIComponent(`/a/${a.id}`)}`;

  const header = (
    <div className="joinbox__price">
      <strong>{price}</strong>
      {a.priceCents > 0 && <span>per person</span>}
    </div>
  );

  if (phase === 'cancelled' || phase === 'ended') {
    return (
      <div className="joinbox">
        <h2>{phase === 'cancelled' ? 'This activity was cancelled' : 'This activity is over'}</h2>
        <p className="muted">{phase === 'cancelled' ? 'Anyone who paid has been refunded in full.' : 'Hope it was a good one.'}</p>
        <Link to="/" className="btn btn--primary btn--block">
          Find something else
        </Link>
      </div>
    );
  }

  if (a.viewer.isHost) {
    const going = a.capacity - a.spotsLeft;
    async function cancel() {
      setBusy(true);
      try {
        await post(`/activities/${a.id}/cancel`);
        toast('Activity cancelled. Everyone has been refunded.');
        setSheet(null);
        await reload();
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        setBusy(false);
      }
    }
    return (
      <div className="joinbox">
        <span className="eyebrow">You're hosting this</span>
        <h2>
          {going} going · {plural(a.spotsLeft, 'spot')} left
        </h2>
        <SpotsBar a={a} />
        <Link to={`/a/${a.id}/door`} className="btn btn--primary btn--block">
          <DoorOpen size={18} aria-hidden /> Door list & check-in
        </Link>
        <Link to={`/a/${a.id}/edit`} className="btn btn--ghost btn--block">
          <Pencil size={16} aria-hidden /> Edit
        </Link>
        <button className="btn btn--text btn--danger" onClick={() => setSheet('cancel')}>
          Cancel this activity
        </button>
        {sheet === 'cancel' && (
          <Modal
            title="Cancel this activity?"
            onClose={() => setSheet(null)}
            footer={
              <>
                <button className="btn btn--ghost" onClick={() => setSheet(null)}>
                  Keep it
                </button>
                <button className="btn btn--dangerfill" onClick={cancel} disabled={busy}>
                  {busy && <Spinner />} Cancel activity
                </button>
              </>
            }
          >
            <p>
              It comes off the map straight away{going > 0 ? ` and ${plural(going, 'guest gets', 'guests get')} a full refund` : ''}. Your listing fee isn't refunded. This can't be undone.
            </p>
          </Modal>
        )}
      </div>
    );
  }

  if (a.viewer.ticket) {
    return (
      <div className="joinbox joinbox--in">
        <span className="eyebrow">You're in 🎟️</span>
        <h2>See you there</h2>
        <p className="muted">Show this code at the door.</p>
        <div className="ticketcode">{prettyCode(a.viewer.ticket.code)}</div>
        <Link to="/tickets" className="btn btn--primary btn--block">
          <Ticket size={18} aria-hidden /> View my ticket
        </Link>
      </div>
    );
  }

  if (a.viewer.group) {
    return (
      <div className="joinbox">
        {header}
        <span className="eyebrow">Your group of {a.viewer.group.size}</span>
        <p className="muted">{a.viewer.group.status === 'holding' ? 'Your spots are being held while everyone pays.' : "You're partying up for this one. Lock in when everyone's ready."}</p>
        <Link to={`/g/${a.viewer.group.code}`} className="btn btn--primary btn--block">
          <Users size={18} aria-hidden /> Open group lobby
        </Link>
      </div>
    );
  }

  const full = a.spotsLeft === 0;
  const needsId = a.security === 'verified' && Boolean(user) && !user!.verified;

  async function partyUp() {
    if (!user) return navigate(loginUrl);
    setBusy(true);
    try {
      const { code } = await post<{ code: string }>(`/activities/${a.id}/groups`);
      navigate(`/g/${code}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
      setBusy(false);
    }
  }

  async function pay(paymentMethod: string) {
    const res = await post<{ activity: ActivityDetail }>(`/activities/${a.id}/join`, { paymentMethod });
    onChange(res.activity);
    setSheet(null);
    toast("You're in! Your ticket is ready.");
  }

  return (
    <div className="joinbox">
      {header}
      <SpotsBar a={a} />

      {needsId && (
        <div className="callout">
          <ShieldCheck size={18} aria-hidden />
          <div>
            <strong>ID-verified guests only</strong>
            <p>This host wants to know who's coming. Verify once and you're set for every ID-only activity.</p>
          </div>
        </div>
      )}

      {!user ? (
        <Link to={loginUrl} className="btn btn--primary btn--block btn--lg">
          Log in to join
        </Link>
      ) : needsId ? (
        <button className="btn btn--primary btn--block btn--lg" onClick={() => setSheet('verify')}>
          Verify my ID to join
        </button>
      ) : (
        <button className="btn btn--primary btn--block btn--lg" onClick={() => setSheet('pay')} disabled={full}>
          {full ? 'Full' : a.priceCents === 0 ? 'Join for free' : `Join · ${price}`}
        </button>
      )}

      <button className={cx('btn btn--ghost btn--block', busy && 'is-busy')} onClick={partyUp} disabled={busy || full}>
        <Users size={18} aria-hidden /> Party up with friends
      </button>
      <p className="fineprint">Party up to get in together: either the whole group gets a spot, or nobody is charged.</p>
      {a.priceCents > 0 && (
        <p className="fineprint">
          {Date.parse(a.refundableUntil) > now
            ? `Free cancellation until ${formatDateTime(a.refundableUntil)}.`
            : `It starts in under ${config.refundCutoffMinutes / 60} hours, so tickets can no longer be refunded.`}{' '}
          OTS keeps {config.commissionBps / 100}% of the price; the rest goes to the host.
        </p>
      )}

      {sheet === 'pay' && (
        <PaymentSheet
          title={a.priceCents === 0 ? 'Join for free' : 'Get your spot'}
          lines={[{ label: `1 spot · ${a.title}`, cents: a.priceCents }]}
          confirmLabel={a.priceCents === 0 ? 'Confirm my spot' : undefined}
          note={a.security === 'verified' ? <p>The host will see your legal name ({user?.legalName}) on the door list.</p> : undefined}
          onPay={pay}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'verify' && <VerifyIdModal onClose={() => setSheet(null)} />}
    </div>
  );
}
