import type { GroupDTO, GroupListItem, GroupStatus, PayMode } from '../shared/types';
import { toPublicUser, type UserRow } from './auth';
import { addLedger, getActivityView, toSummary, type ActivityView } from './activities';
import { assertActivityOpen, hasLiveTicket, isTooYoung, issueTicket } from './booking';
import { HttpError, iso, nowIso, randomCode, type Ctx } from './util';

/*
 * "Party up": friends gather in a group, then get in together or not at all.
 *
 *   open ──lock──▶ holding ──everyone paid──▶ confirmed
 *     ▲               │
 *     └──hold expired / released (payments voided)
 *
 * While a group is `holding`, its spots are reserved so nobody else can take
 * them. Tickets are only issued once every member is covered, in a single
 * database transaction — so it is never possible for half a group to get in.
 */

export interface GroupRow {
  id: number;
  activity_id: number;
  leader_id: number;
  code: string;
  status: GroupStatus;
  pay_mode: PayMode | null;
  hold_expires_at: string | null;
  created_at: string;
}

type MemberRow = UserRow & { payment_id: number | null };

/** When the leader pays for everyone the hold only needs to outlast one card payment. */
const LEADER_HOLD_MS = 2 * 60_000;

function loadGroup(ctx: Ctx, code: string): GroupRow {
  const g = ctx.db.get<GroupRow>('SELECT * FROM groups WHERE code = ?', code.toUpperCase());
  if (!g) throw new HttpError(404, 'That group link is not valid.', 'not_found');
  return g;
}

function membersOf(ctx: Ctx, groupId: number): MemberRow[] {
  return ctx.db.all<MemberRow>(
    `SELECT u.*, gm.payment_id FROM group_members gm JOIN users u ON u.id = gm.user_id WHERE gm.group_id = ? ORDER BY gm.joined_at, u.id`,
    groupId,
  );
}

function memberIssues(ctx: Ctx, a: ActivityView, m: MemberRow): string[] {
  const issues: string[] = [];
  if (a.security === 'verified' && !m.id_verified_at) issues.push('Needs to verify ID');
  else if (isTooYoung(a, m)) issues.push(`Under ${a.min_age}`);
  if (hasLiveTicket(ctx, a.id, m.id)) issues.push('Already has a ticket');
  if (a.host_id === m.id) issues.push('Is the host');
  return issues;
}

/** Why the group can't be locked in yet, in plain words. Empty when it's good to go. */
function blockersFor(ctx: Ctx, a: ActivityView, members: MemberRow[]): string[] {
  const out: string[] = [];
  if (a.status !== 'active') return ['This activity was cancelled.'];
  if (a.ends_at <= nowIso(ctx)) return ['This activity is already over.'];
  if (members.length < 2) out.push('Invite at least one friend to party up.');
  for (const m of members) {
    for (const issue of memberIssues(ctx, a, m)) out.push(`${m.display_name}: ${issue.toLowerCase()}.`);
  }
  const left = a.capacity - a.taken;
  if (left < members.length) {
    out.push(left <= 0 ? 'This activity is full.' : `Only ${left} ${left === 1 ? 'spot' : 'spots'} left for your group of ${members.length}.`);
  }
  return out;
}

/** Give held spots back and release any shares already authorized. Safe to call twice. */
async function releaseHold(ctx: Ctx, groupId: number): Promise<void> {
  const refs = ctx.db.tx(() => {
    const g = ctx.db.get<GroupRow>('SELECT * FROM groups WHERE id = ?', groupId);
    if (!g || g.status !== 'holding') return [];
    const pays = ctx.db.all<{ provider_ref: string }>(`SELECT provider_ref FROM payments WHERE group_id = ? AND status = 'authorized'`, groupId);
    ctx.db.run(`UPDATE payments SET status = 'voided' WHERE group_id = ? AND status = 'authorized'`, groupId);
    ctx.db.run('UPDATE group_members SET payment_id = NULL WHERE group_id = ?', groupId);
    ctx.db.run(`UPDATE groups SET status = 'open', pay_mode = NULL, hold_expires_at = NULL WHERE id = ?`, groupId);
    return pays.map((p) => p.provider_ref);
  });
  for (const ref of refs) {
    try {
      await ctx.payments.void(ref);
    } catch (err) {
      console.error(`Could not void payment ${ref}`, err);
    }
  }
}

