import type { ActivityDetail, AdminStats, Attendee, HostingItem, LedgerEntry, PublicProfile, WalletDTO } from '../shared/types';
import { toPublicUser, type UserRow } from './auth';
import { addLedger, getActivityView, toSummary, type ActivityView } from './activities';
import { isTooYoung, refundTicket, toTicketDTO, type TicketRow } from './booking';
import { imageUrl } from './images';
import { closeGroupsOf, viewerGroup } from './groups';
import { HttpError, iso, nowIso, type Ctx } from './util';

export function getActivityDetail(ctx: Ctx, id: number, viewer?: UserRow): ActivityDetail {
  const a = getActivityView(ctx, id, viewer?.id);
  const isHost = viewer?.id === a.host_id;
  const ticketRow = viewer
    ? ctx.db.get<TicketRow>(`SELECT * FROM tickets WHERE activity_id = ? AND user_id = ? AND status = 'active'`, a.id, viewer.id)
    : undefined;
  const going = ctx.db.all<{ display_name: string; avatar_color: string; avatar_image: string | null }>(
    `SELECT u.display_name, u.avatar_color, u.avatar_image FROM tickets t JOIN users u ON u.id = t.user_id
     WHERE t.activity_id = ? AND t.status = 'active' ORDER BY t.id`,
    a.id,
  );
  const seesNames = isHost || Boolean(ticketRow);
  return {
    ...toSummary(a, viewer?.id),
    description: a.description,
    hideExact: Boolean(a.hide_exact),
    goingCount: going.length,
    going: seesNames ? going.map((g) => ({ displayName: g.display_name, avatarColor: g.avatar_color, avatarUrl: imageUrl(g.avatar_image) })) : null,
    photos: (JSON.parse(a.photos) as string[]).map((id) => ({ id, url: imageUrl(id)! })),
    refundableUntil: iso(new Date(Date.parse(a.starts_at) - ctx.config.refundCutoffMinutes * 60_000)),
    viewer: {
      isHost,
      tooYoung: Boolean(viewer?.id_verified_at) && !isHost && isTooYoung(a, viewer!),
      ticket: ticketRow && viewer ? toTicketDTO(ctx, ticketRow, a, viewer.id) : null,
      group: viewer && !isHost ? viewerGroup(ctx, viewer.id, a.id) : null,
    },
  };
}

function hostedActivity(ctx: Ctx, host: UserRow, id: number): ActivityView {
  const a = getActivityView(ctx, id, host.id);
  if (a.host_id !== host.id) throw new HttpError(403, 'Only the host can do that.', 'forbidden');
  return a;
}

/** The host calls it off: every guest gets a full refund and the pin comes off the map. */
export async function cancelActivity(ctx: Ctx, host: UserRow, id: number): Promise<void> {
  const a = hostedActivity(ctx, host, id);
  if (a.status !== 'active') throw new HttpError(409, 'This activity is already cancelled.', 'cancelled');
  if (a.ends_at <= nowIso(ctx)) throw new HttpError(409, 'This activity is already over.', 'ended');

  // Flip the status first so nobody can join while the refunds go out.
  ctx.db.run(`UPDATE activities SET status = 'cancelled', cancelled_at = ? WHERE id = ?`, nowIso(ctx), a.id);
  ctx.db.run(`DELETE FROM tickets WHERE activity_id = ? AND status = 'pending'`, a.id);
  await closeGroupsOf(ctx, a.id);

  const tickets = ctx.db.all<TicketRow>(`SELECT * FROM tickets WHERE activity_id = ? AND status = 'active'`, a.id);
  let failed = 0;
  for (const t of tickets) {
    try {
      await refundTicket(ctx, t, a);
    } catch {
      failed++;
    }
  }
  if (failed) throw new HttpError(502, `The activity is cancelled, but ${failed} refund(s) could not be processed yet.`, 'refund_failed');
}

