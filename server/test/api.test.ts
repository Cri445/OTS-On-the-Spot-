import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HOUR, MINUTE, hostActivity, startTestApp, type TestApp } from './helpers';

const PAY = { paymentMethod: 'demo_card_ok' };
const DECLINE = { paymentMethod: 'demo_card_declined' };

/** Run a test against a fresh server and database. */
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

const spotsLeft = async (t: TestApp, id: number) => (await t.anonymous().get(`/activities/${id}`)).body.activity.spotsLeft;

// ---------------------------------------------------------------- accounts

scenario('accounts: sign up, log out, log back in', async (t) => {
  const ana = await t.person('Ana');
  assert.equal((await ana.get('/me')).body.user.displayName, 'Ana');

  await ana.post('/auth/logout');
  assert.equal((await ana.get('/me')).body.user, null);

  assert.equal((await ana.post('/auth/login', { email: 'ana@example.com', password: 'wrong password' })).status, 401);
  assert.equal((await ana.post('/auth/login', { email: 'ANA@example.com', password: 'correct horse' })).status, 200);
  assert.equal((await ana.get('/me')).body.user.email, 'ana@example.com');
});

scenario('accounts: duplicate e-mails, weak passwords and minors are turned away', async (t) => {
  await t.person('Ana');
  const c = t.anonymous();
  const base = { email: 'new@example.com', password: 'correct horse', displayName: 'New', adult: true };
  assert.equal((await c.post('/auth/register', { ...base, email: 'ana@example.com' })).status, 409);
  assert.equal((await c.post('/auth/register', { ...base, password: 'short' })).status, 400);
  assert.equal((await c.post('/auth/register', { ...base, adult: false })).status, 400);
  assert.equal((await c.get('/tickets')).status, 401);
});

