import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Time-based one-time passwords (RFC 6238), the kind every authenticator app speaks:
// HMAC-SHA1, a new 6-digit code every 30 seconds.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of text.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | BASE32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateSecret = (): string => base32Encode(randomBytes(20));

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / STEP_SECONDS);

/** The 6-digit code for one 30-second step. */
export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const number = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(number % 1_000_000).padStart(6, '0');
}

/**
 * Check a code against the current step and its neighbours (phones' clocks drift).
 * Returns the step it matched, or null. A step at or before `lastStep` is refused,
 * so a code that was just used — or seen over someone's shoulder — can't be replayed.
 */
export function verifyTotp(secret: string, code: string, nowMs: number, lastStep = 0): number | null {
  const given = Buffer.from(code.replace(/\D/g, ''));
  if (given.length !== 6) return null;
  const current = stepAt(nowMs);
  for (const step of [current, current - 1, current + 1]) {
    if (step > lastStep && timingSafeEqual(given, Buffer.from(totpAt(secret, step)))) return step;
  }
  return null;
}

/** The link an authenticator app reads from the set-up QR code. */
export function otpauthUri(secret: string, account: string, issuer = 'OTS'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