/** The door list: who has a ticket, and who has arrived. */
export function listAttendees(ctx: Ctx, host: UserRow, id: number): Attendee[] {
  const a = hostedActivity(ctx, host, id);
  const rows = ctx.db.all<TicketRow & { display_name: string; avatar_color: string; avatar_image: string | null; id_verified_at: string | null; legal_name: string | null; group_code: string | null }>(
    `SELECT t.*, u.display_name, u.avatar_color, u.avatar_image, u.id_verified_at, u.legal_name, g.code AS group_code
     FROM tickets t JOIN users u ON u.id = t.user_id LEFT JOIN groups g ON g.id = t.group_id
     WHERE t.activity_id = ? AND t.status = 'active' ORDER BY t.id`,
    a.id,
  );
  return rows.map((r) => ({
    ticketId: r.id,
    code: r.code,
    displayName: r.display_name,
    avatarColor: r.avatar_color,
    avatarUrl: imageUrl(r.avatar_image),
    verified: Boolean(r.id_verified_at),
    // Legal names are only shared for ID-required activities — guests are told so before they join.
    legalName: a.security === 'verified' ? r.legal_name : null,
    groupCode: r.group_code,
    priceCents: r.price_cents,
    checkedInAt: r.checked_in_at,
    joinedAt: r.created_at,
  }));
}

export function setCheckedIn(ctx: Ctx, host: UserRow, activityId: number, ticketId: number, checkedIn: boolean): void {
  const a = hostedActivity(ctx, host, activityId);
  const changed = ctx.db.run(
    `UPDATE tickets SET checked_in_at = ? WHERE id = ? AND activity_id = ? AND status = 'active'`,
    checkedIn ? nowIso(ctx) : null, ticketId, a.id,
  ).changes;
  if (!changed) throw new HttpError(404, 'That ticket is not on this door list.', 'not_found');
}

/** Check someone in by the code on their ticket (typed in, or from the QR link). */
export function checkInByCode(ctx: Ctx, host: UserRow, rawCode: string): { attendee: Attendee; activityId: number; activityTitle: string; alreadyCheckedIn: boolean } {
  const code = rawCode.replace(/[^a-z0-9]/gi, '').toUpperCase();
  const t = ctx.db.get<TicketRow>('SELECT * FROM tickets WHERE code = ?', code);
  // Same answer for "no such code" and "someone else's event", so codes can't be probed.
  const a = t ? getActivityView(ctx, t.activity_id, host.id) : undefined;
  if (!t || !a || a.host_id !== host.id) throw new HttpError(404, 'No ticket with that code for an activity you host.', 'not_found');
  if (t.status !== 'active') throw new HttpError(409, 'That ticket was cancelled.', 'not_active');
  const already = t.checked_in_at !== null;
  if (!already) ctx.db.run('UPDATE tickets SET checked_in_at = ? WHERE id = ?', nowIso(ctx), t.id);
  const attendee = listAttendees(ctx, host, a.id).find((x) => x.ticketId === t.id)!;
  return { attendee, activityId: a.id, activityTitle: a.title, alreadyCheckedIn: already };
}

/** A member's public page: who they are and what they're hosting. Never includes e-mail, legal name or age. */
export function getPublicProfile(ctx: Ctx, userId: number, viewerId?: number): PublicProfile {
  const user = ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new HttpError(404, 'That member does not exist.', 'not_found');
  const ids = ctx.db.all<{ id: number }>(`SELECT id FROM activities WHERE host_id = ? AND status = 'active' AND ends_at > ? ORDER BY starts_at LIMIT 50`, userId, nowIso(ctx));
  return {
    user: toPublicUser(user),
    bio: user.bio,
    memberSince: user.created_at,
    activities: ids.map(({ id }) => toSummary(getActivityView(ctx, id, viewerId), viewerId)),
  };
}

export function listHosting(ctx: Ctx, host: UserRow): HostingItem[] {
  const ids = ctx.db.all<{ id: number }>('SELECT id FROM activities WHERE host_id = ? ORDER BY starts_at DESC LIMIT 200', host.id);
  return ids.map(({ id }) => {
    const a = getActivityView(ctx, id, host.id);
    const s = ctx.db.get<{ sold: number; checked: number; gross: number; fees: number }>(
      `SELECT COUNT(*) AS sold, COUNT(checked_in_at) AS checked, COALESCE(SUM(price_cents), 0) AS gross, COALESCE(SUM(fee_cents), 0) AS fees
       FROM tickets WHERE activity_id = ? AND status = 'active'`,
      id,
    )!;
    return { ...toSummary(a, host.id), sold: s.sold, checkedIn: s.checked, grossCents: s.gross, netCents: s.gross - s.fees };
  });
}

