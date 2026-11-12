import type { AppConfig } from '../shared/types';

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  return n;
}

export interface Config {
  port: number;
  dbPath: string;
  demoMode: boolean;
  currency: string;
  /** Platform cut of each ticket in basis points (500 = 5%). */
  commissionBps: number;
  listingFeeStandardCents: number;
  listingFeeFeaturedCents: number;
  /** Guests can cancel for a full refund until this long before the start. */
  refundCutoffMinutes: number;
  /** How long a group's spots are held while everyone pays their share. */
  groupHoldMinutes: number;
  maxGroupSize: number;
  minPriceCents: number;
  maxPriceCents: number;
  /** Youngest age allowed to hold an account. Activities can ask for more. */
  minAccountAge: number;
  mapCenter: { lat: number; lng: number; zoom: number };
  tileUrl: string;
  tileAttribution: string;
  geocoderUrl: string;
  adminEmails: string[];
  trustProxy: boolean;
  /** Turn off request rate limiting (used by the test suite). */
  rateLimit: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const demoMode = env.DEMO_MODE !== 'false';
  return {
    port: num(env, 'PORT', 3001),
    dbPath: env.DATABASE_PATH ?? 'data/ots.db',
    demoMode,
    currency: (env.CURRENCY ?? 'USD').toUpperCase(),
    commissionBps: num(env, 'COMMISSION_BPS', 500),
    listingFeeStandardCents: num(env, 'LISTING_FEE_STANDARD_CENTS', 100),
    listingFeeFeaturedCents: num(env, 'LISTING_FEE_FEATURED_CENTS', 200),
    refundCutoffMinutes: num(env, 'REFUND_CUTOFF_MINUTES', 120),
    groupHoldMinutes: num(env, 'GROUP_HOLD_MINUTES', 10),
    maxGroupSize: num(env, 'MAX_GROUP_SIZE', 8),
    minPriceCents: num(env, 'MIN_PRICE_CENTS', 100),
    maxPriceCents: num(env, 'MAX_PRICE_CENTS', 50_000),
    minAccountAge: num(env, 'MIN_ACCOUNT_AGE', 16),
    mapCenter: {
      lat: num(env, 'MAP_CENTER_LAT', 40.7359),
      lng: num(env, 'MAP_CENTER_LNG', -73.9911),
      zoom: num(env, 'MAP_ZOOM', 14),
    },
    tileUrl: env.TILE_URL ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution:
      env.TILE_ATTRIBUTION ??
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    geocoderUrl: env.GEOCODER_URL ?? 'https://nominatim.openstreetmap.org',
    adminEmails: (env.ADMIN_EMAILS ?? (demoMode ? 'demo@ots.app' : ''))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    trustProxy: Boolean(env.TRUST_PROXY),
    rateLimit: env.RATE_LIMIT !== 'false',
  };
}

export function publicConfig(c: Config, paymentMethods: AppConfig['paymentMethods']): AppConfig {
  return {
    demoMode: c.demoMode,
    currency: c.currency,
    commissionBps: c.commissionBps,
    listingFeeCents: { standard: c.listingFeeStandardCents, featured: c.listingFeeFeaturedCents },
    refundCutoffMinutes: c.refundCutoffMinutes,
    groupHoldMinutes: c.groupHoldMinutes,
    maxGroupSize: c.maxGroupSize,
    minPriceCents: c.minPriceCents,
    maxPriceCents: c.maxPriceCents,
    minAccountAge: c.minAccountAge,
    mapCenter: c.mapCenter,
    tileUrl: c.tileUrl,
    tileAttribution: c.tileAttribution,
    geocoderUrl: c.geocoderUrl,
    paymentMethods,
  };
}
