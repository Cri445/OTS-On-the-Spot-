import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Me, PublicUser } from '../shared/types';
import { imageUrl } from './images';
import { HttpError, iso, type Ctx } from './util';

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  display_name: string;
  bio: string;
  avatar_color: string;
  legal_name: string | null;
  birth_date: string | null;
  id_verified_at: string | null;
  is_demo: number;
  created_at: string;
  avatar_image: string | null;
  totp_secret: string | null;
  totp_pending: string | null;
  totp_enabled_at: string | null;
  totp_last_step: number;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
  }
}

const COOKIE = 'ots_session';
const SESSION_DAYS = 30;
const AVATAR_COLORS = ['#0e9aa7', '#7c4dff', '#ff5630', '#1f9d55', '#d6336c', '#2f6fed', '#e8890c', '#5c6ac4'];

export const pickAvatarColor = (seed: number): string => AVATAR_COLORS[seed % AVATAR_COLORS.length];

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Only a hash of the session token is stored, so a leaked database can't be used to log in.
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export function startSession(ctx: Ctx, req: Request, res: Response, userId: number): void {
  const token = randomBytes(32).toString('base64url');
  const now = ctx.now();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  ctx.db.run('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', hashToken(token), userId, iso(expires), iso(now));
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    path: '/',
    maxAge: SESSION_DAYS * 86_400_000,
  });
}

export function endSession(ctx: Ctx, req: Request, res: Response): void {
  const token = readCookie(req, COOKIE);
  if (token) ctx.db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/** Attaches req.user when the request carries a valid session cookie. */
export function sessionMiddleware(ctx: Ctx) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readCookie(req, COOKIE);
    if (token) {
      req.user = ctx.db.get<UserRow>(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
        hashToken(token),
        iso(ctx.now()),
      );
    }
    next();
  };
}

export function requireUser(req: Request): UserRow {
  if (!req.user) throw new HttpError(401, 'Log in to continue.', 'auth_required');
  return req.user;
}

export const isAdmin = (ctx: Ctx, user: UserRow): boolean => ctx.config.adminEmails.includes(user.email.toLowerCase());

export function toPublicUser(u: { id: number; display_name: string; avatar_color: string; avatar_image: string | null; id_verified_at: string | null }): PublicUser {
  return { id: u.id, displayName: u.display_name, avatarColor: u.avatar_color, avatarUrl: imageUrl(u.avatar_image), verified: Boolean(u.id_verified_at) };
}

export function toMe(ctx: Ctx, u: UserRow): Me {
  return { ...toPublicUser(u), email: u.email, bio: u.bio, legalName: u.legal_name, isAdmin: isAdmin(ctx, u), twoFactorEnabled: Boolean(u.totp_enabled_at) };
}

export const loadUser = (ctx: Ctx, id: number): UserRow => ctx.db.get<UserRow>('SELECT * FROM users WHERE id = ?', id)!;
