import type { CategoryId, TagId, VibeId } from '../shared/catalog';
import type { Security } from '../shared/types';
import { hashPassword, pickAvatarColor, type UserRow } from './auth';
import { getActivityView, insertActivity } from './activities';
import { hasLiveTicket, insertTicket, issueTicket } from './booking';
import { HttpError, iso, nowIso, type Ctx } from './util';

/*
 * Sample content for demo mode, so the map isn't empty the first time someone
 * opens the app. Sample hosts and guests are flagged is_demo and cannot log in.
 */

export const DEMO_EMAIL = 'demo@ots.app';
export const DEMO_PASSWORD = 'demo1234';

const HOST_NAMES = ['Maya', 'Jonas', 'Priya', 'Luca', 'Aiko', 'Sam', 'Noor', 'Theo'];
const GUEST_NAMES = [
  'Alex', 'Bea', 'Chris', 'Dani', 'Eli', 'Fran', 'Gus', 'Hana', 'Ivo', 'Jules', 'Kai', 'Lena',
  'Milo', 'Nina', 'Omar', 'Pia', 'Quinn', 'Rosa', 'Seb', 'Tara', 'Uma', 'Vik', 'Wren', 'Yara',
];
const SURNAMES = ['Keller', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Ricci', 'Novak', 'Haddad'];

type When = { inMinutes: number } | { day: number; hour: number; minute?: number };

interface Sample {
  title: string;
  description: string;
  category: CategoryId;
  vibe: VibeId;
  tags: TagId[];
  price: number;
  capacity: number;
  security?: Security;
  minAge?: number;
  hideExact?: boolean;
  featured?: boolean;
  when: When;
  hours: number;
  /** Roughly how full it already is, 0–1. */
  fill: number;
}

const SAMPLES: Sample[] = [
  {
    title: 'Rooftop house party — need 15 more!',
    description: 'Half the guest list bailed, the speakers did not. Rooftop with a view, DJ from 10, bring good energy. Drinks on the roof bar, first one is on me.',
    category: 'party', vibe: 'lively', tags: ['drinks', 'dancing', 'big-crowd'], price: 1200, capacity: 40,
    security: 'verified', minAge: 18, hideExact: true, featured: true, when: { day: 0, hour: 21 }, hours: 5, fill: 0.6,
  },
  {
    title: 'Board games & craft beer',
    description: 'Catan, Codenames and a fridge full of local IPAs. We are mid-game but there is room at the table — walk in, grab a chair.',
    category: 'games', vibe: 'calm', tags: ['indoor', 'drinks', 'small-group'], price: 400, capacity: 6,
    when: { inMinutes: -35 }, hours: 3, fill: 0.5,
  },
  {
    title: 'Doubles tennis — 2 players wanted',
    description: 'Court is booked, two of us are warmed up, two cancelled. Intermediate level, friendly but we do keep score.',
    category: 'sports', vibe: 'active', tags: ['outdoor', 'competitive'], price: 600, capacity: 2,
    when: { inMinutes: 50 }, hours: 1.5, fill: 0,
  },
  {
    title: 'Chill bowling night',
    description: 'Two lanes reserved, shoes included. Nobody here is good at this, which is the whole point.',
    category: 'games', vibe: 'calm', tags: ['indoor', 'beginner-friendly', 'gear-provided'], price: 900, capacity: 8,
    when: { day: 0, hour: 19, minute: 30 }, hours: 2, fill: 0.4,
  },
  {
    title: 'Beach volleyball pickup',
    description: 'Net is up, ball is pumped. Rotating teams of four — jump in whenever a set ends.',
    category: 'sports', vibe: 'active', tags: ['outdoor', 'beginner-friendly'], price: 300, capacity: 12,
    when: { day: 0, hour: 17 }, hours: 2, fill: 0.5,
  },
  {
    title: 'Sunset picnic in the park',
    description: 'Blankets, a speaker and way too much hummus. Bring a snack to share and a friend if you like.',
    category: 'outdoors', vibe: 'calm', tags: ['outdoor', 'byo', 'pet-friendly'], price: 0, capacity: 20,
    when: { day: 1, hour: 18 }, hours: 3, fill: 0.3,
  },
  {
    title: '5-a-side football',
    description: 'We are two short for a proper game. Bibs and ball provided, all levels welcome, studs not allowed on the turf.',
    category: 'sports', vibe: 'active', tags: ['outdoor', 'gear-provided'], price: 500, capacity: 10,
    when: { day: 1, hour: 19 }, hours: 1.5, fill: 0.8,
  },
  {
    title: 'Karaoke night — bring your worst voice',
    description: 'Private room for 25, song book the size of a phone directory. Duets strongly encouraged.',
    category: 'music', vibe: 'lively', tags: ['indoor', 'drinks'], price: 800, capacity: 25,
    security: 'verified', minAge: 16, when: { day: 1, hour: 21 }, hours: 3, fill: 0.45,
  },
  {
    title: 'Morning run club · easy 5K',
    description: 'Conversational pace along the water, coffee afterwards. Nobody gets left behind.',
    category: 'sports', vibe: 'active', tags: ['outdoor', 'beginner-friendly', 'alcohol-free'], price: 0, capacity: 30,
    when: { day: 1, hour: 7, minute: 30 }, hours: 1, fill: 0.35,
  },
  {
    title: 'Language exchange: Spanish ↔ English',
    description: 'Half an hour in each language, small tables, no teachers. Come to practise, stay for the churros.',
    category: 'learning', vibe: 'calm', tags: ['indoor', 'alcohol-free', 'beginner-friendly'], price: 0, capacity: 15,
    when: { day: 1, hour: 18, minute: 30 }, hours: 2, fill: 0.5,
  },
  {
    title: 'Pasta-making dinner at mine',
    description: 'We roll, cut and eat fresh tagliatelle together at my place. Wine and aprons provided. Small table, so it fills fast.',
    category: 'food', vibe: 'calm', tags: ['indoor', 'food-included', 'small-group'], price: 1800, capacity: 6,
    security: 'verified', hideExact: true, when: { day: 2, hour: 19 }, hours: 3, fill: 0.5,
  },
  {
    title: 'Open-air techno in the courtyard',
    description: 'Three DJs, one courtyard, sound until late. Verified guests only — you will be on the door list by name.',
    category: 'party', vibe: 'lively', tags: ['outdoor', 'dancing', 'big-crowd', 'live-music'], price: 1500, capacity: 120,
    security: 'verified', minAge: 18, featured: true, when: { day: 2, hour: 22 }, hours: 6, fill: 0.55,
  },
  {
    title: 'Bouldering for beginners',
    description: 'I will show you the basics, you will fall off a lot, it will be great. Shoes and chalk included.',
    category: 'sports', vibe: 'active', tags: ['indoor', 'beginner-friendly', 'gear-provided'], price: 1400, capacity: 8,
    when: { day: 2, hour: 18 }, hours: 2, fill: 0.25,
  },
  {
    title: 'Life drawing session',
    description: 'Two hours, one model, short and long poses. Paper and charcoal on the table; bring your own sketchbook if you prefer.',
    category: 'arts', vibe: 'calm', tags: ['indoor', 'beginner-friendly'], price: 1000, capacity: 12,
    when: { day: 3, hour: 18, minute: 30 }, hours: 2, fill: 0.4,
  },
  {
    title: 'Jam session — bring an instrument',
    description: 'Drum kit and amps are here. Blues, funk, whatever happens. Listeners welcome too.',
    category: 'music', vibe: 'lively', tags: ['indoor', 'live-music', 'byo'], price: 500, capacity: 10,
    when: { day: 3, hour: 20 }, hours: 3, fill: 0.3,
  },
  {
    title: 'Pub quiz team needs brains',
    description: 'We know sport and music. We know nothing about geography. Please help.',
    category: 'food', vibe: 'lively', tags: ['indoor', 'drinks', 'competitive'], price: 0, capacity: 4,
    when: { day: 4, hour: 19, minute: 30 }, hours: 2.5, fill: 0.5,
  },
];

function ensureDemoUsers(ctx: Ctx, names: string[], verified: (i: number) => boolean): number[] {
  return names.map((name, i) => {
    const email = `${name.toLowerCase()}@demo.ots.app`;
    const existing = ctx.db.get<{ id: number }>('SELECT id FROM users WHERE email = ?', email);
    if (existing) return existing.id;
    const isVerified = verified(i);
    // '!' is not a valid password hash, so these accounts can never be logged into.
    return ctx.db.run(
      `INSERT INTO users (email, password_hash, display_name, avatar_color, legal_name, birth_date, id_verified_at, is_demo, created_at)
       VALUES (?, '!', ?, ?, ?, ?, ?, 1, ?)`,
      email, name, pickAvatarColor(i + name.length),
      isVerified ? `${name} ${SURNAMES[i % SURNAMES.length]}` : null,
      isVerified ? '1994-05-17' : null,
      isVerified ? nowIso(ctx) : null,
      nowIso(ctx),
    ).lastId;
  });
}

const demoHosts = (ctx: Ctx) => ensureDemoUsers(ctx, HOST_NAMES, () => true);
const demoGuests = (ctx: Ctx) => ensureDemoUsers(ctx, GUEST_NAMES, (i) => i % 3 !== 2);

/** Turn "tomorrow at 19:30" in the visitor's timezone into a UTC instant. */
function resolveStart(ctx: Ctx, when: When, tzOffsetMinutes: number): Date {
  const now = ctx.now().getTime();
  if ('inMinutes' in when) {
    const quarter = 15 * 60_000;
    return new Date(Math.round((now + when.inMinutes * 60_000) / quarter) * quarter);
  }
  const local = new Date(now - tzOffsetMinutes * 60_000);
  let start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + when.day, when.hour, when.minute ?? 0) + tzOffsetMinutes * 60_000;
  if (start < now + 20 * 60_000) start += 86_400_000;
  return new Date(start);
}