scenario('ID verification: adults pass, under-18s do not', async (t) => {
  const kid = await t.person('Kid');
  const res = await kid.post('/me/verify-id', { legalName: 'Kid Young', birthDate: '2012-01-01' });
  assert.equal(res.status, 422);
  assert.equal((await kid.get('/me')).body.user.verified, false);

  const ok = await kid.post('/me/verify-id', { legalName: 'Kid Grown', birthDate: '1999-01-01' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.verified, true);
});

// ----------------------------------------------------------------- hosting

scenario('hosting: putting an activity on the map costs $1, or $2 featured', async (t) => {
  const { host, id } = await hostActivity(t);
  assert.equal(t.platform('listing_fee'), 100);

  const featured = await host.post('/activities', t.activity({ title: 'Featured one', featured: true }));
  assert.equal(featured.status, 201);
  assert.equal(t.platform('listing_fee'), 300);

  const list = (await t.anonymous().get('/activities')).body.activities;
  assert.deepEqual(list.map((a: any) => a.title), ['Featured one', 'Test party'], 'featured listings come first');
  assert.equal(list.find((a: any) => a.id === id).featured, false);

  const fees = (await host.get('/wallet')).body.wallet.entries.filter((e: any) => e.kind === 'listing_fee');
  assert.deepEqual(fees.map((e: any) => e.amountCents).sort(), [-100, -200].sort());
});

scenario('hosting: a declined card means nothing is listed', async (t) => {
  const host = await t.person('Hana');
  const res = await host.post('/activities', t.activity(DECLINE));
  assert.equal(res.status, 402);
  assert.equal((await host.get('/activities')).body.activities.length, 0);
  assert.equal(t.platform('listing_fee'), 0);
});

scenario('hosting: bad input is rejected with a readable message', async (t) => {
  const host = await t.person('Hana');
  const bad = async (over: Record<string, unknown>) => (await host.post('/activities', t.activity(over))).status;
  assert.equal(await bad({ title: 'x' }), 400);
  assert.equal(await bad({ vibe: 'chaotic' }), 400);
  assert.equal(await bad({ priceCents: 50 }), 400, 'below the minimum price');
  assert.equal(await bad({ capacity: 0 }), 400);
  assert.equal(await bad({ startsAt: new Date(t.ctx.now().getTime() - 2 * HOUR).toISOString() }), 400, 'in the past');
  assert.equal(await bad({ endsAt: new Date(t.ctx.now().getTime() + 1 * HOUR).toISOString() }), 400, 'ends before it starts');
  assert.equal((await t.anonymous().post('/activities', t.activity())).status, 401);
});

scenario('hosting: once someone has joined, time, place and price are locked', async (t) => {
  const { host, id } = await hostActivity(t);
  assert.equal((await host.patch(`/activities/${id}`, { title: 'Renamed party', priceCents: 1500 })).status, 200);

  const guest = await t.person('Gus');
  assert.equal((await guest.post(`/activities/${id}/join`, PAY)).status, 201);
  assert.equal((await guest.patch(`/activities/${id}`, { title: 'Hijacked' })).status, 403);

  assert.equal((await host.patch(`/activities/${id}`, { priceCents: 2000 })).status, 409);
  assert.equal((await host.patch(`/activities/${id}`, { capacity: 0 })).status, 400);
  const ok = await host.patch(`/activities/${id}`, { description: 'Now with snacks', capacity: 12 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.activity.capacity, 12);
  assert.equal(ok.body.activity.priceCents, 1500);
});

// ----------------------------------------------------------------- joining

scenario('joining: the guest pays the price, the host keeps 95%, OTS keeps 5%', async (t) => {
  const { host, id } = await hostActivity(t, { priceCents: 1000, capacity: 3 });
  const guest = await t.person('Gus');

  const res = await guest.post(`/activities/${id}/join`, PAY);
  assert.equal(res.status, 201);
  assert.equal(res.body.activity.viewer.ticket.priceCents, 1000);
  assert.equal(res.body.activity.spotsLeft, 2);

  assert.equal(t.platform('commission'), 50);
  const wallet = (await host.get('/wallet')).body.wallet;
  assert.equal(wallet.pendingCents, 950);
  assert.equal(wallet.availableCents, 0);

  const charged = [...t.payments.charges.values()].filter((c) => c.status === 'captured').map((c) => c.amountCents);
  assert.deepEqual(charged.sort((a, b) => a - b), [100, 1000], 'listing fee and one ticket were charged');

  assert.equal((await guest.post(`/activities/${id}/join`, PAY)).status, 409, 'no double booking');
  assert.equal((await host.post(`/activities/${id}/join`, PAY)).status, 409, 'hosts cannot join their own activity');
});

scenario('joining: odd prices round the 5% cut to the nearest cent', async (t) => {
  const { host, id } = await hostActivity(t, { priceCents: 1250 });
  await (await t.person('Gus')).post(`/activities/${id}/join`, PAY);
  assert.equal(t.platform('commission'), 63);
  assert.equal((await host.get('/wallet')).body.wallet.pendingCents, 1187);
});

scenario('joining: a declined card leaves the spot free', async (t) => {
  const { id } = await hostActivity(t, { capacity: 1 });
  const guest = await t.person('Gus');
  assert.equal((await guest.post(`/activities/${id}/join`, DECLINE)).status, 402);
  assert.equal(await spotsLeft(t, id), 1);
  assert.equal((await guest.post(`/activities/${id}/join`, PAY)).status, 201);
  assert.equal(t.platform('commission'), 50);
});

scenario('joining: free activities need no payment and earn no commission', async (t) => {
  const { host, id } = await hostActivity(t, { priceCents: 0 });
  const guest = await t.person('Gus');
  assert.equal((await guest.post(`/activities/${id}/join`)).status, 201);
  assert.equal(t.platform('commission'), 0);
  assert.equal((await host.get('/wallet')).body.wallet.pendingCents, 0);
});

scenario('joining: a full activity turns people away', async (t) => {
  const { id } = await hostActivity(t, { capacity: 1 });
  assert.equal((await (await t.person('Gus')).post(`/activities/${id}/join`, PAY)).status, 201);
  const late = await (await t.person('Lea')).post(`/activities/${id}/join`, PAY);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'full');
  assert.equal(await spotsLeft(t, id), 0);
});

scenario('joining: an activity that has ended cannot be joined and leaves the map', async (t) => {
  const { id } = await hostActivity(t);
  t.advance(10 * HOUR);
  assert.equal((await (await t.person('Gus')).post(`/activities/${id}/join`, PAY)).status, 409);
  assert.equal((await t.anonymous().get('/activities')).body.activities.length, 0);
});

// ---------------------------------------------------------------- security

scenario('security: ID-required activities only admit verified guests, and the host sees who they are', async (t) => {
  const { host, id } = await hostActivity(t, { security: 'verified' });
  const guest = await t.person('Gus');

  const blocked = await guest.post(`/activities/${id}/join`, PAY);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'id_required');

  await guest.post('/me/verify-id', { legalName: 'Gustav Example', birthDate: '1991-02-03' });
  assert.equal((await guest.post(`/activities/${id}/join`, PAY)).status, 201);

  const attendees = (await host.get(`/activities/${id}/attendees`)).body.attendees;
  assert.equal(attendees.length, 1);
  assert.equal(attendees[0].legalName, 'Gustav Example');
  assert.equal(attendees[0].verified, true);

  assert.equal((await guest.get(`/activities/${id}/attendees`)).status, 403, 'guests cannot read the door list');
});

