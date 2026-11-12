import { commissionCents } from '../shared/money';
import type { TicketDTO } from '../shared/types';
import type { UserRow } from './auth';
import { addLedger, getActivityView, PENDING_TTL_MS, toSummary, type ActivityRow, type ActivityView } from './activities';
import { HttpError, iso, nowIso, randomCode, type Ctx } from './util';

export interface TicketRow {
  id: number;
  activity_id: number;
  user_id: number;
  group_id: number | null;
  payment_id: number | null;
  code: string;
  price_cents: number;
  fee_cents: number;
  status: string;
  checked_in_at: string | null;
  created_at: string;
  cancelled_at: string | null;
}

interface PaymentRow {
  id: number;
  user_id: number;
  amount_cents: number;
  provider_ref: string;
}

const pendingCutoff = (ctx: Ctx): string => iso(new Date(ctx.now().getTime() - PENDING_TTL_MS));

export function hasLiveTicket(ctx: Ctx, activityId: number, userId: number): boolean {
  return Boolean(
    ctx.db.get(
      `SELECT 1 FROM tickets WHERE activity_id = ? AND user_id = ? AND (status = 'active' OR (status = 'pending' AND created_at > ?))`,
      activityId, userId, pendingCutoff(ctx),
    ),
  );
}

/** The rules every guest has to pass, whether joining alone or with a group. */
export function assertActivityOpen(ctx: Ctx, a: ActivityRow): void {
  if (a.status !== 'active') throw new HttpError(409, 'This activity was cancelled.', 'cancelled');
  if (a.ends_at <= nowIso(ctx)) throw new HttpError(409, 'This activity is already over.', 'ended');
}

export function assertCanJoin(ctx: Ctx, a: ActivityRow, user: UserRow): void {
  assertActivityOpen(ctx, a);
  if (a.host_id === user.id) throw new HttpError(409, "You're hosting this one.", 'is_host');
  if (a.security === 'verified' && !user.id_verified_at) {
    throw new HttpError(403, 'This host only lets in guests with a verified ID. Verify yours to join.', 'id_required');
  }
  if (hasLiveTicket(ctx, a.id, user.id)) throw new HttpError(409, 'You already have a spot.', 'already_joined');
}

