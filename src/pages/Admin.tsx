import type { AdminStats } from '../../shared/types';
import { api } from '../api';
import { useApp } from '../app-context';
import { DemoNote, Empty, LoadState, Stat } from '../components/ui';
import { useLoad } from '../lib/use-load';
import { EntryList } from './Wallet';

/** What OTS itself earns: listing fees plus its cut of every ticket. */
export function Admin() {
  const { money, config } = useApp();
  const { data: s, error, loading, reload } = useLoad(() => api<{ stats: AdminStats }>('/admin/stats').then((r) => r.stats), []);

  if (!s) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  return (
    <div className="page">
      <span className="eyebrow">Admin</span>
      <h1 className="pagetitle">Platform revenue</h1>
      {config.demoMode && <DemoNote>These figures come from simulated payments. Sample activities aren't counted — only what real accounts list and buy.</DemoNote>}

      <div className="stats">
        <Stat label="OTS revenue" value={money(s.listingFeesCents + s.commissionCents)} hint="Listing fees + commission" tone="ink" />
        <Stat label="Listing fees" value={money(s.listingFeesCents)} hint={`${money(config.listingFeeCents.standard)} standard · ${money(config.listingFeeCents.featured)} featured`} />
        <Stat label={`Commission (${config.commissionBps / 100}%)`} value={money(s.commissionCents)} hint={`on ${money(s.ticketVolumeCents)} of ticket sales`} />
      </div>
      <div className="stats">
        <Stat label="Members" value={s.users} hint={`${s.verifiedUsers} ID-verified`} />
        <Stat label="Activities listed" value={s.activities} hint={`${s.upcomingActivities} on the map now`} />
        <Stat label="Tickets sold" value={s.ticketsSold} hint={`${money(s.payoutsCents)} paid out to hosts`} />
      </div>

      <section>
        <h2>Latest revenue</h2>
        {s.recent.length === 0 ? (
          <Empty emoji="📈" title="No revenue yet">
            <p>Host an activity or buy a ticket and it shows up here.</p>
          </Empty>
        ) : (
          <EntryList entries={s.recent} />
        )}
      </section>
    </div>
  );
}
