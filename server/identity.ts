export interface IdentityCheck {
  legalName: string;
  /** YYYY-MM-DD */
  birthDate: string;
}

export type IdentityResult = { ok: true } | { ok: false; message: string };

/**
 * The seam where a real ID-verification service plugs in (Stripe Identity,
 * Onfido, Veriff ...). Such a service scans the document, matches it to a
 * selfie and reports back the name and date of birth it read.
 */
export interface IdentityProvider {
  readonly name: string;
  verify(input: IdentityCheck, now: Date): Promise<IdentityResult>;
}

export function ageOn(birthDate: string, now: Date): number {
  const [y, m, d] = birthDate.split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  const hadBirthday = now.getUTCMonth() + 1 > m || (now.getUTCMonth() + 1 === m && now.getUTCDate() >= d);
  if (!hadBirthday) age--;
  return age;
}

/**
 * Simulated check: accepts what the person typed. No document is uploaded or
 * stored anywhere. It still enforces the one rule the platform relies on —
 * members must be adults.
 */
export class DemoIdentityProvider implements IdentityProvider {
  readonly name = 'demo';

  async verify(input: IdentityCheck, now: Date): Promise<IdentityResult> {
    const age = ageOn(input.birthDate, now);
    if (!Number.isFinite(age) || age > 120) return { ok: false, message: 'That date of birth does not look right.' };
    if (age < 18) return { ok: false, message: 'You need to be 18 or older to verify your ID on OTS.' };
    return { ok: true };
  }
}
