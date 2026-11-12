import { resolve } from 'node:path';
import { createApp } from './app';
import { loadConfig } from './config';
import { Db } from './db';
import { ensureDemoData, DEMO_EMAIL, DEMO_PASSWORD } from './demo';
import { settleExpiredHolds } from './groups';
import { DemoIdentityProvider } from './identity';
import { sweepOrphanImages } from './images';
import { DemoPaymentProvider } from './payments';
import { PENDING_TTL_MS } from './activities';
import { iso, type Ctx } from './util';

try {
  process.loadEnvFile();
} catch {
  /* no .env file — defaults apply */
}

const config = loadConfig();
const ctx: Ctx = {
  db: new Db(config.dbPath),
  config,
  now: () => new Date(),
  payments: new DemoPaymentProvider(),
  identity: new DemoIdentityProvider(),
};

await ensureDemoData(ctx);

// Housekeeping: give back group holds that ran out, and clear abandoned checkouts, old sessions and unused photos.
setInterval(() => {
  settleExpiredHolds(ctx).catch((err) => console.error('Hold sweep failed', err));
  const now = ctx.now();
  ctx.db.run(`DELETE FROM tickets WHERE status = 'pending' AND created_at <= ?`, iso(new Date(now.getTime() - PENDING_TTL_MS)));
  ctx.db.run('DELETE FROM sessions WHERE expires_at <= ?', iso(now));
  ctx.db.run('DELETE FROM login_challenges WHERE expires_at <= ?', iso(now));
  sweepOrphanImages(ctx);
}, 20_000).unref();

const app = createApp(ctx, { staticDir: resolve('dist') });
app.listen(config.port, () => {
  console.log(`OTS API listening on http://localhost:${config.port}`);
  if (config.demoMode) {
    console.log(`Demo mode: payments and ID checks are simulated. Demo login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  }
});