/** Scatter the sample activities around a point. Returns how many were created. */
export function seedAround(ctx: Ctx, lat: number, lng: number, tzOffsetMinutes: number): number {
  return ctx.db.tx(() => {
    const hosts = demoHosts(ctx);
    const guests = demoGuests(ctx);
    const lngScale = Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    SAMPLES.forEach((s, i) => {
      const start = resolveStart(ctx, s.when, tzOffsetMinutes);
      // A loose spiral of pins within about 2.5 km of the centre, spaced so they don't pile up.
      const angle = i * 2.4 + Math.random() * 0.3;
      const km = 0.35 + 2.1 * Math.sqrt((i + 0.5) / SAMPLES.length) + Math.random() * 0.15;
      const id = insertActivity(
        ctx,
        hosts[i % hosts.length],
        {
          title: s.title,
          description: s.description,
          category: s.category,
          vibe: s.vibe,
          tags: s.tags,
          lat: lat + (km * Math.cos(angle)) / 111.32,
          lng: lng + (km * Math.sin(angle)) / (111.32 * lngScale),
          address: `${10 + ((i * 37) % 180)} Sample Street (demo location)`,
          hideExact: s.hideExact ?? false,
          startsAt: iso(start),
          endsAt: iso(new Date(start.getTime() + s.hours * 3_600_000)),
          capacity: s.capacity,
          priceCents: s.price,
          security: s.security ?? 'open',
          minAge: s.minAge ?? null,
          photos: [],
        },
        s.featured ?? false,
      );
      const a = getActivityView(ctx, id);
      const wanted = Math.min(Math.round(s.capacity * s.fill), s.capacity - 1);
      const pool = guests.filter((_, g) => s.security !== 'verified' || g % 3 !== 2);
      for (let n = 0; n < wanted && n < pool.length; n++) {
        insertTicket(ctx, a, pool[(n + i * 5) % pool.length], 'active', null, null);
      }
    });
    return SAMPLES.length;
  });
}

