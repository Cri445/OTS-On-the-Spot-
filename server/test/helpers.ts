import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app';
import { loadConfig, type Config } from '../config';
import { Db } from '../db';
import { DemoIdentityProvider } from '../identity';
import { DemoPaymentProvider } from '../payments';
import type { Ctx } from '../util';

export const HOUR = 3_600_000;
export const MINUTE = 60_000;

/** One logged-in browser: remembers its session cookie between requests. */
export class Client {
  private cookie = '';
  id = 0;

  constructor(private readonly base: string) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    if (set.length) this.cookie = set[0].split(';')[0];
    return { status: res.status, body: await res.json() };
  }

  /** Send raw bytes, the way the web app uploads a picture. */
  async upload(path: string, bytes: Uint8Array, type: string): Promise<{ status: number; body: any }> {
    const res = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': type, ...(this.cookie ? { cookie: this.cookie } : {}) }, body: bytes });
    return { status: res.status, body: await res.json() };
  }

  /** Fetch something that isn't JSON. Accepts the "/api/..." URLs the API hands out. */
  async download(url: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
    const res = await fetch(this.base + url.replace(/^\/api/, ''));
    return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
  }

  get = (path: string) => this.req('GET', path);
  post = (path: string, body: unknown = {}) => this.req('POST', path, body);
  patch = (path: string, body: unknown) => this.req('PATCH', path, body);
  delete = (path: string) => this.req('DELETE', path);
}

export interface TestApp {
  ctx: Ctx;
  payments: DemoPaymentProvider;
  /** Move the server's clock forward. */
  advance(ms: number): void;
  /** A new signed-up person. */
  person(name: string, opts?: { verified?: boolean }): Promise<Client>;
  anonymous(): Client;
  /** A valid "host an activity" request body, starting 6 hours from now. */
  activity(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** Total the platform has earned so far, by ledger kind. */
  platform(kind: string): number;
  close(): void;
}

export async function startTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const config: Config = { ...loadConfig({}), rateLimit: false, ...overrides };
  let clock = new Date('2026-06-01T12:00:00.000Z');
  const payments = new DemoPaymentProvider();
  const ctx: Ctx = { db: new Db(':memory:'), config, now: () => clock, payments, identity: new DemoIdentityProvider() };
  const server = createApp(ctx).listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;

  return {
    ctx,
    payments,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    async person(name, opts = {}) {
      const c = new Client(base);
      const res = await c.post('/auth/register', { email: `${name.toLowerCase()}@example.com`, password: 'correct horse', displayName: name, ageConfirmed: true });
      if (res.status !== 201) throw new Error(`sign-up failed: ${JSON.stringify(res.body)}`);
      c.id = res.body.user.id;
      if (opts.verified) {
        const v = await c.post('/me/verify-id', { legalName: `${name} Legalname`, birthDate: '1990-03-04' });
        if (v.status !== 200) throw new Error(`verification failed: ${JSON.stringify(v.body)}`);
      }
      return c;
    },
    anonymous: () => new Client(base),
    activity(over = {}) {
      const start = clock.getTime() + 6 * HOUR;
      return {
        title: 'Test party',
        description: 'A party for tests.',
        category: 'party',
        vibe: 'lively',
        tags: ['drinks'],
        lat: 40.73,
        lng: -73.99,
        address: '1 Test Street',
        hideExact: false,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(start + 3 * HOUR).toISOString(),
        capacity: 10,
        priceCents: 1000,
        security: 'open',
        featured: false,
        paymentMethod: 'demo_card_ok',
        ...over,
      };
    },
    platform(kind) {
      return ctx.db.get<{ n: number }>('SELECT COALESCE(SUM(amount_cents), 0) AS n FROM ledger WHERE user_id IS NULL AND kind = ?', kind)!.n;
    },
    close() {
      server.close();
      server.closeAllConnections();
      ctx.db.close();
    },
  };
}

/** Sign someone up as host and publish one activity. Returns the host and the activity id. */
export async function hostActivity(t: TestApp, overrides: Record<string, unknown> = {}, hostName = 'Hana'): Promise<{ host: Client; id: number }> {
  const host = await t.person(hostName, { verified: true });
  const res = await host.post('/activities', t.activity(overrides));
  if (res.status !== 201) throw new Error(`could not create activity: ${JSON.stringify(res.body)}`);
  return { host, id: res.body.id };
}