scenario('security: open activities never reveal a guest\'s legal name', async (t) => {
  const { host, id } = await hostActivity(t, { security: 'open' });
  const guest = await t.person('Gus', { verified: true });
  await guest.post(`/activities/${id}/join`, PAY);
  const [a] = (await host.get(`/activities/${id}/attendees`)).body.attendees;
  assert.equal(a.legalName, null);
  assert.equal(a.displayName, 'Gus');
});

scenario('security: a hidden address is only shown to the host and to guests with a ticket', async (t) => {
  const { host, id } = await hostActivity(t, { hideExact: true, lat: 40.73, lng: -73.99, address: '7 Secret Lane' });
  const guest = await t.person('Gus');

  const before = (await guest.get(`/activities/${id}`)).body.activity;
  assert.equal(before.approximate, true);
  assert.equal(before.address, null);
  const metres = Math.hypot((before.lat - 40.73) * 111_320, (before.lng + 73.99) * 111_320 * Math.cos((40.73 * Math.PI) / 180));
  assert.ok(metres > 100 && metres < 400, `pin is moved 150–350 m, got ${metres.toFixed(0)}`);
  assert.equal((await guest.get('/activities')).body.activities[0].address, null);
  assert.equal(before.going, null, 'strangers do not see who is going');

  await guest.post(`/activities/${id}/join`, PAY);
  const after = (await guest.get(`/activities/${id}`)).body.activity;
  assert.equal(after.approximate, false);
  assert.equal(after.address, '7 Secret Lane');
  assert.equal(after.lat, 40.73);
  assert.deepEqual(after.going.map((g: any) => g.displayName), ['Gus']);

  assert.equal((await host.get(`/activities/${id}`)).body.activity.address, '7 Secret Lane');
});

// ----------------------------------------------------------------- refunds

