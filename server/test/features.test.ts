import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { BASE_SCHEMA, Db } from '../db';
import { base32Decode, base32Encode, stepAt, totpAt, verifyTotp } from '../totp';
import { HOUR, MINUTE, hostActivity, startTestApp, type Client, type TestApp } from './helpers';

const PAY = { paymentMethod: 'demo_card_ok' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 1)]);

function scenario(name: string, fn: (t: TestApp) => Promise<void>, config = {}) {
  test(name, async () => {
    const t = await startTestApp(config);
    try {
      await fn(t);
    } finally {
      t.close();
    }
  });
}

const photo = async (c: Client, bytes: Buffer = JPEG): Promise<string> => {
  const res = await c.upload('/images', bytes, 'image/jpeg');
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
};

// -------------------------------------------------------------- database

test('database: one created by the first release is upgraded in place, keeping its data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ots-'));
  const path = join(dir, 'old.db');
  try {
    const old = new DatabaseSync(path);
    old.exec(BASE_SCHEMA);
    old.exec(`INSERT INTO users (email, password_hash, display_name, avatar_color, created_at) VALUES ('old@example.com', 'x', 'Old', '#000', '2026-01-01T00:00:00.000Z')`);
    old.close();

    const db = new Db(path);
    const user = db.get<{ email: string; avatar_image: string | null; totp_last_step: number }>('SELECT email, avatar_image, totp_last_step FROM users');
    assert.deepEqual({ ...user }, { email: 'old@example.com', avatar_image: null, totp_last_step: 0 });
    assert.equal(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM images')!.n, 0);
    db.close();

    new Db(path).close(); // opening it again changes nothing
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------ profile pictures

scenario('profile pictures: upload, show to others, replace and remove', async (t) => {
  const ana = await t.person('Ana');
  assert.equal((await ana.get('/me')).body.user.avatarUrl, null);

  const up = await ana.upload('/me/avatar', JPEG, 'image/jpeg');
  assert.equal(up.status, 201);
  const url: string = up.body.user.avatarUrl;
  const served = await t.anonymous().download(url);
  assert.equal(served.type, 'image/jpeg');
  assert.ok(served.bytes.equals(JPEG), 'comes back byte for byte');

  const profile = (await t.anonymous().get(`/users/${ana.id}`)).body.profile;
  assert.equal(profile.user.avatarUrl, url);

  const replaced = await ana.upload('/me/avatar', PNG, 'image/png');
  assert.notEqual(replaced.body.user.avatarUrl, url);
  assert.equal((await ana.download(replaced.body.user.avatarUrl)).type, 'image/png');
  assert.equal((await ana.download(url)).status, 404, 'the old picture is gone');

  assert.equal((await ana.delete('/me/avatar')).body.user.avatarUrl, null);
  assert.equal((await ana.download(replaced.body.user.avatarUrl)).status, 404);
});

scenario('uploads: only real, reasonably sized images from logged-in members are accepted', async (t) => {
  const ana = await t.person('Ana');
  assert.equal((await ana.upload('/me/avatar', Buffer.from('<script>alert(1)</script>'), 'image/png')).status, 415, 'type is read from the bytes, not the label');
  assert.equal((await ana.upload('/me/avatar', JPEG, 'text/plain')).status, 415);
  assert.equal((await ana.upload('/me/avatar', Buffer.concat([JPEG, Buffer.alloc(1_100_000)]), 'image/jpeg')).status, 413);
  assert.equal((await ana.upload('/images', Buffer.concat([JPEG, Buffer.alloc(4_500_000)]), 'image/jpeg')).status, 413);
  assert.equal((await t.anonymous().upload('/images', JPEG, 'image/jpeg')).status, 401);
  assert.equal((await ana.download('/api/images/not-an-id')).status, 404);
  assert.equal((await ana.get('/me')).body.user.avatarUrl, null);
});

// ---------------------------------------------------------- venue photos

scenario('venue photos: hosts add pictures to their page for free; the first one is the cover', async (t) => {
  const host = await t.person('Hana', { verified: true });
  const [a, b] = [await photo(host), await photo(host, Buffer.concat([JPEG, Buffer.from('b')]))];
  const created = await host.post('/activities', t.activity({ photos: [b, a] }));
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(t.platform('listing_fee'), 100, 'photos cost nothing extra');

  const detail = (await t.anonymous().get(`/activities/${id}`)).body.activity;
  assert.deepEqual(detail.photos.map((p: any) => p.id), [b, a]);
  assert.equal(detail.coverUrl, `/api/images/${b}`);
  assert.equal((await t.anonymous().get('/activities')).body.activities[0].coverUrl, `/api/images/${b}`);
  assert.equal((await t.anonymous().download(detail.photos[1].url)).status, 200);

  // Photos stay editable after guests have joined — unlike the time, place and price.
  await (await t.person('Gus')).post(`/activities/${id}/join`, PAY);
  const c = await photo(host);
  const edited = await host.patch(`/activities/${id}`, { photos: [a, c] });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.activity.photos.map((p: any) => p.id), [a, c]);
  assert.equal((await host.patch(`/activities/${id}`, { priceCents: 5000 })).status, 409);
  assert.equal((await host.patch(`/activities/${id}`, { photos: [] })).body.activity.coverUrl, null);
});

scenario('venue photos: only your own uploads, and no more than eight', async (t) => {
  const host = await t.person('Hana');
  const other = await t.person('Otto');
  const theirs = await photo(other);
  assert.equal((await host.post('/activities', t.activity({ photos: [theirs] }))).status, 400);
  assert.equal((await host.post('/activities', t.activity({ photos: ['../../etc/passwd'] }))).status, 400);

  const avatar = (await host.upload('/me/avatar', JPEG, 'image/jpeg')).body.user.avatarUrl.split('/').pop();
  assert.equal((await host.post('/activities', t.activity({ photos: [avatar] }))).status, 400, 'a profile picture is not a venue photo');

  const nine = [];
  for (let i = 0; i < 9; i++) nine.push(await photo(host, Buffer.concat([JPEG, Buffer.from([i])])));
  assert.equal((await host.post('/activities', t.activity({ photos: nine }))).status, 400);
  assert.equal((await host.post('/activities', t.activity({ photos: nine.slice(0, 8) }))).status, 201);
});

// ------------------------------------------------------------ age limits

scenario('age limits: a 16+ activity lets a 16-year-old in and keeps a 15-year-old out', async (t) => {
  // The test clock reads 1 June 2026; the activity starts that evening.
  const { host, id } = await hostActivity(t, { security: 'verified', minAge: 16 });
  const verify = (c: Client, birthDate: string) => c.post('/me/verify-id', { legalName: 'Some Body', birthDate });

  const fifteen = await t.person('Finn');
  assert.equal((await verify(fifteen, '2010-09-01')).status, 200);
  const refused = await fifteen.post(`/activities/${id}/join`, PAY);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'too_young');
  assert.equal((await fifteen.get(`/activities/${id}`)).body.activity.viewer.tooYoung, true);

  const sixteen = await t.person('Sia');
  await verify(sixteen, '2010-05-31');
  assert.equal((await sixteen.get(`/activities/${id}`)).body.activity.viewer.tooYoung, false);
  assert.equal((await sixteen.post(`/activities/${id}/join`, PAY)).status, 201);

  const birthday = await t.person('Bea');
  await verify(birthday, '2010-06-01');
  assert.equal((await birthday.post(`/activities/${id}/join`, PAY)).status, 201, 'turning 16 on the day counts');

  const unverified = await t.person('Uma');
  assert.equal((await unverified.post(`/activities/${id}/join`, PAY)).body.error.code, 'id_required');

  const listed = (await t.anonymous().get('/activities')).body.activities[0];
  assert.equal(listed.minAge, 16);
  assert.equal((await host.patch(`/activities/${id}`, { minAge: 18 })).status, 409, 'locked once guests have joined');
  assert.equal(t.platform('commission'), 100, 'only the two who got in paid');
}, { minAccountAge: 14 });