/** Release every hold whose time has run out (or just one group's). */
export async function settleExpiredHolds(ctx: Ctx, groupId?: number): Promise<void> {
  const rows = ctx.db.all<{ id: number }>(`SELECT id FROM groups WHERE status = 'holding' AND hold_expires_at <= ?`, nowIso(ctx));
  for (const row of rows) {
    if (groupId === undefined || row.id === groupId) await releaseHold(ctx, row.id);
  }
}

export async function getGroup(ctx: Ctx, viewer: UserRow, code: string): Promise<GroupDTO> {
  let g = loadGroup(ctx, code);
  await settleExpiredHolds(ctx, g.id);
  g = loadGroup(ctx, code);
  const a = getActivityView(ctx, g.activity_id, viewer.id);
  const members = membersOf(ctx, g.id);
  const me = members.find((m) => m.id === viewer.id);
  return {
    code: g.code,
    status: g.status,
    payMode: g.pay_mode,
    holdExpiresAt: g.hold_expires_at,
    activity: toSummary(a, viewer.id),
    members: members.map((m) => ({
      user: toPublicUser(m),
      isLeader: m.id === g.leader_id,
      paid: m.payment_id !== null || g.status === 'confirmed',
      issues: g.status === 'open' ? memberIssues(ctx, a, m) : [],
    })),
    blockers: g.status === 'open' ? blockersFor(ctx, a, members) : [],
    shareCents: a.price_cents,
    totalCents: a.price_cents * members.length,
    viewer: { isMember: Boolean(me), isLeader: g.leader_id === viewer.id, paid: Boolean(me?.payment_id) || (Boolean(me) && g.status === 'confirmed') },
  };
}

function activeGroupOf(ctx: Ctx, userId: number, activityId: number): GroupRow | undefined {
  return ctx.db.get<GroupRow>(
    `SELECT g.* FROM groups g JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ? AND g.activity_id = ? AND g.status IN ('open', 'holding')`,
    userId, activityId,
  );
}

function assertCanBeInGroup(ctx: Ctx, a: ActivityView, user: UserRow): void {
  assertActivityOpen(ctx, a);
  if (a.host_id === user.id) throw new HttpError(409, "You're hosting this one.", 'is_host');
  if (hasLiveTicket(ctx, a.id, user.id)) throw new HttpError(409, 'You already have a spot.', 'already_joined');
}

/** Start a group for an activity. If the person already has one going, that one is returned. */
export function createGroup(ctx: Ctx, user: UserRow, activityId: number): string {
  return ctx.db.tx(() => {
    const a = getActivityView(ctx, activityId, user.id);
    const existing = activeGroupOf(ctx, user.id, a.id);
    if (existing) return existing.code;
    assertCanBeInGroup(ctx, a, user);
    const code = randomCode(6);
    const id = ctx.db.run('INSERT INTO groups (activity_id, leader_id, code, created_at) VALUES (?, ?, ?, ?)', a.id, user.id, code, nowIso(ctx)).lastId;
    ctx.db.run('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', id, user.id, nowIso(ctx));
    return code;
  });
}

