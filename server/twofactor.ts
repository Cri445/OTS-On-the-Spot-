import { createHash, randomBytes } from 'node:crypto';
import { hashToken, loadUser, verifyPassword, type UserRow } from './auth';
import { DEMO_EMAIL } from './demo';
import { generateSecret, otpauthUri, verifyTotp } from './totp';
import { HttpError, iso, nowIso, randomCode, type Ctx } from './util';

/*
 * Two-step login with an authenticator app.
 *
 *   password ok ──▶ challenge (5 minutes, 5 tries) ──code ok──▶ session
 *
 * A challenge is only proof that the password was right; it cannot be used
 * for anything except finishing the login with a code.
 */

const CHALLENGE_MINUTES = 5;
const MAX_ATTEMPTS = 5;
const RECOVERY_CODES = 8;

const hashCode = (code: string): string => createHash('sha256').update(code).digest('hex');
const normalise = (code: string): string => code.replace(/[^a-z0-9]/gi, '').toUpperCase();

/** Step 1 of turning it on: make a secret for the authenticator app to scan. Nothing is active yet. */
export function beginSetup(ctx: Ctx, user: UserRow): { secret: string; uri: string } {
  if (user.totp_enabled_at) throw new HttpError(409, 'Two-step login is already on.', 'already_enabled');
  if (ctx.config.demoMode && user.email.toLowerCase() === DEMO_EMAIL) {
    throw new HttpError(403, "The shared demo account can't use two-step login — create your own account to try it.", 'demo_account');
  }
  const secret = generateSecret();
  ctx.db.run('UPDATE users SET totp_pending = ? WHERE id = ?', secret, user.id);
  return { secret, uri: otpauthUri(secret, user.email) };
}

/** Step 2: prove the app is set up by entering a code. Returns the one-time recovery codes. */
export function finishSetup(ctx: Ctx, user: UserRow, code: string): string[] {
  if (user.totp_enabled_at) throw new HttpError(409, 'Two-step login is already on.', 'already_enabled');
  if (!user.totp_pending) throw new HttpError(409, 'Start the set-up again.', 'no_setup');
  const step = verifyTotp(user.totp_pending, code, ctx.now().getTime());
  if (step === null) throw new HttpError(400, "That code isn't right. Check the app and try the newest code.", 'bad_code');

  const codes = Array.from({ length: RECOVERY_CODES }, () => randomCode(8));
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = ?, totp_last_step = ? WHERE id = ?', nowIso(ctx), step, user.id);
    ctx.db.run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
    // Like passwords, recovery codes are only stored hashed.
    for (const c of codes) ctx.db.run('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)', user.id, hashCode(c));
  });
  return codes;
}

export async function disable(ctx: Ctx, user: UserRow, password: string): Promise<void> {
  if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'That password is not right.', 'bad_credentials');
  ctx.db.tx(() => {
    ctx.db.run('UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled_at = NULL, totp_last_step = 0 WHERE id = ?', user.id);
    ctx.db.run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
    ctx.db.run('DELETE FROM login_challenges WHERE user_id = ?', user.id);
  });
}

/** The password was right and the account has two-step login: hand back a ticket for the second step. */
export function startChallenge(ctx: Ctx, userId: number): string {
  const ticket = randomBytes(32).toString('base64url');
  ctx.db.run('DELETE FROM login_challenges WHERE user_id = ? OR expires_at <= ?', userId, nowIso(ctx));
  ctx.db.run(
    'INSERT INTO login_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    hashToken(ticket), userId, iso(new Date(ctx.now().getTime() + CHALLENGE_MINUTES * 60_000)),
  );
  return ticket;
}

/** Second step: a code from the app, or one of the recovery codes. Returns the user to log in. */
export function completeChallenge(ctx: Ctx, ticket: string, rawCode: string): UserRow {
  const key = hashToken(ticket);
  const challenge = ctx.db.get<{ user_id: number; attempts: number }>('SELECT user_id, attempts FROM login_challenges WHERE token_hash = ? AND expires_at > ?', key, nowIso(ctx));
  if (!challenge) throw new HttpError(401, 'That login attempt has expired. Enter your password again.', 'challenge_expired');
  if (challenge.attempts >= MAX_ATTEMPTS) {
    ctx.db.run('DELETE FROM login_challenges WHERE token_hash = ?', key);
    throw new HttpError(401, 'Too many wrong codes. Enter your password again.', 'challenge_expired');
  }

  const user = loadUser(ctx, challenge.user_id);
  const code = normalise(rawCode);
  let ok = false;
  if (/^\d{6}$/.test(code) && user.totp_secret) {
    const step = verifyTotp(user.totp_secret, code, ctx.now().getTime(), user.totp_last_step);
    if (step !== null) {
      ctx.db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, user.id);
      ok = true;
    }
  } else if (code.length === 8) {
    // A recovery code works once.
    ok = ctx.db.run('DELETE FROM recovery_codes WHERE user_id = ? AND code_hash = ?', user.id, hashCode(code)).changes === 1;
  }

  if (!ok) {
    ctx.db.run('UPDATE login_challenges SET attempts = attempts + 1 WHERE token_hash = ?', key);
    throw new HttpError(401, "That code isn't right.", 'bad_code');
  }
  ctx.db.run('DELETE FROM login_challenges WHERE token_hash = ?', key);
  return user;
}

export const recoveryCodesLeft = (ctx: Ctx, userId: number): number => ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ?', userId)!.n;