scenario('refunds: a guest can hand a ticket back until 2 hours before the start', async (t) => {
  const { host, id } = await hostActivity(t, { capacity: 2 });
  const early = await t.person('Eli');
  const late = await t.person('Lea');
  const ticketOf = async (c: typeof early) => (await c.get('/tickets')).body.tickets[0];
  await early.post(`/activities/${id}/join`, PAY);
  await late.post(`/activities/${id}/join`, PAY);
  assert.equal(await spotsLeft(t, id), 0);

  const ticket = await ticketOf(early);
  assert.equal(ticket.refundable, true);
  assert.equal((await early.post(`/tickets/${ticket.id}/cancel`)).status, 200);
  assert.equal(await spotsLeft(t, id), 1);
  assert.equal(t.platform('commission') + t.platform('commission_reversal'), 50, 'OTS keeps the cut of the one remaining ticket');
  assert.equal((await host.get('/wallet')).body.wallet.pendingCents, 950);
  const refund = (await early.get('/wallet')).body.wallet.entries.find((e: any) => e.kind === 'refund');
  assert.equal(refund.amountCents, 1000);
  assert.equal((await early.post(`/tickets/${ticket.id}/cancel`)).status, 409, 'cannot refund twice');

  t.advance(4 * HOUR + 30 * MINUTE); // 90 minutes before the start
  const lateTicket = await ticketOf(late);
  assert.equal(lateTicket.refundable, false);
  assert.equal((await late.post(`/tickets/${lateTicket.id}/cancel`)).status, 409);
  assert.equal((await early.post(`/tickets/${lateTicket.id}/cancel`)).status, 404, "cannot cancel someone else's ticket");
});

scenario('refunds: when the host cancels, every guest gets their money back', async (t) => {
  const { host, id } = await hostActivity(t);
  const a = await t.person('Ana');
  const b = await t.person('Ben');
  await a.post(`/activities/${id}/join`, PAY);
  await b.post(`/activities/${id}/join`, PAY);

  assert.equal((await a.post(`/activities/${id}/cancel`)).status, 403);
  assert.equal((await host.post(`/activities/${id}/cancel`)).status, 200);

  assert.equal(t.platform('commission') + t.platform('commission_reversal'), 0);
  assert.equal(t.platform('listing_fee'), 100, 'the listing fee is not returned');
  const wallet = (await host.get('/wallet')).body.wallet;
  assert.equal(wallet.pendingCents + wallet.availableCents, 0);
  const refunded = [...t.payments.charges.values()].reduce((sum, c) => sum + c.refundedCents, 0);
  assert.equal(refunded, 2000);

  assert.equal((await a.get('/tickets')).body.tickets[0].status, 'cancelled');
  assert.equal((await t.anonymous().get('/activities')).body.activities.length, 0);
  assert.equal((await (await t.person('Cy')).post(`/activities/${id}/join`, PAY)).status, 409);
});

// ------------------------------------------------------------------ groups

async function formGroup(t: TestApp, id: number, names: string[], opts: { verified?: boolean } = {}) {
  const members = [];
  for (const n of names) members.push(await t.person(n, opts));
  const [leader, ...friends] = members;
  const code: string = (await leader.post(`/activities/${id}/groups`)).body.code;
  for (const f of friends) assert.equal((await f.post(`/groups/${code}/join`)).status, 200);
  return { leader, friends, members, code };
}

scenario('groups: the leader pays for everyone and the whole group gets in', async (t) => {
  const { host, id } = await hostActivity(t, { capacity: 5, priceCents: 1000 });
  const { leader, members, code } = await formGroup(t, id, ['Lia', 'Max', 'Noa']);

  const res = await leader.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY });
  assert.equal(res.status, 200);
  assert.equal(res.body.group.status, 'confirmed');
  assert.equal(await spotsLeft(t, id), 2);

  for (const m of members) {
    const tickets = (await m.get('/tickets')).body.tickets;
    assert.equal(tickets.length, 1);
    assert.equal(tickets[0].groupCode, code);
  }
  const groupCharge = [...t.payments.charges.values()].find((c) => c.amountCents === 3000);
  assert.equal(groupCharge?.status, 'captured', 'one charge for the whole group');
  assert.equal(t.platform('commission'), 150);
  assert.equal((await host.get('/wallet')).body.wallet.pendingCents, 2850);
});

