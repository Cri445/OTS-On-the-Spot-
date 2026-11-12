import { z } from 'zod';
import { CATEGORY_IDS, TAG_IDS, VIBE_IDS, type CategoryId, type TagId, type VibeId } from '../shared/catalog';
import type { ActivityInput, ActivitySummary, Security } from '../shared/types';
import type { UserRow } from './auth';
import { HttpError, iso, nowIso, type Ctx } from './util';

export interface ActivityRow {
  id: number;
  host_id: number;
  title: string;
  description: string;
  category: string;
  vibe: string;
  tags: string;
  lat: number;
  lng: number;
  public_lat: number;
  public_lng: number;
  address: string;
  hide_exact: number;
  starts_at: string;
  ends_at: string;
  capacity: number;
  price_cents: number;
  security: string;
  featured: number;
  status: string;
  cancelled_at: string | null;
  created_at: string;
}

/** An activity plus the bits every screen needs: its host, how full it is, and whether the viewer is going. */
export interface ActivityView extends ActivityRow {
  host_name: string;
  host_color: string;
  host_verified: string | null;
  taken: number;
  viewer_ticket: number;
}

/** A solo checkout keeps its spot for this long while the payment goes through. */
export const PENDING_TTL_MS = 2 * 60_000;

// Spots taken = tickets + spots a group is holding while its members pay.
const VIEW_SQL = `
SELECT a.*, u.display_name AS host_name, u.avatar_color AS host_color, u.id_verified_at AS host_verified,
  (SELECT COUNT(*) FROM tickets t
     WHERE t.activity_id = a.id AND (t.status = 'active' OR (t.status = 'pending' AND t.created_at > ?)))
  + (SELECT COUNT(*) FROM group_members gm JOIN groups g ON g.id = gm.group_id
     WHERE g.activity_id = a.id AND g.status = 'holding' AND g.hold_expires_at > ?) AS taken,
  EXISTS (SELECT 1 FROM tickets t WHERE t.activity_id = a.id AND t.user_id = ? AND t.status = 'active') AS viewer_ticket
FROM activities a JOIN users u ON u.id = a.host_id`;

function viewParams(ctx: Ctx, viewerId: number | undefined): [string, string, number] {
  const now = ctx.now();
  return [iso(new Date(now.getTime() - PENDING_TTL_MS)), iso(now), viewerId ?? 0];
}

export function getActivityView(ctx: Ctx, id: number, viewerId?: number): ActivityView {
  const row = ctx.db.get<ActivityView>(`${VIEW_SQL} WHERE a.id = ?`, ...viewParams(ctx, viewerId), id);
  if (!row) throw new HttpError(404, 'That activity does not exist.', 'not_found');
  return row;
}

export function toSummary(row: ActivityView, viewerId?: number): ActivitySummary {
  // The exact spot of a hide_exact activity is only for the host and people who are going.
  const exact = !row.hide_exact || row.host_id === viewerId || Boolean(row.viewer_ticket);
  return {
    id: row.id,
    title: row.title,
    category: row.category as CategoryId,
    vibe: row.vibe as VibeId,
    tags: JSON.parse(row.tags) as TagId[],
    lat: exact ? row.lat : row.public_lat,
    lng: exact ? row.lng : row.public_lng,
    approximate: !exact,
    address: exact ? row.address : null,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    spotsLeft: Math.max(0, row.capacity - row.taken),
    priceCents: row.price_cents,
    security: row.security as Security,
    featured: Boolean(row.featured),
    status: row.status as 'active' | 'cancelled',
    host: { id: row.host_id, displayName: row.host_name, avatarColor: row.host_color, verified: Boolean(row.host_verified) },
  };
}

export interface ActivityFilters {
  categories?: string[];
  vibes?: string[];
  tags?: string[];
  free?: boolean;
  maxPriceCents?: number;
  verifiedOnly?: boolean;
  /** Only activities starting at or after this instant. */
  from?: string;
  /** Only activities starting before this instant. */
  to?: string;
  q?: string;
  minSpots?: number;
  /** minLat, minLng, maxLat, maxLng */
  bbox?: [number, number, number, number];
}

const LIST_SQL = `${VIEW_SQL}
WHERE a.status = 'active' AND a.ends_at > ?
  AND (? IS NULL OR a.price_cents <= ?)
  AND (? IS NULL OR a.security = ?)
  AND (? IS NULL OR a.starts_at >= ?)
  AND (? IS NULL OR a.starts_at < ?)
  AND (? IS NULL OR a.title LIKE ? ESCAPE '\\' OR a.description LIKE ? ESCAPE '\\')
  AND (? IS NULL OR (a.public_lat BETWEEN ? AND ? AND a.public_lng BETWEEN ? AND ?))
ORDER BY a.featured DESC, a.starts_at ASC
LIMIT 500`;