export async function joinGroup(ctx: Ctx, user: UserRow, code: string): Promise<void> {
  await settleExpiredHolds(ctx, loadGroup(ctx, code).id);
  ctx.db.tx(() => {
    const g = loadGroup(ctx, code);
    const members = membersOf(ctx, g.id);
    if (members.some((m) => m.id === user.id)) return;
    if (g.status === 'holding') throw new HttpError(409, 'This group is locking in its spots right now. Ask the leader to release the hold so you can join.', 'holding');
    if (g.status !== 'open') throw new HttpError(409, 'This group is no longer open.', 'closed');
    const a = getActivityView(ctx, g.activity_id, user.id);
    assertCanBeInGroup(ctx, a, user);
    if (activeGroupOf(ctx, user.id, a.id)) throw new HttpError(409, "You're already in another group for this activity. Leave it first.", 'in_group');
    if (members.length >= ctx.config.maxGroupSize) throw new HttpError(409, `Groups can have up to ${ctx.config.maxGroupSize} people.`, 'group_full');
    ctx.db.run('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)', g.id, user.id, nowIso(ctx));
  });
}

/** A member steps out. If the leader steps out, the group is dissolved. */
export async function leaveGroup(ctx: Ctx, user: UserRow, code: string): Promise<void> {
  const g = loadGroup(ctx, code);
  if (g.status === 'confirmed' || g.status === 'cancelled') throw new HttpError(409, 'This group is already closed.', 'closed');
  if (g.leader_id === user.id) {
    await releaseHold(ctx, g.id);
    ctx.db.run(`UPDATE groups SET status = 'cancelled' WHERE id = ? AND status = 'open'`, g.id);
    return;
  }
  if (g.status === 'holding') throw new HttpError(409, 'Spots are being held for the group. Ask the leader to release the hold first.', 'holding');
  ctx.db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g.id, user.id);
}

export function removeMember(ctx: Ctx, leader: UserRow, code: string, userId: number): void {
  const g = loadGroup(ctx, code);
  if (g.leader_id !== leader.id) throw new HttpError(403, 'Only the group leader can do that.', 'forbidden');
  if (g.status !== 'open') throw new HttpError(409, 'Release the hold before changing the group.', 'holding');
  if (userId === leader.id) throw new HttpError(400, 'Leave the group instead to dissolve it.', 'validation');
  ctx.db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', g.id, userId);
}

export async function releaseGroupHold(ctx: Ctx, leader: UserRow, code: string): Promise<void> {
  const g = loadGroup(ctx, code);
  if (g.leader_id !== leader.id) throw new HttpError(403, 'Only the group leader can do that.', 'forbidden');
  await releaseHold(ctx, g.id);
}

/** Issue a ticket to every member and close the group. Call inside a transaction. */
function confirmGroup(ctx: Ctx, g: GroupRow, a: ActivityView, members: MemberRow[], paymentFor: (m: MemberRow) => number | null): void {
  for (const m of members) issueTicket(ctx, a, m.id, g.id, paymentFor(m));
  ctx.db.run(`UPDATE groups SET status = 'confirmed', hold_expires_at = NULL WHERE id = ?`, g.id);
}

/**
 * The leader locks the group in. Either everything below succeeds for the
 * whole group, or nobody gets a spot:
 *  - free activity      → everyone is confirmed straight away
 *  - leader pays        → one payment for the lot, then everyone is confirmed
 *  - everyone pays own  → spots are held while each member pays their share
 */
