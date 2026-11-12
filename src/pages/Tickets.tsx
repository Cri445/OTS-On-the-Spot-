import { useEffect, useState } from 'react';
import { CalendarClock, MapPin, Navigation, Users } from 'lucide-react';
import QRCode from 'qrcode';
import { Link } from 'react-router';
import type { GroupListItem, TicketDTO } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { CategoryIcon, Empty, LoadState, Modal, Spinner, cx } from '../components/ui';
import { formatDateTime, formatWhen, phaseOf, plural, prettyCode, timingLabel } from '../lib/format';
import { useLoad, useNow } from '../lib/use-load';

/** The QR on a ticket is a link the host's phone camera can open to check the guest in. */
function TicketQr({ code }: { code: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(`${window.location.origin}/checkin/${code}`, { margin: 1, width: 240, color: { dark: '#12131a', light: '#ffffff' } })
      .then((url) => live && setSrc(url))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code]);
  return src ? <img className="ticket__qr" src={src} alt={`QR code for ticket ${prettyCode(code)}`} width={120} height={120} /> : <div className="ticket__qr" aria-hidden />;
}

export function Tickets() {
  const { money, toast, config } = useApp();
  const now = useNow();
  const [cancelling, setCancelling] = useState<TicketDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api<{ tickets: TicketDTO[]; groups: GroupListItem[] }>('/tickets'), []);

  if (!data) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const isCurrent = (t: TicketDTO) => t.status === 'active' && ['upcoming', 'live'].includes(phaseOf(t.activity, now));
  const current = data.tickets.filter(isCurrent).sort((x, y) => x.activity.startsAt.localeCompare(y.activity.startsAt));
  const past = data.tickets.filter((t) => !isCurrent(t));

  async function cancel() {
    if (!cancelling) return;
    setBusy(true);
    try {
      await post(`/tickets/${cancelling.id}/cancel`);
      toast(cancelling.priceCents ? `Ticket cancelled. ${money(cancelling.priceCents)} is on its way back to you.` : 'Ticket cancelled.');
      setCancelling(null);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1 className="pagetitle">My tickets</h1>

      {data.groups.length > 0 && (
        <section>
          <h2>Groups you're forming</h2>
          <ul className="grouplinks">
            {data.groups.map((g) => (
              <li key={g.code}>
                <Link to={`/g/${g.code}`}>
                  <Users size={20} aria-hidden />
                  <div>
                    <strong>{g.activity.title}</strong>
                    <span className="muted">
                      {plural(g.size, 'person', 'people')} · {g.status === 'holding' ? 'spots held — waiting for payments' : g.isLeader ? 'lock in when everyone is ready' : 'waiting for the leader'}
                    </span>
                  </div>
                  <span className={cx('tag', g.status === 'holding' && 'tag--live')}>{g.status === 'holding' ? 'Pay now' : 'Open lobby'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {current.length === 0 && past.length === 0 && data.groups.length === 0 && (
        <Empty emoji="🎟️" title="No tickets yet">
          <p>Find something happening near you and you'll have one in two taps.</p>
          <Link to="/" className="btn btn--primary">
            Explore the map
          </Link>
        </Empty>
      )}

      {current.length > 0 && (
        <section>
          <h2>Coming up</h2>
          <ul className="tickets">
            {current.map((t) => (
              <li key={t.id} className="ticket">
                <div className="ticket__main">
                  <div className="ticket__head">
                    <CategoryIcon a={t.activity} />
                    <div>
                      <Link to={`/a/${t.activity.id}`} className="ticket__title">
                        {t.activity.title}
                      </Link>
                      <span className={cx('muted', phaseOf(t.activity, now) === 'live' && 'is-live')}>{timingLabel(t.activity, now)}</span>
                    </div>
                  </div>
                  <p className="ticket__fact">
                    <CalendarClock size={16} aria-hidden /> {formatWhen(t.activity, new Date(now))}
                  </p>
                  <p className="ticket__fact">
                    <MapPin size={16} aria-hidden /> {t.activity.address}
                    <a className="link" href={`https://www.google.com/maps/search/?api=1&query=${t.activity.lat},${t.activity.lng}`} target="_blank" rel="noreferrer">
                      <Navigation size={13} aria-hidden /> Directions
                    </a>
                  </p>
                  <div className="ticket__foot">
                    <span className="tag">{t.priceCents ? `Paid ${money(t.priceCents)}` : 'Free'}</span>
                    {t.groupCode && (
                      <span className="tag">
                        <Users size={12} aria-hidden /> With your group
                      </span>
                    )}
                    {t.checkedInAt && <span className="tag tag--calm">Checked in</span>}
                    {t.refundable && !t.checkedInAt && (
                      <button className="link link--danger" onClick={() => setCancelling(t)}>
                        Cancel ticket
                      </button>
                    )}
                  </div>
                </div>
                <div className="ticket__stub">
                  <TicketQr code={t.code} />
                  <span className="ticket__code">{prettyCode(t.code)}</span>
                  <span className="fineprint">Show at the door</span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {past.length > 0 && (
        <section>
          <h2>Past & cancelled</h2>
          <ul className="pasttickets">
            {past.map((t) => (
              <li key={t.id}>
                <CategoryIcon a={t.activity} />
                <div>
                  <Link to={`/a/${t.activity.id}`}>{t.activity.title}</Link>
                  <span className="muted">{formatDateTime(t.activity.startsAt)}</span>
                </div>
                <span className={cx('tag', t.status === 'cancelled' && 'tag--danger')}>{t.status === 'cancelled' ? (t.priceCents ? 'Refunded' : 'Cancelled') : t.checkedInAt ? 'Attended' : 'Ended'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {cancelling && (
        <Modal
          title="Cancel your ticket?"
          onClose={() => setCancelling(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setCancelling(null)}>
                Keep it
              </button>
              <button className="btn btn--dangerfill" onClick={cancel} disabled={busy}>
                {busy && <Spinner />} Cancel ticket
              </button>
            </>
          }
        >
          <p>
            You'll give up your spot at <strong>{cancelling.activity.title}</strong>
            {cancelling.priceCents ? ` and get ${money(cancelling.priceCents)} back` : ''}.
          </p>
          {cancelling.priceCents > 0 && <p className="muted">Refunds are possible until {config.refundCutoffMinutes / 60} hours before the start.</p>}
        </Modal>
      )}
    </div>
  );
}
