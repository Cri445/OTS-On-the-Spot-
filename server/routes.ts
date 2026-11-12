import express, { Router, type Request } from 'express';
import { z } from 'zod';
import { CATEGORY_IDS, TAG_IDS, VIBE_IDS } from '../shared/catalog';
import { createActivity, listActivities, updateActivity, type ActivityFilters } from './activities';
import { endSession, hashPassword, isAdmin, loadUser, pickAvatarColor, requireUser, startSession, toMe, verifyPassword, type UserRow } from './auth';
import { cancelTicket, joinSolo, listMyTickets } from './booking';
import { publicConfig } from './config';
import { addSampleGuests, populateAround } from './demo';
import { createGroup, getGroup, joinGroup, leaveGroup, listMyGroups, lockGroup, payShare, releaseGroupHold, removeMember } from './groups';
import { cancelActivity, checkInByCode, getActivityDetail, getAdminStats, getPublicProfile, getWallet, listAttendees, listHosting, requestPayout, setCheckedIn } from './hosting';
import { deleteImage, IMAGE_TYPES, imageUrl, loadImage, saveImage } from './images';
import { beginSetup, completeChallenge, disable, finishSetup, recoveryCodesLeft, startChallenge } from './twofactor';
import { HttpError, intParam, nowIso, parse, type Ctx } from './util';

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

  const registerSchema = z.object({
    email: z.email('Enter a valid e-mail address.').max(200),
    password: z.string().min(8, 'Use a password with at least 8 characters.').max(200),
    displayName: z.string().trim().min(2, 'Tell us what to call you (at least 2 characters).').max(40),
    ageConfirmed: z.literal(true, `You need to be ${ctx.config.minAccountAge} or older to use OTS.`),
  });

  // Uploads arrive as the raw bytes of the image.
  const rawImage = express.raw({ type: IMAGE_TYPES, limit: '4mb' });

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
    res.status(201).json({ user: toMe(ctx, loadUser(ctx, id)) });
  });

  r.post('/auth/login', async (req, res) => {
    const input = parse(loginSchema, req.body);
    const user = db.get<UserRow>('SELECT * FROM users WHERE email = ?', input.email.trim());
    // Hash even when the account doesn't exist so the response time doesn't reveal which e-mails are registered.
    const ok = await verifyPassword(input.password, user?.password_hash ?? 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AA==');
    if (!user || !ok) throw new HttpError(401, 'Wrong e-mail or password.', 'bad_credentials');
    if (user.totp_enabled_at) {
      // Password is right, but this account also wants a code. No session yet.
      res.json({ twoFactor: { ticket: startChallenge(ctx, user.id) } });
      return;
    }
    startSession(ctx, req, res, user.id);
    res.json({ user: toMe(ctx, user) });
  });

  r.post('/auth/login/verify', (req, res) => {
    const input = parse(z.object({ ticket: z.string().min(10).max(200), code: z.string().min(6, 'Enter the 6-digit code.').max(20) }), req.body);
    const user = completeChallenge(ctx, input.ticket, input.code);
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
    res.json({ user: toMe(ctx, loadUser(ctx, user.id)) });
  });

  r.post('/me/avatar', rawImage, (req, res) => {
    const user = requireUser(req);
    const id = saveImage(ctx, user.id, 'avatar', req.body);
    db.run('UPDATE users SET avatar_image = ? WHERE id = ?', id, user.id);
    deleteImage(ctx, user.avatar_image);
    res.status(201).json({ user: toMe(ctx, loadUser(ctx, user.id)) });
  });

  r.delete('/me/avatar', (req, res) => {
    const user = requireUser(req);
    db.run('UPDATE users SET avatar_image = NULL WHERE id = ?', user.id);
    deleteImage(ctx, user.avatar_image);
    res.json({ user: toMe(ctx, loadUser(ctx, user.id)) });
  });

  // ---- Two-step login ----------------------------------------------------

  r.post('/me/2fa/setup', (req, res) => {
    res.json(beginSetup(ctx, requireUser(req)));
  });

  r.post('/me/2fa/enable', (req, res) => {
    const user = requireUser(req);
    const input = parse(z.object({ code: z.string().min(6, 'Enter the 6-digit code.').max(12) }), req.body);
    const recoveryCodes = finishSetup(ctx, user, input.code);
    res.json({ recoveryCodes, user: toMe(ctx, loadUser(ctx, user.id)) });
  });

  r.post('/me/2fa/disable', async (req, res) => {
    const user = requireUser(req);
    const input = parse(z.object({ password: z.string().max(200) }), req.body);
    await disable(ctx, user, input.password);
    res.json({ user: toMe(ctx, loadUser(ctx, user.id)) });
  });

  r.get('/me/2fa', (req, res) => {
    const user = requireUser(req);
    res.json({ enabled: Boolean(user.totp_enabled_at), recoveryCodesLeft: recoveryCodesLeft(ctx, user.id) });
  });

  // ---- Pictures ----------------------------------------------------------

  r.post('/images', rawImage, (req, res) => {
    const id = saveImage(ctx, requireUser(req).id, 'venue', req.body);
    res.status(201).json({ id, url: imageUrl(id) });
  });

  r.get('/images/:id', (req, res) => {
    const image = loadImage(ctx, req.params.id);
    if (!image) throw new HttpError(404, 'Not found', 'not_found');
    // Ids are random and an image never changes, so browsers may keep it for good.
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type(image.mime).send(Buffer.from(image.bytes));
  });

  r.get('/users/:id', (req, res) => {
    res.json({ profile: getPublicProfile(ctx, intParam(req.params.id, 'member'), req.user?.id) });
  });

  r.post('/me/verify-id', async (req, res) => {
    const user = requireUser(req);
    const input = parse(verifySchema, req.body);
    const result = await ctx.identity.verify(input, ctx.now(), ctx.config.minAccountAge);
    if (!result.ok) throw new HttpError(422, result.message, 'id_rejected');
    db.run('UPDATE users SET legal_name = ?, birth_date = ?, id_verified_at = ? WHERE id = ?', input.legalName, input.birthDate, nowIso(ctx), user.id);
    res.json({ user: toMe(ctx, loadUser(ctx, user.id)) });
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
