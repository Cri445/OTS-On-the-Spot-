import { Router, type Request } from 'express';
import { z } from 'zod';
import { CATEGORY_IDS, TAG_IDS, VIBE_IDS } from '../shared/catalog';
import { createActivity, listActivities, updateActivity, type ActivityFilters } from './activities';
import { endSession, hashPassword, isAdmin, pickAvatarColor, requireUser, startSession, toMe, verifyPassword, type UserRow } from './auth';
import { cancelTicket, joinSolo, listMyTickets } from './booking';
import { publicConfig } from './config';
import { addSampleGuests, populateAround } from './demo';
import { createGroup, getGroup, joinGroup, leaveGroup, listMyGroups, lockGroup, payShare, releaseGroupHold, removeMember } from './groups';
import { cancelActivity, checkInByCode, getActivityDetail, getAdminStats, getWallet, listAttendees, listHosting, requestPayout, setCheckedIn } from './hosting';
import { HttpError, intParam, nowIso, parse, type Ctx } from './util';

const registerSchema = z.object({
  email: z.email('Enter a valid e-mail address.').max(200),
  password: z.string().min(8, 'Use a password with at least 8 characters.').max(200),
  displayName: z.string().trim().min(2, 'Tell us what to call you (at least 2 characters).').max(40),
  adult: z.literal(true, "OTS is for adults. Confirm you're 18 or older."),
});

const loginSchema = z.object({ email: z.string().max(200), password: z.string().max(200) });

const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'Your name needs at least 2 characters.').max(40).optional(),
  bio: z.string().trim().max(280, 'Keep your bio under 280 characters.').optional(),
});

const verifySchema = z.object({
  legalName: z.string().trim().min(3, 'Enter your full legal name, as on your ID.').max(100),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.'),
});

const payBody = z.object({ paymentMethod: z.string().default('') });

const csv = (v: unknown, allowed: readonly string[]): string[] | undefined => {
  if (typeof v !== 'string' || !v) return undefined;
  return v.split(',').filter((x) => allowed.includes(x));
};

function filtersFrom(req: Request): ActivityFilters {
  const q = req.query;
  const num = (v: unknown) => (typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const date = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined);
  const bbox = typeof q.bbox === 'string' ? q.bbox.split(',').map(Number) : [];
  return {
    categories: csv(q.category, CATEGORY_IDS),
    vibes: csv(q.vibe, VIBE_IDS),
    tags: csv(q.tags, TAG_IDS),
    free: q.free === '1',
    maxPriceCents: num(q.maxPrice),
    verifiedOnly: q.security === 'verified',
    from: date(q.from),
    to: date(q.to),
    q: typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 80) : undefined,
    minSpots: num(q.minSpots),
    bbox: bbox.length === 4 && bbox.every(Number.isFinite) ? (bbox as [number, number, number, number]) : undefined,
  };
}

