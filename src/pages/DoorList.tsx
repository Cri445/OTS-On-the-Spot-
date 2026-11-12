import { useState } from 'react';
import { ArrowLeft, Check, Download, ScanLine, Search, UserPlus } from 'lucide-react';
import { Link, useParams } from 'react-router';
import type { ActivityDetail, Attendee } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { Avatar, Empty, LoadState, Spinner, Stat, VerifiedBadge, cx } from '../components/ui';
import { formatTime, formatWhen, prettyCode } from '../lib/format';
import { useLoad } from '../lib/use-load';

function downloadCsv(filename: string, rows: string[][]) {
  const escape = (cell: string) => {
    // Neutralise spreadsheet formulas in names, then quote.
    const safe = /^[=+\-@]/.test(cell) ? `'${cell}` : cell;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  const csv = rows.map((r) => r.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** The host's door list: who has a ticket, who has arrived, and a box to check people in by code. */
export function DoorList() {
  const id = Number(useParams().id);
  const { config, money, toast } = useApp();
  const [code, setCode] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload, setData } = useLoad(
    () =>
      Promise.all([api<{ activity: ActivityDetail }>(`/activities/${id}`), api<{ attendees: Attendee[] }>(`/activities/${id}/attendees`)]).then(([a, l]) => ({
        activity: a.activity,
        attendees: l.attendees,
      })),
    [id],
  );

  if (!data) {
    return (
      <div className="page">
        <LoadState loading={loading} error={error} onRetry={reload} />
      </div>
    );
  }

  const { activity: a, attendees } = data;
  const arrived = attendees.filter((x) => x.checkedInAt).length;
  const showLegal = a.security === 'verified';
  const needle = search.trim().toLowerCase();
  const shown = attendees.filter((x) => !needle || x.displayName.toLowerCase().includes(needle) || (x.legalName ?? '').toLowerCase().includes(needle) || x.code.toLowerCase().includes(needle.replace('-', '')));

  async function toggle(x: Attendee) {
    const checkedIn = !x.checkedInAt;
    // Update the row straight away; put it back if the server says no.
    const apply = (value: string | null) => setData({ activity: a, attendees: attendees.map((y) => (y.ticketId === x.ticketId ? { ...y, checkedInAt: value } : y)) });
    apply(checkedIn ? new Date().toISOString() : null);
    try {
      await post(`/activities/${id}/attendees/${x.ticketId}/checkin`, { checkedIn });
    } catch (err) {
      apply(x.checkedInAt);
      toast(errorMessage(err), 'error');
    }
  }

  async function checkInCode(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    try {
      const res = await post<{ attendee: Attendee; activityId: number; alreadyCheckedIn: boolean }>('/checkin', { code });
      if (res.activityId !== id) toast(`That ticket is for a different activity of yours — ${res.attendee.displayName} is checked in there.`, 'info');
      else toast(res.alreadyCheckedIn ? `${res.attendee.displayName} was already checked in.` : `${res.attendee.displayName} is checked in.`, res.alreadyCheckedIn ? 'info' : 'ok');
      setCode('');
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function addSampleGuests() {
    setBusy(true);
    try {
      const res = await post<{ added: number }>(`/demo/activities/${id}/guests`);
      toast(`${res.added} sample guests bought tickets.`);
      await reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    const header = ['Name', ...(showLegal ? ['Legal name'] : []), 'ID verified', 'Ticket', 'Paid', 'Group', 'Checked in'];
    const rows = attendees.map((x) => [
      x.displayName,
      ...(showLegal ? [x.legalName ?? ''] : []),
      x.verified ? 'yes' : 'no',
      prettyCode(x.code),
      (x.priceCents / 100).toFixed(2),
      x.groupCode ?? '',
      x.checkedInAt ? new Date(x.checkedInAt).toLocaleString() : '',
    ]);
    downloadCsv(`ots-door-list-${a.id}.csv`, [header, ...rows]);
  }

  return (
    <div className="page">
      <div className="pagebar">
        <Link to={`/a/${a.id}`} className="backlink">
          <ArrowLeft size={18} aria-hidden /> Activity
        </Link>
        {attendees.length > 0 && (
          <button className="btn btn--ghost btn--sm" onClick={exportCsv}>
            <Download size={16} aria-hidden /> Download list
          </button>
        )}
      </div>
      <span className="eyebrow">Door list</span>
      <h1 className="pagetitle">{a.title}</h1>
      <p className="muted">{formatWhen(a)}</p>

      <div className="stats">
        <Stat label="Arrived" value={`${arrived} / ${attendees.length}`} tone="spot" />
        <Stat label="Spots left" value={a.spotsLeft} hint={`of ${a.capacity}`} />
        <Stat label="Ticket sales" value={money(attendees.reduce((sum, x) => sum + x.priceCents, 0))} hint={`before OTS's ${config.commissionBps / 100}%`} />
      </div>

      <form className="checkin" onSubmit={checkInCode}>
        <label className="search">
          <ScanLine size={18} aria-hidden />
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="Ticket code, e.g. ABCD-2345" aria-label="Ticket code" autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        </label>
        <button className="btn btn--primary" disabled={busy || !code.trim()}>
          {busy ? <Spinner /> : <Check size={18} aria-hidden />} Check in
        </button>
      </form>
      <p className="fineprint">Type the code from a guest's ticket, or scan its QR code with your phone's camera — it opens the check-in for you. You can also just tap a name below.</p>

      {attendees.length === 0 ? (
        <Empty emoji="🚪" title="Nobody on the list yet">
          <p>Guests show up here the moment they join.</p>
          {config.demoMode && (
            <button className="btn btn--ghost" onClick={addSampleGuests} disabled={busy}>
              <UserPlus size={16} aria-hidden /> Add sample guests
            </button>
          )}
        </Empty>
      ) : (
        <>
          <div className="listtools">
            <label className="search">
              <Search size={18} aria-hidden />
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a guest" aria-label="Find a guest" />
            </label>
            {config.demoMode && a.spotsLeft > 0 && (
              <button className="btn btn--ghost btn--sm" onClick={addSampleGuests} disabled={busy}>
                <UserPlus size={16} aria-hidden /> Add sample guests
              </button>
            )}
          </div>
          <ul className="door">
            {shown.map((x) => (
              <li key={x.ticketId} className={cx(x.checkedInAt && 'is-in')}>
                <Avatar name={x.displayName} color={x.avatarColor} />
                <div className="door__who">
                  <strong>{showLegal && x.legalName ? x.legalName : x.displayName}</strong>
                  <span className="muted">
                    {showLegal && x.legalName && `“${x.displayName}” · `}
                    {prettyCode(x.code)}
                    {x.groupCode && ` · group ${x.groupCode}`}
                  </span>
                  {x.verified && <VerifiedBadge />}
                </div>
                <button className={cx('checkbtn', x.checkedInAt && 'is-on')} onClick={() => toggle(x)} aria-pressed={Boolean(x.checkedInAt)}>
                  <Check size={16} aria-hidden />
                  {x.checkedInAt ? `In · ${formatTime(x.checkedInAt)}` : 'Check in'}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="muted">No guest matches “{search}”.</li>}
          </ul>
        </>
      )}
    </div>
  );
}