scenario('age limits: a group cannot bring an under-age friend in', async (t) => {
  const { id } = await hostActivity(t, { security: 'verified', minAge: 18 });
  const lia = await t.person('Lia', { verified: true });
  const kid = await t.person('Kit');
  await kid.post('/me/verify-id', { legalName: 'Kit Young', birthDate: '2009-01-01' }); // 17
  const code = (await lia.post(`/activities/${id}/groups`)).body.code;
  await kid.post(`/groups/${code}/join`);

  const view = (await lia.get(`/groups/${code}`)).body.group;
  assert.deepEqual(view.members.find((m: any) => m.user.displayName === 'Kit').issues, ['Under 18']);
  assert.equal((await lia.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY })).status, 409);
  assert.equal((await lia.get('/tickets')).body.tickets.length, 0);
});

scenario('age limits: they need ID-verified guests, and cannot go below the youngest account age', async (t) => {
  const host = await t.person('Hana');
  assert.equal((await host.post('/activities', t.activity({ security: 'open', minAge: 18 }))).status, 400);
  assert.equal((await host.post('/activities', t.activity({ security: 'verified', minAge: 12 }))).status, 400);
  assert.equal((await host.post('/activities', t.activity({ security: 'verified', minAge: 21 }))).status, 201);
  assert.equal((await host.post('/activities', t.activity({ security: 'verified', minAge: null }))).status, 201);

  // By default accounts are for 16 and over.
  assert.equal((await host.get('/config')).body.minAccountAge, 16);
  const young = await t.person('Yan');
  const res = await young.post('/me/verify-id', { legalName: 'Yan Young', birthDate: '2011-01-01' });
  assert.equal(res.status, 422);
  assert.match(res.body.error.message, /16 or older/);
});