export async function lockGroup(ctx: Ctx, leader: UserRow, code: string, payMode: PayMode | undefined, method: string): Promise<void> {
  await settleExpiredHolds(ctx, loadGroup(ctx, code).id);

  const step = ctx.db.tx(() => {
    const g = loadGroup(ctx, code);
    if (g.leader_id !== leader.id) throw new HttpError(403, 'Only the group leader can lock in the spots.', 'forbidden');
    if (g.status !== 'open') throw new HttpError(409, g.status === 'holding' ? 'Your spots are already being held.' : 'This group is already closed.', 'closed');
    const a = getActivityView(ctx, g.activity_id, leader.id);
    const members = membersOf(ctx, g.id);
    const blockers = blockersFor(ctx, a, members);
    if (blockers.length) throw new HttpError(409, blockers[0], 'not_ready');

    if (a.price_cents === 0) {
      confirmGroup(ctx, g, a, members, () => null);
      return { done: true as const };
    }
    if (payMode !== 'split' && payMode !== 'leader') throw new HttpError(400, 'Choose how the group pays.', 'validation');
    const holdMs = payMode === 'leader' ? LEADER_HOLD_MS : ctx.config.groupHoldMinutes * 60_000;
    ctx.db.run(`UPDATE groups SET status = 'holding', pay_mode = ?, hold_expires_at = ? WHERE id = ?`, payMode, iso(new Date(ctx.now().getTime() + holdMs)), g.id);
    return { done: false as const, g, a, members };
  });
  if (step.done || payMode !== 'leader') return;

  // Leader covers everyone: one charge for the whole group while the spots are held.
  const { g, a, members } = step;
  const total = a.price_cents * members.length;
  const charge = await ctx.payments.authorize({ amountCents: total, currency: ctx.config.currency, method, description: `OTS: ${members.length} × ${a.title}` });
  if (!charge.ok) {
    await releaseHold(ctx, g.id);
    throw new HttpError(402, charge.message, 'payment_declined');
  }
  try {
    await ctx.payments.capture(charge.ref);
  } catch (err) {
    await releaseHold(ctx, g.id);
    throw err;
  }

  const confirmed = ctx.db.tx(() => {
    const fresh = ctx.db.get<GroupRow>('SELECT * FROM groups WHERE id = ?', g.id)!;
    if (fresh.status !== 'holding') return false;
    const paymentId = ctx.db.run(
      `INSERT INTO payments (user_id, purpose, amount_cents, status, provider, provider_ref, activity_id, group_id, created_at)
       VALUES (?, 'group_total', ?, 'captured', ?, ?, ?, ?, ?)`,
      leader.id, total, ctx.payments.name, charge.ref, a.id, g.id, nowIso(ctx),
    ).lastId;
    ctx.db.run('UPDATE group_members SET payment_id = ? WHERE group_id = ?', paymentId, g.id);
    addLedger(ctx, { userId: leader.id, kind: 'ticket', amountCents: -total, activityId: a.id, memo: `${members.length} tickets · ${a.title}` });
    confirmGroup(ctx, fresh, a, membersOf(ctx, g.id), () => paymentId);
    return true;
  });
  if (!confirmed) {
    // The hold lapsed while the card was being charged. Nobody gets in, so nobody pays.
    await ctx.payments.refund(charge.ref, total);
    throw new HttpError(409, 'The hold ran out before the payment finished. You have not been charged — try again.', 'hold_expired');
  }
}