scenario('groups: if there is not room for everyone, nobody gets in', async (t) => {
  const { id } = await hostActivity(t, { capacity: 2 });
  const { leader, members, code } = await formGroup(t, id, ['Lia', 'Max', 'Noa']);

  const view = (await leader.get(`/groups/${code}`)).body.group;
  assert.match(view.blockers.join(' '), /Only 2 spots left for your group of 3/);

  const res = await leader.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY });
  assert.equal(res.status, 409);
  assert.equal(await spotsLeft(t, id), 2);
  for (const m of members) assert.equal((await m.get('/tickets')).body.tickets.length, 0);
  assert.equal(t.platform('commission'), 0);
});

scenario('groups: one unverified friend holds up an ID-required activity until they verify', async (t) => {
  const { id } = await hostActivity(t, { security: 'verified' });
  const lia = await t.person('Lia', { verified: true });
  const max = await t.person('Max');
  const code = (await lia.post(`/activities/${id}/groups`)).body.code;
  await max.post(`/groups/${code}/join`);

  const view = (await lia.get(`/groups/${code}`)).body.group;
  assert.deepEqual(view.members.find((m: any) => m.user.displayName === 'Max').issues, ['Needs to verify ID']);
  assert.equal((await lia.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY })).status, 409);
  assert.equal((await lia.get('/tickets')).body.tickets.length, 0);

  await max.post('/me/verify-id', { legalName: 'Max Example', birthDate: '1990-01-01' });
  assert.equal((await lia.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY })).body.group.status, 'confirmed');
});

scenario('groups: a declined card for the leader releases the spots and charges nobody', async (t) => {
  const { id } = await hostActivity(t, { capacity: 3 });
  const { leader, code } = await formGroup(t, id, ['Lia', 'Max']);
  assert.equal((await leader.post(`/groups/${code}/lock`, { payMode: 'leader', ...DECLINE })).status, 402);
  assert.equal((await leader.get(`/groups/${code}`)).body.group.status, 'open');
  assert.equal(await spotsLeft(t, id), 3);
  assert.equal((await leader.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY })).body.group.status, 'confirmed');
});

scenario('groups: splitting the bill holds the spots until everyone has paid', async (t) => {
  const { host, id } = await hostActivity(t, { capacity: 3, priceCents: 1000 });
  const { leader, friends, members, code } = await formGroup(t, id, ['Lia', 'Max', 'Noa']);
  const outsider = await t.person('Olo');

  const locked = await leader.post(`/groups/${code}/lock`, { payMode: 'split' });
  assert.equal(locked.body.group.status, 'holding');
  assert.equal(await spotsLeft(t, id), 0, 'the held spots are off the market');
  assert.equal((await outsider.post(`/activities/${id}/join`, PAY)).status, 409);

  assert.equal((await leader.post(`/groups/${code}/pay`, PAY)).body.group.status, 'holding');
  assert.equal((await leader.post(`/groups/${code}/pay`, PAY)).status, 409, 'cannot pay twice');
  assert.equal((await friends[0].post(`/groups/${code}/pay`, DECLINE)).status, 402);
  assert.equal((await friends[0].post(`/groups/${code}/pay`, PAY)).body.group.status, 'holding');
  assert.equal((await leader.get('/tickets')).body.tickets.length, 0, 'no tickets until everyone has paid');
  assert.equal(t.platform('commission'), 0);

  const last = await friends[1].post(`/groups/${code}/pay`, PAY);
  assert.equal(last.body.group.status, 'confirmed');
  for (const m of members) assert.equal((await m.get('/tickets')).body.tickets.length, 1);
  assert.equal(t.platform('commission'), 150);
  assert.equal((await host.get('/wallet')).body.wallet.pendingCents, 2850);
  const shares = [...t.payments.charges.values()].filter((c) => c.amountCents === 1000);
  assert.deepEqual(shares.map((c) => c.status), ['captured', 'captured', 'captured']);
});

