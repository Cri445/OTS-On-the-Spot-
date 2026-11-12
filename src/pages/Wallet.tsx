import { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Banknote } from 'lucide-react';
import { Link } from 'react-router';
import type { LedgerEntry, WalletDTO } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { DemoNote, Empty, LoadState, Spinner, Stat, cx } from '../components/ui';
import { formatDateTime } from '../lib/format';
import { useLoad } from '../lib/use-load';

const KIND_LABEL: Record<string, string> = {
  earning: 'Ticket sold',
  earning_reversal: 'Ticket refunded',
  payout: 'Payout',
  ticket: 'Ticket bought',
  refund: 'Refund',
  listing_fee: 'Listing fee',
  commission: 'Commission',
  commission_reversal: 'Commission returned',
};

export function EntryList({ entries }: { entries: LedgerEntry[] }) {
  const { money } = useApp();
  return (
    <ul className="entries">
      {entries.map((e) => (
        <li key={e.id}>
          <span className={cx('entries__icon', e.amountCents >= 0 ? 'is-in' : 'is-out')} aria-hidden>
            {e.amountCents >= 0 ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
          </span>
          <div>
            <strong>{KIND_LABEL[e.kind] ?? e.kind}</strong>
            <span className="muted">
              {e.memo.replace(/^[^·]*· /, '') || '—'} · {formatDateTime(e.createdAt)}
            </span>
          </div>
          <span className={cx('entries__amount', e.amountCents >= 0 && 'is-in')}>
            {e.amountCents >= 0 ? '+' : '−'}
            {money(Math.abs(e.amountCents))}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** What hosting has earned, what can be paid out, and every charge and refund on the account. */
export function Wallet() {
  const { money, config, toast } = useApp();
  const [busy, setBusy] = useState(false);
  const { data: wallet, error, loading, reload, setData } = useLoad(() => api<{ wallet: WalletDTO }>('/wallet').then((r) => r.wallet), []);

  if (!wallet) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  async function payout() {
    setBusy(true);
    try {
      const res = await post<{ amountCents: number; wallet: WalletDTO }>('/wallet/payout');
      setData(res.wallet);
      toast(`${money(res.amountCents)} is on its way to your bank.`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <h1 className="pagetitle">Wallet</h1>

      <div className="stats">
        <Stat label="Ready to pay out" value={money(wallet.availableCents)} hint="From activities that have ended" tone="spot" />
        <Stat label="Pending" value={money(wallet.pendingCents)} hint="Released when the activity ends" />
        <Stat label="Paid out" value={money(wallet.paidOutCents)} hint={`${money(wallet.earnedCents)} earned in total`} />
      </div>

      <div className="payout">
        <div>
          <strong>Pay out to your bank</strong>
          <p className="muted">
            You keep {100 - config.commissionBps / 100}% of every ticket. Earnings are held until the activity is over, so guests can be refunded if plans change.
          </p>
        </div>
        <button className="btn btn--primary" onClick={payout} disabled={busy || wallet.availableCents <= 0}>
          {busy ? <Spinner /> : <Banknote size={18} aria-hidden />} Pay out {wallet.availableCents > 0 ? money(wallet.availableCents) : ''}
        </button>
      </div>
      {config.demoMode && <DemoNote>Payouts are recorded but no money is transferred. A live version would send them through a payment processor.</DemoNote>}

      <section>
        <h2>Activity</h2>
        {wallet.entries.length === 0 ? (
          <Empty emoji="💸" title="Nothing here yet">
            <p>Ticket purchases, listing fees, earnings and refunds will show up here.</p>
            <Link to="/host" className="btn btn--primary">
              Host an activity
            </Link>
          </Empty>
        ) : (
          <EntryList entries={wallet.entries} />
        )}
      </section>
    </div>
  );
}