// --------------------------------------------------------- two-step login

test('two-step login: codes match the published RFC 6238 test vectors', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  // RFC 6238 appendix B lists 8-digit codes; ours are the last six digits of each.
  assert.equal(totpAt(secret, stepAt(59_000)), '287082');
  assert.equal(totpAt(secret, stepAt(1_111_111_109_000)), '081804');
  assert.equal(totpAt(secret, stepAt(2_000_000_000_000)), '279037');
  assert.equal(verifyTotp(secret, '287 082', 59_000), 1);
  assert.equal(verifyTotp(secret, '287082', 59_000 + 60_000), null, 'two steps later it is stale');
});

async function turnOn(t: TestApp, c: Client): Promise<{ secret: string; codes: string[] }> {
  const setup = (await c.post('/me/2fa/setup')).body;
  const res = await c.post('/me/2fa/enable', { code: totpAt(setup.secret, stepAt(t.ctx.now().getTime())) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { secret: setup.secret, codes: res.body.recoveryCodes };
}
const codeNow = (t: TestApp, secret: string) => totpAt(secret, stepAt(t.ctx.now().getTime()));
const login = (c: Client) => c.post('/auth/login', { email: 'ana@example.com', password: 'correct horse' });

scenario('two-step login: once it is on, the password alone no longer gets you in', async (t) => {
  const ana = await t.person('Ana');
  const setup = (await ana.post('/me/2fa/setup')).body;
  assert.match(setup.uri, /^otpauth:\/\/totp\/OTS%3Aana%40example\.com\?secret=[A-Z2-7]{32}&issuer=OTS/);
  assert.equal((await ana.post('/me/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await ana.get('/me')).body.user.twoFactorEnabled, false);

  const setupCode = codeNow(t, setup.secret);
  const enabled = await ana.post('/me/2fa/enable', { code: setupCode });
  assert.equal(enabled.body.recoveryCodes.length, 8);
  assert.equal(enabled.body.user.twoFactorEnabled, true);
  assert.equal((await ana.post('/me/2fa/setup')).status, 409);

  await ana.post('/auth/logout');
  const first = await login(ana);
  assert.equal(first.status, 200);
  assert.equal(first.body.user, undefined);
  assert.equal((await ana.get('/me')).body.user, null, 'no session after the password alone');
  const ticket = first.body.twoFactor.ticket;

  assert.equal((await ana.post('/auth/login/verify', { ticket, code: '123456' })).status, 401);
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: setupCode })).status, 401, 'a code that was already used is refused');
  assert.equal((await ana.post('/auth/login/verify', { ticket: 'x'.repeat(43), code: setupCode })).status, 401);

  t.advance(30_000);
  const ok = await ana.post('/auth/login/verify', { ticket, code: codeNow(t, setup.secret) });
  assert.equal(ok.status, 200);
  assert.equal((await ana.get('/me')).body.user.email, 'ana@example.com');
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: codeNow(t, setup.secret) })).status, 401, 'a ticket works once');
});