scenario('groups: if someone never pays, the hold runs out and nobody is charged', async (t) => {
  const { id } = await hostActivity(t, { capacity: 2 });
  const { leader, friends, code } = await formGroup(t, id, ['Lia', 'Max']);
  await leader.post(`/groups/${code}/lock`, { payMode: 'split' });
  await leader.post(`/groups/${code}/pay`, PAY);
  assert.equal(await spotsLeft(t, id), 0);

  t.advance(11 * MINUTE);
  assert.equal(await spotsLeft(t, id), 2, 'spots are back the moment the hold lapses');
  assert.equal((await friends[0].post(`/groups/${code}/pay`, PAY)).status, 409);

  const view = (await leader.get(`/groups/${code}`)).body.group;
  assert.equal(view.status, 'open');
  assert.equal(view.members.every((m: any) => !m.paid), true);
  const share = [...t.payments.charges.values()].find((c) => c.amountCents === 1000);
  assert.equal(share?.status, 'voided');
  assert.equal((await leader.get('/tickets')).body.tickets.length, 0);

  // They can simply try again.
  await leader.post(`/groups/${code}/lock`, { payMode: 'split' });
  await leader.post(`/groups/${code}/pay`, PAY);
  assert.equal((await friends[0].post(`/groups/${code}/pay`, PAY)).body.group.status, 'confirmed');
});

scenario('groups: free activities confirm the whole group at once', async (t) => {
  const { id } = await hostActivity(t, { priceCents: 0, capacity: 4 });
  const { leader, code } = await formGroup(t, id, ['Lia', 'Max', 'Noa']);
  assert.equal((await leader.post(`/groups/${code}/lock`)).body.group.status, 'confirmed');
  assert.equal(await spotsLeft(t, id), 1);
});

scenario('groups: membership rules', async (t) => {
  const { host, id } = await hostActivity(t, {}, 'Hana');
  const { leader, friends, code } = await formGroup(t, id, ['Lia', 'Max']);

  assert.equal((await leader.post(`/activities/${id}/groups`)).body.code, code, 'asking again returns the same group');
  assert.equal((await host.post(`/groups/${code}/join`)).status, 409, 'the host cannot join a group');
  assert.equal((await friends[0].post(`/activities/${id}/join`, PAY)).status, 409, 'group members get in together, not solo');
  assert.equal((await friends[0].post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY })).status, 403, 'only the leader locks in');
  assert.equal((await leader.post(`/groups/${code}/lock`, { payMode: 'leader', ...PAY, ...{} })).status, 200);

  // A lone leader cannot "party up" with themselves.
  const solo = await t.person('Sol');
  const soloCode = (await solo.post(`/activities/${id}/groups`)).body.code;
  assert.equal((await solo.post(`/groups/${soloCode}/lock`, { payMode: 'leader', ...PAY })).status, 409);

  // Leaving as leader dissolves the group.
  await solo.post(`/groups/${soloCode}/leave`);
  assert.equal((await solo.get(`/groups/${soloCode}`)).body.group.status, 'cancelled');
  assert.equal((await solo.get('/groups/NOPE22')).status, 404);
});

scenario('groups: the leader can remove a member; cancelling the activity closes its groups', async (t) => {
  const { host, id } = await hostActivity(t);
  const { leader, friends, code } = await formGroup(t, id, ['Lia', 'Max', 'Noa']);
  const removed = await leader.post(`/groups/${code}/remove`, { userId: friends[1].id });
  assert.equal(removed.body.group.members.length, 2);

  await leader.post(`/groups/${code}/lock`, { payMode: 'split' });
  await leader.post(`/groups/${code}/pay`, PAY);
  await host.post(`/activities/${id}/cancel`);
  assert.equal((await leader.get(`/groups/${code}`)).body.group.status, 'cancelled');
  assert.equal([...t.payments.charges.values()].find((c) => c.amountCents === 1000)?.status, 'voided');
});

// ------------------------------------------------------------------ wallet