interface LedgerRow {
  id: number;
  kind: string;
  amount_cents: number;
  affects_balance: number;
  memo: string;
  activity_id: number | null;
  created_at: string;
}

const toEntry = (r: LedgerRow): LedgerEntry => ({
  id: r.id,
  kind: r.kind,
  amountCents: r.amount_cents,
  affectsBalance: Boolean(r.affects_balance),
  memo: r.memo,
  activityId: r.activity_id,
  createdAt: r.created_at,
});

/**
 * A host's money. Earnings stay "pending" until their activity has ended —
 * until then guests can still be refunded — and are "available" afterwards.
 */
export function getWallet(ctx: Ctx, user: UserRow): WalletDTO {
  const sum = (sql: string, ...params: (string | number)[]) => ctx.db.get<{ n: number }>(sql, ...params)!.n;
  const balance = sum('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id = ? AND affects_balance = 1', user.id);
  const pending = sum(
    `SELECT COALESCE(SUM(l.amount_cents), 0) AS n FROM ledger l JOIN activities a ON a.id = l.activity_id
     WHERE l.user_id = ? AND l.kind IN ('earning', 'earning_reversal') AND a.status = 'active' AND a.ends_at > ?`,
    user.id, nowIso(ctx),
  );
  const earned = sum(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id = ? AND kind IN ('earning', 'earning_reversal')`, user.id);
  const paidOut = -sum(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id = ? AND kind = 'payout'`, user.id);
  const entries = ctx.db.all<LedgerRow>('SELECT * FROM ledger WHERE user_id = ? ORDER BY id DESC LIMIT 100', user.id);
  return { availableCents: balance - pending, pendingCents: pending, paidOutCents: paidOut, earnedCents: earned, entries: entries.map(toEntry) };
}

/** Pay out everything that's available. In demo mode this just records it; a real build would move the money here. */
export function requestPayout(ctx: Ctx, user: UserRow): number {
  return ctx.db.tx(() => {
    const amount = getWallet(ctx, user).availableCents;
    if (amount <= 0) throw new HttpError(409, 'There is nothing available to pay out yet.', 'nothing_available');
    addLedger(ctx, { userId: user.id, kind: 'payout', amountCents: -amount, affectsBalance: true, memo: 'Payout to your bank' });
    return amount;
  });
}

// Sample activities created for demo mode are left out of the platform's figures.
const REAL_HOSTS = 'JOIN activities a ON a.id = t.activity_id JOIN users h ON h.id = a.host_id WHERE h.is_demo = 0';

/** What the platform itself has made: listing fees plus its cut of every ticket. */
export function getAdminStats(ctx: Ctx): AdminStats {
  const n = (sql: string, ...params: (string | number)[]) => ctx.db.get<{ n: number }>(sql, ...params)!.n;
  return {
    listingFeesCents: n(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id IS NULL AND kind = 'listing_fee'`),
    commissionCents: n(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id IS NULL AND kind IN ('commission', 'commission_reversal')`),
    ticketVolumeCents: n(`SELECT COALESCE(SUM(t.price_cents), 0) AS n FROM tickets t ${REAL_HOSTS} AND t.status = 'active'`),
    payoutsCents: -n(`SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE kind = 'payout'`),
    users: n('SELECT COUNT(*) AS n FROM users WHERE is_demo = 0'),
    verifiedUsers: n('SELECT COUNT(*) AS n FROM users WHERE is_demo = 0 AND id_verified_at IS NOT NULL'),
    activities: n('SELECT COUNT(*) AS n FROM activities a JOIN users h ON h.id = a.host_id WHERE h.is_demo = 0'),
    upcomingActivities: n(`SELECT COUNT(*) AS n FROM activities a JOIN users h ON h.id = a.host_id WHERE h.is_demo = 0 AND a.status = 'active' AND a.ends_at > ?`, nowIso(ctx)),
    ticketsSold: n(`SELECT COUNT(*) AS n FROM tickets t ${REAL_HOSTS} AND t.status = 'active'`),
    recent: ctx.db.all<LedgerRow>('SELECT * FROM ledger WHERE user_id IS NULL ORDER BY id DESC LIMIT 30').map(toEntry),
  };
}