/** A member pays their own share while the group's spots are held. The last share to arrive confirms everyone. */
export async function payShare(ctx: Ctx, user: UserRow, code: string, method: string): Promise<void> {
  await settleExpiredHolds(ctx, loadGroup(ctx, code).id);

  const { g, a } = ctx.db.tx(() => {
    const g = loadGroup(ctx, code);
    if (g.status !== 'holding' || g.pay_mode !== 'split') throw new HttpError(409, 'There is nothing to pay right now.', 'not_holding');
    const me = membersOf(ctx, g.id).find((m) => m.id === user.id);
    if (!me) throw new HttpError(403, "You're not in this group.", 'forbidden');
    if (me.payment_id !== null) throw new HttpError(409, "You've already paid your share.", 'already_paid');
    return { g, a: getActivityView(ctx, g.activity_id, user.id) };
  });

  const charge = await ctx.payments.authorize({ amountCents: a.price_cents, currency: ctx.config.currency, method, description: `OTS: ${a.title}` });
  if (!charge.ok) throw new HttpError(402, charge.message, 'payment_declined');

  const outcome = ctx.db.tx(() => {
    const fresh = ctx.db.get<GroupRow>('SELECT * FROM groups WHERE id = ?', g.id)!;
    if (fresh.status !== 'holding' || (fresh.hold_expires_at ?? '') <= nowIso(ctx)) return { state: 'expired' as const, refs: [] };
    const members = membersOf(ctx, g.id);
    const me = members.find((m) => m.id === user.id);
    if (!me || me.payment_id !== null) return { state: 'duplicate' as const, refs: [] };

    const paymentId = ctx.db.run(
      `INSERT INTO payments (user_id, purpose, amount_cents, status, provider, provider_ref, activity_id, group_id, created_at)
       VALUES (?, 'group_share', ?, 'authorized', ?, ?, ?, ?, ?)`,
      user.id, a.price_cents, ctx.payments.name, charge.ref, a.id, g.id, nowIso(ctx),
    ).lastId;
    ctx.db.run('UPDATE group_members SET payment_id = ? WHERE group_id = ? AND user_id = ?', paymentId, g.id, user.id);
    me.payment_id = paymentId;
    if (members.some((m) => m.payment_id === null)) return { state: 'waiting' as const, refs: [] };

    // Everyone is covered: take all the shares and hand out the tickets in one go.
    const pays = ctx.db.all<{ id: number; user_id: number; provider_ref: string }>(`SELECT id, user_id, provider_ref FROM payments WHERE group_id = ? AND status = 'authorized'`, g.id);
    ctx.db.run(`UPDATE payments SET status = 'captured' WHERE group_id = ? AND status = 'authorized'`, g.id);
    for (const m of members) addLedger(ctx, { userId: m.id, kind: 'ticket', amountCents: -a.price_cents, activityId: a.id, memo: `Ticket · ${a.title}` });
    confirmGroup(ctx, fresh, a, members, (m) => m.payment_id);
    return { state: 'confirmed' as const, refs: pays.map((p) => p.provider_ref) };
  });

  if (outcome.state === 'expired' || outcome.state === 'duplicate') {
    await ctx.payments.void(charge.ref).catch((err) => console.error(`Could not void payment ${charge.ref}`, err));
    if (outcome.state === 'expired') throw new HttpError(409, 'The hold ran out. You have not been charged — ask your leader to lock in again.', 'hold_expired');
    throw new HttpError(409, "You've already paid your share.", 'already_paid');
  }
  // The tickets are issued; now actually take the authorized money. A failure here needs a human to reconcile.
  for (const ref of outcome.refs) {
    await ctx.payments.capture(ref).catch((err) => console.error(`CAPTURE FAILED for ${ref} — reconcile manually`, err));
  }
}

/** Close every group of an activity that is being cancelled. */
export async function closeGroupsOf(ctx: Ctx, activityId: number): Promise<void> {
  const groups = ctx.db.all<{ id: number }>(`SELECT id FROM groups WHERE activity_id = ? AND status IN ('open', 'holding')`, activityId);
  for (const g of groups) {
    await releaseHold(ctx, g.id);
    ctx.db.run(`UPDATE groups SET status = 'cancelled' WHERE id = ?`, g.id);
  }
}

/** Groups the person is still forming, for the "My tickets" screen. */
export function listMyGroups(ctx: Ctx, user: UserRow): GroupListItem[] {
  const rows = ctx.db.all<GroupRow & { size: number }>(
    `SELECT g.*, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS size
     FROM groups g JOIN group_members gm ON gm.group_id = g.id JOIN activities a ON a.id = g.activity_id
     WHERE gm.user_id = ? AND g.status IN ('open', 'holding') AND a.status = 'active' AND a.ends_at > ?
     ORDER BY g.id DESC`,
    user.id, nowIso(ctx),
  );
  return rows.map((g) => ({
    code: g.code,
    status: g.status,
    size: g.size,
    isLeader: g.leader_id === user.id,
    activity: toSummary(getActivityView(ctx, g.activity_id, user.id), user.id),
  }));
}

export function viewerGroup(ctx: Ctx, userId: number, activityId: number): { code: string; status: GroupStatus; size: number } | null {
  const g = activeGroupOf(ctx, userId, activityId);
  if (!g) return null;
  const size = ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?', g.id)!.n;
  return { code: g.code, status: g.status, size };
}