scenario('wallet: earnings are pending until the activity ends, then can be paid out', async (t) => {
  const { host, id } = await hostActivity(t, { priceCents: 2000 });
  await (await t.person('Ana')).post(`/activities/${id}/join`, PAY);
  await (await t.person('Ben')).post(`/activities/${id}/join`, PAY);

  let wallet = (await host.get('/wallet')).body.wallet;
  assert.deepEqual([wallet.pendingCents, wallet.availableCents], [3800, 0]);
  assert.equal((await host.post('/wallet/payout')).status, 409);

  t.advance(10 * HOUR);
  wallet = (await host.get('/wallet')).body.wallet;
  assert.deepEqual([wallet.pendingCents, wallet.availableCents], [0, 3800]);

  const payout = await host.post('/wallet/payout');
  assert.equal(payout.body.amountCents, 3800);
  assert.deepEqual([payout.body.wallet.availableCents, payout.body.wallet.paidOutCents, payout.body.wallet.earnedCents], [0, 3800, 3800]);
  assert.equal((await host.post('/wallet/payout')).status, 409);
});

// ---------------------------------------------------------------- check-in

scenario('check-in: the host ticks guests off by ticket code', async (t) => {
  const { host, id } = await hostActivity(t);
  const guest = await t.person('Gus');
  await guest.post(`/activities/${id}/join`, PAY);
  const ticket = (await guest.get('/tickets')).body.tickets[0];

  assert.equal((await guest.post('/checkin', { code: ticket.code })).status, 404, 'guests cannot check themselves in');
  const spaced = `${ticket.code.slice(0, 4)}-${ticket.code.slice(4).toLowerCase()}`;
  const first = await host.post('/checkin', { code: spaced });
  assert.equal(first.status, 200);
  assert.equal(first.body.alreadyCheckedIn, false);
  assert.equal(first.body.attendee.displayName, 'Gus');
  assert.equal((await host.post('/checkin', { code: ticket.code })).body.alreadyCheckedIn, true);

  assert.equal((await host.get('/hosting')).body.activities[0].checkedIn, 1);
  await host.post(`/activities/${id}/attendees/${ticket.id}/checkin`, { checkedIn: false });
  assert.equal((await host.get(`/activities/${id}/attendees`)).body.attendees[0].checkedInAt, null);
  assert.equal((await host.post('/checkin', { code: 'ZZZZZZZZ' })).status, 404);
});

// ----------------------------------------------------------------- the map

scenario('map: activities can be filtered by vibe, category, tags, price, time, guests and room for a group', async (t) => {
  const host = await t.person('Hana', { verified: true });
  const soon = (h: number) => new Date(t.ctx.now().getTime() + h * HOUR).toISOString();
  const make = (over: Record<string, unknown>) => host.post('/activities', t.activity(over));
  await make({ title: 'Bowling', category: 'games', vibe: 'calm', tags: ['indoor', 'beginner-friendly'], priceCents: 900, capacity: 8 });
  await make({ title: 'Tennis', category: 'sports', vibe: 'active', tags: ['outdoor'], priceCents: 600, capacity: 2, lat: 41.5 });
  await make({ title: 'Picnic', category: 'outdoors', vibe: 'calm', tags: ['outdoor'], priceCents: 0, startsAt: soon(30), endsAt: soon(32) });
  await make({ title: 'Rave', category: 'party', vibe: 'lively', tags: ['dancing'], priceCents: 2000, security: 'verified' });

  const titles = async (query: string) => (await t.anonymous().get(`/activities?${query}`)).body.activities.map((a: any) => a.title).sort();
  assert.deepEqual(await titles(''), ['Bowling', 'Picnic', 'Rave', 'Tennis']);
  assert.deepEqual(await titles('vibe=calm'), ['Bowling', 'Picnic']);
  assert.deepEqual(await titles('vibe=calm,active&category=sports,games'), ['Bowling', 'Tennis']);
  assert.deepEqual(await titles('tags=outdoor'), ['Picnic', 'Tennis']);
  assert.deepEqual(await titles('tags=indoor,beginner-friendly'), ['Bowling']);
  assert.deepEqual(await titles('free=1'), ['Picnic']);
  assert.deepEqual(await titles('maxPrice=900'), ['Bowling', 'Picnic', 'Tennis']);
  assert.deepEqual(await titles('security=verified'), ['Rave']);
  assert.deepEqual(await titles('minSpots=3'), ['Bowling', 'Picnic', 'Rave']);
  assert.deepEqual(await titles('q=bowl'), ['Bowling']);
  assert.deepEqual(await titles(`from=${soon(24)}&to=${soon(48)}`), ['Picnic']);
  assert.deepEqual(await titles(`to=${soon(12)}`), ['Bowling', 'Rave', 'Tennis']);
  assert.deepEqual(await titles('bbox=41,-75,42,-73'), ['Tennis']);
  assert.deepEqual(await titles('vibe=nonsense'), ['Bowling', 'Picnic', 'Rave', 'Tennis'], 'unknown values are ignored');
});

