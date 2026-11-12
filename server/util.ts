import { randomInt } from 'node:crypto';
import type { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db';
import type { PaymentProvider } from './payments';
import type { IdentityProvider } from './identity';

/** Everything a request handler needs. Passed around instead of using globals so tests can swap parts. */
export interface Ctx {
  db: Db;
  config: Config;
  now: () => Date;
  payments: PaymentProvider;
  identity: IdentityProvider;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string = 'error',
  ) {
    super(message);
  }
}

export const iso = (d: Date): string => d.toISOString();
export const nowIso = (ctx: Ctx): string => iso(ctx.now());

// No 0/O/1/I/L — these get read aloud at the door.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** Validate a request body, turning the first problem into a readable 400. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  const custom = issue.code === 'custom' || !/^(Invalid|Too|Unrecognized)/.test(issue.message);
  throw new HttpError(400, custom ? issue.message : `${field}${issue.message}`, 'validation');
}

export function intParam(value: unknown, name = 'id'): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, `Unknown ${name}`, 'not_found');
  return n;
}