/** Upcoming and in-progress activities, featured ones first, then soonest. */
export function listActivities(ctx: Ctx, viewerId: number | undefined, f: ActivityFilters): ActivitySummary[] {
  const maxPrice = f.free ? 0 : (f.maxPriceCents ?? null);
  const security = f.verifiedOnly ? 'verified' : null;
  const like = f.q ? `%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const [minLat, minLng, maxLat, maxLng] = f.bbox ?? [null, null, null, null];
  const rows = ctx.db.all<ActivityView>(
    LIST_SQL,
    ...viewParams(ctx, viewerId),
    nowIso(ctx),
    maxPrice, maxPrice,
    security, security,
    f.from ?? null, f.from ?? null,
    f.to ?? null, f.to ?? null,
    like, like, like,
    minLat, minLat, maxLat, minLng, maxLng,
  );
  return rows
    .map((r) => toSummary(r, viewerId))
    .filter((a) => !f.categories?.length || f.categories.includes(a.category))
    .filter((a) => !f.vibes?.length || f.vibes.includes(a.vibe))
    .filter((a) => !f.tags?.length || f.tags.every((t) => (a.tags as string[]).includes(t)))
    .filter((a) => !f.minSpots || a.spotsLeft >= f.minSpots);
}

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Pick a valid date and time.');

export function activityInputSchema(ctx: Ctx) {
  const { minPriceCents, maxPriceCents } = ctx.config;
  return z.object({
    title: z.string().trim().min(3, 'Give your activity a title (at least 3 characters).').max(80, 'Keep the title under 80 characters.'),
    description: z.string().trim().max(2000, 'Keep the description under 2000 characters.').default(''),
    category: z.enum(CATEGORY_IDS, 'Pick a category.'),
    vibe: z.enum(VIBE_IDS, 'Pick a vibe: calm, lively or active.'),
    tags: z.array(z.enum(TAG_IDS)).max(8, 'Pick up to 8 tags.').default([]),
    lat: z.number('Drop a pin on the map.').min(-90).max(90),
    lng: z.number('Drop a pin on the map.').min(-180).max(180),
    address: z.string().trim().min(3, 'Add an address or a meeting point.').max(200),
    hideExact: z.boolean().default(false),
    startsAt: isoDate,
    endsAt: isoDate,
    capacity: z.number().int('Spots must be a whole number.').min(1, 'Offer at least 1 spot.').max(500, 'At most 500 spots.'),
    priceCents: z
      .number()
      .int()
      .refine((c) => c === 0 || (c >= minPriceCents && c <= maxPriceCents), {
        message: `Make it free, or charge between ${minPriceCents / 100} and ${maxPriceCents / 100}.`,
      }),
    security: z.enum(['open', 'verified'], 'Choose who can join.'),
  });
}

function checkTimes(ctx: Ctx, startsAt: string, endsAt: string): void {
  const now = ctx.now().getTime();
  const start = Date.parse(startsAt);
  const end = Date.parse(endsAt);
  if (start < now - 15 * 60_000) throw new HttpError(400, 'The start time is in the past.', 'validation');
  if (start > now + 90 * 86_400_000) throw new HttpError(400, 'Activities can be posted up to 90 days ahead.', 'validation');
  if (end <= start) throw new HttpError(400, 'The end has to be after the start.', 'validation');
  if (end - start > 24 * 3_600_000) throw new HttpError(400, 'An activity can last at most 24 hours.', 'validation');
}

/** A point 150–350 m away, so the pin gives the neighbourhood but not the door. */
function fuzz(lat: number, lng: number): { lat: number; lng: number } {
  const metres = 150 + Math.random() * 200;
  const angle = Math.random() * 2 * Math.PI;
  const dLat = (metres * Math.cos(angle)) / 111_320;
  const dLng = (metres * Math.sin(angle)) / (111_320 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return { lat: lat + dLat, lng: lng + dLng };
}

export function addLedger(
  ctx: Ctx,
  e: { userId: number | null; kind: string; amountCents: number; affectsBalance?: boolean; activityId?: number | null; ticketId?: number | null; memo?: string },
): void {
  ctx.db.run(
    'INSERT INTO ledger (user_id, kind, amount_cents, affects_balance, activity_id, ticket_id, memo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    e.userId,
    e.kind,
    e.amountCents,
    e.affectsBalance ? 1 : 0,
    e.activityId ?? null,
    e.ticketId ?? null,
    e.memo ?? '',
    nowIso(ctx),
  );
}

export function insertActivity(ctx: Ctx, hostId: number, input: ActivityInput, featured: boolean): number {
  const pub = input.hideExact ? fuzz(input.lat, input.lng) : { lat: input.lat, lng: input.lng };
  return ctx.db.run(
    `INSERT INTO activities (host_id, title, description, category, vibe, tags, lat, lng, public_lat, public_lng, address, hide_exact,
       starts_at, ends_at, capacity, price_cents, security, featured, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    hostId,
    input.title,
    input.description,
    input.category,
    input.vibe,
    JSON.stringify(input.tags),
    input.lat,
    input.lng,
    pub.lat,
    pub.lng,
    input.address,
    input.hideExact ? 1 : 0,
    iso(new Date(input.startsAt)),
    iso(new Date(input.endsAt)),
    input.capacity,
    input.priceCents,
    input.security,
    featured ? 1 : 0,
    nowIso(ctx),
  ).lastId;
}