export function insertTicket(ctx: Ctx, a: ActivityRow, userId: number, status: 'pending' | 'active', groupId: number | null, paymentId: number | null): number {
  // A crashed checkout may have left an expired placeholder behind; clear it so the unique index doesn't block a retry.
  ctx.db.run(`DELETE FROM tickets WHERE activity_id = ? AND user_id = ? AND status = 'pending' AND created_at <= ?`, a.id, userId, pendingCutoff(ctx));
  return ctx.db.run(
    `INSERT INTO tickets (activity_id, user_id, group_id, payment_id, code, price_cents, fee_cents, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, userId, groupId, paymentId, randomCode(8), a.price_cents, commissionCents(a.price_cents, ctx.config.commissionBps), status, nowIso(ctx),
  ).lastId;
}

/** Book the sale: the host earns the price minus the platform's cut, the platform earns the cut. */
function recordSale(ctx: Ctx, a: ActivityRow, ticketId: number): void {
  if (a.price_cents === 0) return;
  const fee = commissionCents(a.price_cents, ctx.config.commissionBps);
  addLedger(ctx, { userId: a.host_id, kind: 'earning', amountCents: a.price_cents - fee, affectsBalance: true, activityId: a.id, ticketId, memo: `Ticket sold · ${a.title}` });
  addLedger(ctx, { userId: null, kind: 'commission', amountCents: fee, activityId: a.id, ticketId, memo: `Commission · ${a.title}` });
}

/** Create a confirmed ticket. Callers must already have checked the rules and taken the money. Call inside a transaction. */
export function issueTicket(ctx: Ctx, a: ActivityRow, userId: number, groupId: number | null, paymentId: number | null): number {
  const id = insertTicket(ctx, a, userId, 'active', groupId, paymentId);
  recordSale(ctx, a, id);
  return id;
}

/** Join an activity on your own: hold a spot, take the payment, confirm the ticket. */
export async function joinSolo(ctx: Ctx, user: UserRow, activityId: number, method: string): Promise<number> {
  const { a, ticketId } = ctx.db.tx(() => {
    const a = getActivityView(ctx, activityId, user.id);
    assertCanJoin(ctx, a, user);
    const inGroup = ctx.db.get(
      `SELECT 1 FROM group_members gm JOIN groups g ON g.id = gm.group_id
       WHERE gm.user_id = ? AND g.activity_id = ? AND g.status IN ('open', 'holding')`,
      user.id, a.id,
    );
    if (inGroup) throw new HttpError(409, "You're in a group for this activity. Get in together, or leave the group to join on your own.", 'in_group');
    if (a.capacity - a.taken < 1) throw new HttpError(409, 'This activity is full.', 'full');
    // Free activities are confirmed straight away; paid ones hold the spot while the payment goes through.
    const ticketId = insertTicket(ctx, a, user.id, a.price_cents === 0 ? 'active' : 'pending', null, null);
    return { a, ticketId };
  });
  if (a.price_cents === 0) return ticketId;

  const release = () => ctx.db.run(`DELETE FROM tickets WHERE id = ? AND status = 'pending'`, ticketId);
  const charge = await ctx.payments.authorize({ amountCents: a.price_cents, currency: ctx.config.currency, method, description: `OTS: ${a.title}` });
  if (!charge.ok) {
    release();
    throw new HttpError(402, charge.message, 'payment_declined');
  }
  try {
    await ctx.payments.capture(charge.ref);
  } catch (err) {
    release();
    throw err;
  }

  ctx.db.tx(() => {
    const paymentId = ctx.db.run(
      `INSERT INTO payments (user_id, purpose, amount_cents, status, provider, provider_ref, activity_id, created_at)
       VALUES (?, 'ticket', ?, 'captured', ?, ?, ?, ?)`,
      user.id, a.price_cents, ctx.payments.name, charge.ref, a.id, nowIso(ctx),
    ).lastId;
    ctx.db.run(`UPDATE tickets SET status = 'active', payment_id = ? WHERE id = ?`, paymentId, ticketId);
    addLedger(ctx, { userId: user.id, kind: 'ticket', amountCents: -a.price_cents, activityId: a.id, ticketId, memo: `Ticket · ${a.title}` });
    recordSale(ctx, a, ticketId);
  });
  return ticketId;
}

/**
 * Cancel one confirmed ticket and send the money back to whoever paid for it.
 * The ticket is flipped first so two simultaneous requests can't both refund it.
 */
export async function refundTicket(ctx: Ctx, t: TicketRow, a: ActivityRow): Promise<void> {
  const claimed = ctx.db.run(`UPDATE tickets SET status = 'cancelled', cancelled_at = ? WHERE id = ? AND status = 'active'`, nowIso(ctx), t.id).changes === 1;
  if (!claimed || t.price_cents === 0 || t.payment_id === null) return;

  const payment = ctx.db.get<PaymentRow>('SELECT id, user_id, amount_cents, provider_ref FROM payments WHERE id = ?', t.payment_id)!;
  try {
    await ctx.payments.refund(payment.provider_ref, t.price_cents);
  } catch (err) {
    console.error(`Refund failed for ticket ${t.id}`, err);
    try {
      ctx.db.run(`UPDATE tickets SET status = 'active', cancelled_at = NULL WHERE id = ?`, t.id);
    } catch {
      /* the spot was re-booked in the meantime; leave the ticket cancelled */
    }
    throw new HttpError(502, 'The refund could not be processed. Please try again.', 'refund_failed');
  }

  ctx.db.tx(() => {
    ctx.db.run('UPDATE payments SET refunded_cents = refunded_cents + ? WHERE id = ?', t.price_cents, payment.id);
    const host = t.price_cents - t.fee_cents;
    addLedger(ctx, { userId: payment.user_id, kind: 'refund', amountCents: t.price_cents, activityId: a.id, ticketId: t.id, memo: `Refund · ${a.title}` });
    addLedger(ctx, { userId: a.host_id, kind: 'earning_reversal', amountCents: -host, affectsBalance: true, activityId: a.id, ticketId: t.id, memo: `Ticket refunded · ${a.title}` });
    addLedger(ctx, { userId: null, kind: 'commission_reversal', amountCents: -t.fee_cents, activityId: a.id, ticketId: t.id, memo: `Commission returned · ${a.title}` });
  });
}

/** Paid tickets can be handed back for a full refund until the cut-off; free ones until the activity ends. */
export function isRefundable(ctx: Ctx, t: Pick<TicketRow, 'status' | 'price_cents'>, a: Pick<ActivityRow, 'status' | 'starts_at' | 'ends_at'>): boolean {
  if (t.status !== 'active' || a.status !== 'active') return false;
  const now = ctx.now().getTime();
  if (Date.parse(a.ends_at) <= now) return false;
  return t.price_cents === 0 || now < Date.parse(a.starts_at) - ctx.config.refundCutoffMinutes * 60_000;
}

export async function cancelTicket(ctx: Ctx, user: UserRow, ticketId: number): Promise<void> {
  const t = ctx.db.get<TicketRow>('SELECT * FROM tickets WHERE id = ? AND user_id = ?', ticketId, user.id);
  if (!t) throw new HttpError(404, 'That ticket does not exist.', 'not_found');
  if (t.status !== 'active') throw new HttpError(409, 'This ticket is no longer active.', 'not_active');
  const a = getActivityView(ctx, t.activity_id, user.id);
  if (!isRefundable(ctx, t, a)) {
    const hours = ctx.config.refundCutoffMinutes / 60;
    throw new HttpError(409, `Refunds close ${hours} hours before the start, so this ticket can no longer be cancelled.`, 'refund_closed');
  }
  await refundTicket(ctx, t, a);
}

export function toTicketDTO(ctx: Ctx, t: TicketRow, a: ActivityView, viewerId: number): TicketDTO {
  const groupCode = t.group_id ? (ctx.db.get<{ code: string }>('SELECT code FROM groups WHERE id = ?', t.group_id)?.code ?? null) : null;
  return {
    id: t.id,
    code: t.code,
    status: t.status === 'active' ? 'active' : 'cancelled',
    priceCents: t.price_cents,
    checkedInAt: t.checked_in_at,
    createdAt: t.created_at,
    groupCode,
    refundable: isRefundable(ctx, t, a),
    activity: toSummary(a, viewerId),
  };
}

export function listMyTickets(ctx: Ctx, user: UserRow): TicketDTO[] {
  const rows = ctx.db.all<TicketRow>(`SELECT * FROM tickets WHERE user_id = ? AND status IN ('active', 'cancelled') ORDER BY id DESC LIMIT 200`, user.id);
  return rows.map((t) => toTicketDTO(ctx, t, getActivityView(ctx, t.activity_id, user.id), user.id));
}
