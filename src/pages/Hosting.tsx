import { DoorOpen, Pencil, Plus } from 'lucide-react';
import { Link } from 'react-router';
import type { HostingItem, WalletDTO } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../app-context';
import { whenLine } from '../components/ActivityCard';
import { CategoryIcon, Empty, LoadState, Stat, cx } from '../components/ui';
import { phaseOf, plural } from '../lib/format';
import { useLoad, useNow } from '../lib/use-load';

/** Everything the person is hosting, with how full each one is and what it has earned. */
export function Hosting() {
  const { money, config } = useApp();
  const now = useNow();
  const { data, error, loading, reload } = useLoad(
    () => Promise.all([api<{ activities: HostingItem[] }>('/hosting'), api<{ wallet: WalletDTO }>('/wallet')]).then(([h, w]) => ({ items: h.activities, wallet: w.wallet })),
    [],
  );

  if (!data) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const { items, wallet } = data;
  const current = items.filter((a) => ['upcoming', 'live'].includes(phaseOf(a, now))).reverse();
  const past = items.filter((a) => !['upcoming', 'live'].includes(phaseOf(a, now)));
  const guests = current.reduce((sum, a) => sum + a.sold, 0);

  const row = (a: HostingItem) => {
    const phase = phaseOf(a, now);
    const open = phase === 'upcoming' || phase === 'live';
    return (
      <li key={a.id} className={cx('hostrow', !open && 'is-past')}>
        <CategoryIcon a={a} />
        <div className="hostrow__body">
          <Link to={`/a/${a.id}`} className="hostrow__title">
            {a.title}
          </Link>
          <span className="muted">
            {whenLine(a, now).live && <span className="live-dot" aria-hidden />} {whenLine(a, now).text}
          </span>
          <div className="hostrow__nums">
            <span>
              <strong>
                {a.sold}/{a.capacity}
              </strong>{' '}
              going
            </span>
            {a.sold > 0 && (
              <span>
                <strong>{a.checkedIn}</strong> checked in
              </span>
            )}
            <span>
              <strong>{a.netCents ? money(a.netCents) : a.priceCents ? money(0) : 'Free'}</strong>
              {a.priceCents > 0 && ' earned'}
            </span>
          </div>
        </div>
        {open && (
          <div className="hostrow__actions">
            <Link to={`/a/${a.id}/door`} className="btn btn--ghost btn--sm">
              <DoorOpen size={16} aria-hidden /> Door list
            </Link>
            <Link to={`/a/${a.id}/edit`} className="btn btn--ghost btn--sm" aria-label={`Edit ${a.title}`}>
              <Pencil size={16} aria-hidden />
            </Link>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="page">
      <div className="pagehead">
        <h1 className="pagetitle">Hosting</h1>
        <Link to="/host" className="btn btn--spot">
          <Plus size={18} aria-hidden /> Host an activity
        </Link>
      </div>

      <div className="stats">
        <Stat label="On the map" value={current.length} hint={plural(guests, 'guest')} />
        <Stat label="Earned so far" value={money(wallet.earnedCents)} hint={`after OTS's ${config.commissionBps / 100}%`} />
        <Stat label="Ready to pay out" value={money(wallet.availableCents)} hint={<Link to="/wallet">Go to wallet</Link>} tone="spot" />
      </div>

      {items.length === 0 ? (
        <Empty emoji="🎈" title="You're not hosting anything yet">
          <p>A party that needs more people, a tennis court with a free slot, a table with empty chairs — put it on the map.</p>
          <Link to="/host" className="btn btn--primary">
            Host your first activity
          </Link>
        </Empty>
      ) : (
        <>
          {current.length > 0 && (
            <section>
              <h2>On the map now</h2>
              <ul className="hostrows">{current.map(row)}</ul>
            </section>
          )}
          {past.length > 0 && (
            <section>
              <h2>Past & cancelled</h2>
              <ul className="hostrows">{past.map(row)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