/** Put an activity on the map. The host pays the listing fee first; nothing is saved if the payment fails. */
export async function createActivity(ctx: Ctx, host: UserRow, body: unknown): Promise<number> {
  const extra = z.object({ featured: z.boolean().default(false), paymentMethod: z.string().default('') });
  const result = activityInputSchema(ctx).extend(extra.shape).safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0].message, 'validation');
  const { featured, paymentMethod, ...input } = result.data;
  checkTimes(ctx, input.startsAt, input.endsAt);

  const fee = featured ? ctx.config.listingFeeFeaturedCents : ctx.config.listingFeeStandardCents;
  let ref: string | null = null;
  if (fee > 0) {
    const charge = await ctx.payments.authorize({
      amountCents: fee,
      currency: ctx.config.currency,
      method: paymentMethod,
      description: `OTS listing: ${input.title}`,
    });
    if (!charge.ok) throw new HttpError(402, charge.message, 'payment_declined');
    await ctx.payments.capture(charge.ref);
    ref = charge.ref;
  }

  return ctx.db.tx(() => {
    const id = insertActivity(ctx, host.id, input, featured);
    if (ref) {
      ctx.db.run(
        `INSERT INTO payments (user_id, purpose, amount_cents, status, provider, provider_ref, activity_id, created_at)
         VALUES (?, 'listing', ?, 'captured', ?, ?, ?, ?)`,
        host.id, fee, ctx.payments.name, ref, id, nowIso(ctx),
      );
      const memo = `${featured ? 'Featured listing' : 'Listing'} · ${input.title}`;
      addLedger(ctx, { userId: host.id, kind: 'listing_fee', amountCents: -fee, activityId: id, memo });
      addLedger(ctx, { userId: null, kind: 'listing_fee', amountCents: fee, activityId: id, memo });
    }
    return id;
  });
}

/** Fields that can't change once someone has a spot — they agreed to this time, place and price. */
const LOCKED_ONCE_JOINED = ['startsAt', 'endsAt', 'lat', 'lng', 'address', 'hideExact', 'priceCents', 'security'] as const;

export function updateActivity(ctx: Ctx, host: UserRow, id: number, body: unknown): void {
  const row = getActivityView(ctx, id, host.id);
  if (row.host_id !== host.id) throw new HttpError(403, 'Only the host can edit this activity.', 'forbidden');
  if (row.status !== 'active') throw new HttpError(409, 'This activity was cancelled.', 'cancelled');
  if (row.ends_at <= nowIso(ctx)) throw new HttpError(409, 'This activity is already over.', 'ended');

  const current: ActivityInput = {
    title: row.title,
    description: row.description,
    category: row.category as CategoryId,
    vibe: row.vibe as VibeId,
    tags: JSON.parse(row.tags) as TagId[],
    lat: row.lat,
    lng: row.lng,
    address: row.address,
    hideExact: Boolean(row.hide_exact),
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    capacity: row.capacity,
    priceCents: row.price_cents,
    security: row.security as Security,
  };
  const patch = activityInputSchema(ctx).partial().safeParse(body);
  if (!patch.success) throw new HttpError(400, patch.error.issues[0].message, 'validation');
  const defined = Object.fromEntries(Object.entries(patch.data).filter(([, v]) => v !== undefined));
  const next: ActivityInput = { ...current, ...defined };
  next.startsAt = iso(new Date(next.startsAt));
  next.endsAt = iso(new Date(next.endsAt));

  const changed = (k: keyof ActivityInput) => JSON.stringify(next[k]) !== JSON.stringify(current[k]);
  if (row.taken > 0 && LOCKED_ONCE_JOINED.some(changed)) {
    throw new HttpError(409, 'People have already joined, so the time, place, price and guest rules are locked.', 'locked');
  }
  if (next.capacity < row.taken) {
    throw new HttpError(409, `${row.taken} spots are already taken — you can't go below that.`, 'capacity');
  }
  if (changed('startsAt') || changed('endsAt')) checkTimes(ctx, next.startsAt, next.endsAt);

  const moved = changed('lat') || changed('lng') || changed('hideExact');
  const pub = !moved ? { lat: row.public_lat, lng: row.public_lng } : next.hideExact ? fuzz(next.lat, next.lng) : { lat: next.lat, lng: next.lng };
  ctx.db.run(
    `UPDATE activities SET title = ?, description = ?, category = ?, vibe = ?, tags = ?, lat = ?, lng = ?, public_lat = ?, public_lng = ?,
       address = ?, hide_exact = ?, starts_at = ?, ends_at = ?, capacity = ?, price_cents = ?, security = ? WHERE id = ?`,
    next.title, next.description, next.category, next.vibe, JSON.stringify(next.tags), next.lat, next.lng, pub.lat, pub.lng,
    next.address, next.hideExact ? 1 : 0, next.startsAt, next.endsAt, next.capacity, next.priceCents, next.security, id,
  );
}