// -------------------------------------------------------------- admin/demo

scenario('admin: only configured admins see platform revenue', async (t) => {
  const { id } = await hostActivity(t, { featured: true, priceCents: 1000 });
  await (await t.person('Gus')).post(`/activities/${id}/join`, PAY);

  const boss = await t.person('Boss');
  assert.equal((await boss.get('/me')).body.user.isAdmin, true);
  const stats = (await boss.get('/admin/stats')).body.stats;
  assert.equal(stats.listingFeesCents, 200);
  assert.equal(stats.commissionCents, 50);
  assert.equal(stats.ticketVolumeCents, 1000);
  assert.equal(stats.ticketsSold, 1);
  assert.equal(stats.users, 3);

  assert.equal((await (await t.person('Nosy')).get('/admin/stats')).status, 403);
}, { adminEmails: ['boss@example.com'] });

scenario('demo: sample activities can be dropped on the map, and sample guests added to your own', async (t) => {
  const me = await t.person('Me', { verified: true });
  assert.equal((await t.anonymous().post('/demo/populate', { lat: 52.52, lng: 13.4 })).status, 401);
  const res = await me.post('/demo/populate', { lat: 52.52, lng: 13.4, tzOffsetMinutes: -120 });
  assert.equal(res.status, 201);
  const list = (await me.get('/activities')).body.activities;
  assert.equal(list.length, res.body.created);
  assert.ok(list.every((a: any) => Math.abs(a.lat - 52.52) < 0.05 && Math.abs(a.lng - 13.4) < 0.08), 'pins are near the chosen point');
  assert.ok(list.some((a: any) => a.spotsLeft < a.capacity), 'some already have guests');
  assert.equal((await me.post('/demo/populate', { lat: 52.52, lng: 13.4 })).status, 409, 'not twice in the same place');
  assert.equal(t.platform('commission'), 0, 'sample data does not count as revenue');

  const mine = (await me.post('/activities', t.activity({ security: 'verified', capacity: 2 }))).body.id;
  assert.equal((await me.post(`/demo/activities/${mine}/guests`)).body.added, 2);
  const attendees = (await me.get(`/activities/${mine}/attendees`)).body.attendees;
  assert.ok(attendees.every((a: any) => a.verified && a.legalName));
  assert.equal(t.platform('commission'), 100);
  assert.equal((await me.post(`/demo/activities/${mine}/guests`)).status, 409);
});

scenario('demo helpers are switched off outside demo mode', async (t) => {
  const me = await t.person('Me');
  assert.equal((await me.post('/demo/populate', { lat: 1, lng: 1 })).status, 404);
  assert.equal((await me.get('/config')).body.demoMode, false);
}, { demoMode: false });

scenario('api: unknown routes and cross-site writes are refused', async (t) => {
  const c = t.anonymous();
  assert.equal((await c.get('/nope')).status, 404);
  assert.equal((await c.get('/activities/999')).status, 404);
  assert.equal((await c.get('/activities/abc')).status, 404);
  const forged = await c.req('POST', '/auth/logout', {}, { origin: 'https://evil.example' });
  assert.equal(forged.status, 403);
  assert.equal(forged.body.error.code, 'csrf');
});