export function buildRouter(ctx: Ctx): Router {
  const r = Router();
  const { db } = ctx;

  r.get('/config', (_req, res) => {
    res.json(publicConfig(ctx.config, ctx.payments.methods()));
  });

  // ---- Accounts ----------------------------------------------------------

  r.post('/auth/register', async (req, res) => {
    const input = parse(registerSchema, req.body);
    if (db.get('SELECT 1 FROM users WHERE email = ?', input.email)) {
      throw new HttpError(409, 'There is already an account with that e-mail. Try logging in.', 'email_taken');
    }
    const hash = await hashPassword(input.password);
    const count = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
    const id = db.run(
      'INSERT INTO users (email, password_hash, display_name, avatar_color, created_at) VALUES (?, ?, ?, ?, ?)',
      input.email.toLowerCase(), hash, input.displayName, pickAvatarColor(count), nowIso(ctx),
    ).lastId;
    startSession(ctx, req, res, id);
    res.status(201).json({ user: toMe(ctx, db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!) });
  });

  r.post('/auth/login', async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email.trim());
    // Hash even when the account doesn't exist so the response time doesn't reveal which e-mails are registered.
    const ok = await verifyPassword(input.password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AA==');
    if (!user || !ok) throw new HttpError(401, 'Wrong e-mail or password.', 'bad_credentials');
    startSession(ctx, req, res, user.id);
    res.json({ user: toMe(ctx, user) });
  });

  r.post('/auth/logout', (req, res) => {
    endSession(ctx, req, res);
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: req.user ? toMe(ctx, req.user) : null });
  });

  r.patch('/me', (req, res) => {
    const user = requireUser(req);
    const input = parse(profileSchema, req.body);
    db.run('UPDATE users SET display_name = ?, bio = ? WHERE id = ?', input.displayName ?? user.display_name, input.bio ?? user.bio, user.id);
    res.json({ user: toMe(ctx, db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!) });
  });

  r.post('/me/verify-id', async (req, res) => {
    const user = requireUser(req);
    const input = parse(verifySchema, req.body);
    const result = await ctx.identity.verify(input, ctx.now());
    if (!result.ok) throw new HttpError(422, result.message, 'id_rejected');
    db.run('UPDATE users SET legal_name = ?, birth_date = ?, id_verified_at = ? WHERE id = ?', input.legalName, input.birthDate, nowIso(ctx), user.id);
    res.json({ user: toMe(ctx, db.get<UserRow>('SELECT * FROM users WHERE id = ?', user.id)!) });
  });

  // ---- Activities --------------------------------------------------------

  r.get('/activities', (req, res) => {
    res.json({ activities: listActivities(ctx, req.user?.id, filtersFrom(req)) });
  });

  r.post('/activities', async (req, res) => {
    const id = await createActivity(ctx, requireUser(req), req.body);
    res.status(201).json({ id });
  });

  r.get('/activities/:id', (req, res) => {
    res.json({ activity: getActivityDetail(ctx, intParam(req.params.id), req.user) });
  });

  r.patch('/activities/:id', (req, res) => {
    const user = requireUser(req);
    const id = intParam(req.params.id);
    updateActivity(ctx, user, id, req.body);
    res.json({ activity: getActivityDetail(ctx, id, user) });
  });

  r.post('/activities/:id/cancel', async (req, res) => {
    await cancelActivity(ctx, requireUser(req), intParam(req.params.id));
    res.json({ ok: true });
  });

  r.post('/activities/:id/join', async (req, res) => {
    const user = requireUser(req);
    const id = intParam(req.params.id);
    await joinSolo(ctx, user, id, parse(payBody, req.body ?? {}).paymentMethod);
    res.status(201).json({ activity: getActivityDetail(ctx, id, user) });
  });

  r.post('/activities/:id/groups', (req, res) => {
    res.status(201).json({ code: createGroup(ctx, requireUser(req), intParam(req.params.id)) });
  });

  // ---- Hosting -----------------------------------------------------------

  r.get('/hosting', (req, res) => {
    res.json({ activities: listHosting(ctx, requireUser(req)) });
  });

  r.get('/activities/:id/attendees', (req, res) => {
    res.json({ attendees: listAttendees(ctx, requireUser(req), intParam(req.params.id)) });
  });

  r.post('/activities/:id/attendees/:ticketId/checkin', (req, res) => {
    const body = parse(z.object({ checkedIn: z.boolean() }), req.body);
    setCheckedIn(ctx, requireUser(req), intParam(req.params.id), intParam(req.params.ticketId, 'ticket'), body.checkedIn);
    res.json({ ok: true });
  });

  r.post('/checkin', (req, res) => {
    const body = parse(z.object({ code: z.string().min(4, 'Enter the code on the ticket.').max(40) }), req.body);
    res.json(checkInByCode(ctx, requireUser(req), body.code));
  });

  // ---- Tickets -----------------------------------------------------------

  r.get('/tickets', (req, res) => {
    const user = requireUser(req);
    res.json({ tickets: listMyTickets(ctx, user), groups: listMyGroups(ctx, user) });
  });

  r.post('/tickets/:id/cancel', async (req, res) => {
    await cancelTicket(ctx, requireUser(req), intParam(req.params.id, 'ticket'));
    res.json({ ok: true });
  });

  // ---- Groups ------------------------------------------------------------

  r.get('/groups/:code', async (req, res) => {
    res.json({ group: await getGroup(ctx, requireUser(req), req.params.code) });
  });

  r.post('/groups/:code/join', async (req, res) => {
    const user = requireUser(req);
    await joinGroup(ctx, user, req.params.code);
    res.json({ group: await getGroup(ctx, user, req.params.code) });
  });

  r.post('/groups/:code/leave', async (req, res) => {
    await leaveGroup(ctx, requireUser(req), req.params.code);
    res.json({ ok: true });
  });

  r.post('/groups/:code/remove', async (req, res) => {
    const user = requireUser(req);
    const body = parse(z.object({ userId: z.number().int() }), req.body);
    removeMember(ctx, user, req.params.code, body.userId);
    res.json({ group: await getGroup(ctx, user, req.params.code) });
  });

  r.post('/groups/:code/lock', async (req, res) => {
    const user = requireUser(req);
    const body = parse(z.object({ payMode: z.enum(['split', 'leader']).optional(), paymentMethod: z.string().default('') }), req.body ?? {});
    await lockGroup(ctx, user, req.params.code, body.payMode, body.paymentMethod);
    res.json({ group: await getGroup(ctx, user, req.params.code) });
  });

  r.post('/groups/:code/pay', async (req, res) => {
    const user = requireUser(req);
    await payShare(ctx, user, req.params.code, parse(payBody, req.body ?? {}).paymentMethod);
    res.json({ group: await getGroup(ctx, user, req.params.code) });
  });

  r.post('/groups/:code/release', async (req, res) => {
    const user = requireUser(req);
    await releaseGroupHold(ctx, user, req.params.code);
    res.json({ group: await getGroup(ctx, user, req.params.code) });
  });

  // ---- Money -------------------------------------------------------------

  r.get('/wallet', (req, res) => {
    res.json({ wallet: getWallet(ctx, requireUser(req)) });
  });

  r.post('/wallet/payout', (req, res) => {
    const user = requireUser(req);
    const amountCents = requestPayout(ctx, user);
    res.json({ amountCents, wallet: getWallet(ctx, user) });
  });

  r.get('/admin/stats', (req, res) => {
    const user = requireUser(req);
    if (!isAdmin(ctx, user)) throw new HttpError(403, 'Admins only.', 'forbidden');
    res.json({ stats: getAdminStats(ctx) });
  });

  // ---- Demo helpers (only when DEMO_MODE is on) --------------------------

  r.post('/demo/populate', (req, res) => {
    requireUser(req);
    const body = parse(
      z.object({ lat: z.number().min(-85).max(85), lng: z.number().min(-180).max(180), tzOffsetMinutes: z.number().int().min(-900).max(900).default(0) }),
      req.body,
    );
    res.status(201).json({ created: populateAround(ctx, body.lat, body.lng, body.tzOffsetMinutes) });
  });

  r.post('/demo/activities/:id/guests', (req, res) => {
    res.status(201).json({ added: addSampleGuests(ctx, requireUser(req), intParam(req.params.id)) });
  });

  return r;
}