/** "Drop demo activities here" on the map. */
export function populateAround(ctx: Ctx, lat: number, lng: number, tzOffsetMinutes: number): number {
  if (!ctx.config.demoMode) throw new HttpError(404, 'Not found', 'not_found');
  const nearby = ctx.db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM activities a JOIN users u ON u.id = a.host_id
     WHERE u.is_demo = 1 AND a.status = 'active' AND a.ends_at > ?
       AND a.public_lat BETWEEN ? AND ? AND a.public_lng BETWEEN ? AND ?`,
    nowIso(ctx), lat - 0.04, lat + 0.04, lng - 0.06, lng + 0.06,
  )!.n;
  if (nearby >= 8) throw new HttpError(409, 'There are already sample activities around here.', 'already_populated');
  return seedAround(ctx, lat, lng, tzOffsetMinutes);
}

/** Demo helper for hosts: a few sample guests buy tickets, so the door list and earnings have something to show. */
export function addSampleGuests(ctx: Ctx, host: UserRow, activityId: number): number {
  if (!ctx.config.demoMode) throw new HttpError(404, 'Not found', 'not_found');
  return ctx.db.tx(() => {
    const a = getActivityView(ctx, activityId, host.id);
    if (a.host_id !== host.id) throw new HttpError(403, 'Only the host can do that.', 'forbidden');
    if (a.status !== 'active' || a.ends_at <= nowIso(ctx)) throw new HttpError(409, 'This activity is no longer open.', 'ended');
    const candidates = ctx.db.all<{ id: number; id_verified_at: string | null }>(`SELECT id, id_verified_at FROM users WHERE is_demo = 1 AND email NOT IN (${HOST_NAMES.map(() => '?').join(',')}) ORDER BY RANDOM()`, ...HOST_NAMES.map((n) => `${n.toLowerCase()}@demo.ots.app`));
    let added = 0;
    for (const c of candidates.length ? candidates : demoGuests(ctx).map((id) => ({ id, id_verified_at: null }))) {
      if (added >= 3 || a.capacity - a.taken - added < 1) break;
      if (a.security === 'verified' && !c.id_verified_at) continue;
      if (hasLiveTicket(ctx, a.id, c.id)) continue;
      issueTicket(ctx, a, c.id, null, null);
      added++;
    }
    if (!added) throw new HttpError(409, 'No room left for more sample guests.', 'full');
    return added;
  });
}

/** On start-up in demo mode: make sure there is a demo login and something on the map. */
export async function ensureDemoData(ctx: Ctx): Promise<void> {
  if (!ctx.config.demoMode) return;
  if (!ctx.db.get('SELECT 1 FROM users WHERE email = ?', DEMO_EMAIL)) {
    const hash = await hashPassword(DEMO_PASSWORD);
    ctx.db.run(
      `INSERT INTO users (email, password_hash, display_name, bio, avatar_color, legal_name, birth_date, id_verified_at, created_at)
       VALUES (?, ?, 'Demo', 'Trying out OTS.', '#12131a', 'Demo Account', '1995-01-01', ?, ?)`,
      DEMO_EMAIL, hash, nowIso(ctx), nowIso(ctx),
    );
  }
  demoGuests(ctx);
  const upcoming = ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM activities WHERE status = 'active' AND ends_at > ?`, nowIso(ctx))!.n;
  if (upcoming === 0) {
    const { lat, lng } = ctx.config.mapCenter;
    seedAround(ctx, lat, lng, ctx.now().getTimezoneOffset());
  }
}