scenario('two-step login: recovery codes work once each', async (t) => {
  const ana = await t.person('Ana');
  const { codes } = await turnOn(t, ana);
  await ana.post('/auth/logout');

  const spoken = `${codes[0].slice(0, 4).toLowerCase()}-${codes[0].slice(4).toLowerCase()}`;
  let ticket = (await login(ana)).body.twoFactor.ticket;
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: spoken })).status, 200);
  assert.equal((await ana.get('/me/2fa')).body.recoveryCodesLeft, 7);

  await ana.post('/auth/logout');
  ticket = (await login(ana)).body.twoFactor.ticket;
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: codes[0] })).status, 401);
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: codes[1] })).status, 200);
});

scenario('two-step login: five wrong codes or five minutes end the attempt', async (t) => {
  const ana = await t.person('Ana');
  const { secret } = await turnOn(t, ana);
  await ana.post('/auth/logout');
  t.advance(MINUTE);

  let ticket = (await login(ana)).body.twoFactor.ticket;
  for (let i = 0; i < 5; i++) assert.equal((await ana.post('/auth/login/verify', { ticket, code: '000000' })).status, 401);
  const locked = await ana.post('/auth/login/verify', { ticket, code: codeNow(t, secret) });
  assert.equal(locked.status, 401);
  assert.equal(locked.body.error.code, 'challenge_expired');

  ticket = (await login(ana)).body.twoFactor.ticket;
  t.advance(6 * MINUTE);
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: codeNow(t, secret) })).body.error.code, 'challenge_expired');

  ticket = (await login(ana)).body.twoFactor.ticket;
  assert.equal((await ana.post('/auth/login/verify', { ticket, code: codeNow(t, secret) })).status, 200);
});

scenario('two-step login: turning it off needs the password', async (t) => {
  const ana = await t.person('Ana');
  await turnOn(t, ana);
  assert.equal((await ana.post('/me/2fa/disable', { password: 'nope' })).status, 401);
  assert.equal((await ana.get('/me')).body.user.twoFactorEnabled, true);
  assert.equal((await ana.post('/me/2fa/disable', { password: 'correct horse' })).body.user.twoFactorEnabled, false);
  await ana.post('/auth/logout');
  assert.equal((await login(ana)).body.user.email, 'ana@example.com');

  assert.equal((await t.anonymous().post('/me/2fa/setup')).status, 401);
  const demo = t.anonymous();
  await demo.post('/auth/register', { email: 'demo@ots.app', password: 'demo1234', displayName: 'Demo', ageConfirmed: true });
  assert.equal((await demo.post('/me/2fa/setup')).status, 403, 'the shared demo login stays open to everyone');
});

// --------------------------------------------------------- public profile

scenario('profiles: anyone can see who a host is and what they are hosting — nothing private', async (t) => {
  const { host, id } = await hostActivity(t, { title: 'Garden party' });
  await host.patch('/me', { bio: 'I throw parties.' });
  await host.post('/activities', t.activity({ title: 'Long gone', startsAt: new Date(t.ctx.now().getTime() + HOUR).toISOString(), endsAt: new Date(t.ctx.now().getTime() + 2 * HOUR).toISOString() }));
  t.advance(3 * HOUR);

  const profile = (await t.anonymous().get(`/users/${host.id}`)).body.profile;
  assert.equal(profile.user.displayName, 'Hana');
  assert.equal(profile.user.verified, true);
  assert.equal(profile.bio, 'I throw parties.');
  assert.deepEqual(profile.activities.map((a: any) => a.id), [id], 'only what is still on the map');
  const text = JSON.stringify(profile);
  assert.ok(!text.includes('example.com') && !text.includes('Legalname') && !text.includes('1990'), 'no e-mail, legal name or birth date');
  assert.equal((await t.anonymous().get('/users/9999')).status, 404);
});
