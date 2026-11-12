import { randomUUID } from 'node:crypto';
import type { PaymentMethodOption } from '../shared/types';

export type ChargeResult = { ok: true; ref: string } | { ok: false; message: string };

export interface AuthorizeRequest {
  amountCents: number;
  currency: string;
  /** Identifier of the payment method the payer picked. */
  method: string;
  description: string;
}

/**
 * The seam where a real payment processor plugs in.
 *
 * The flow is authorize → capture so a group's shares can be collected one by
 * one and only taken once everybody has paid. With Stripe this maps onto a
 * PaymentIntent with `capture_method: "manual"`; host payouts map onto Connect.
 */
export interface PaymentProvider {
  readonly name: string;
  /** Payment methods offered at checkout. */
  methods(): PaymentMethodOption[];
  /** Reserve the amount on the payer's method without taking it yet. */
  authorize(req: AuthorizeRequest): Promise<ChargeResult>;
  /** Take a previously authorized amount. */
  capture(ref: string): Promise<void>;
  /** Release an authorization that was never captured. */
  void(ref: string): Promise<void>;
  /** Return part or all of a captured payment. */
  refund(ref: string, amountCents: number): Promise<void>;
}

/**
 * Simulated processor: no real money moves. It only keeps enough state to
 * behave like a real one (and to let the tests check what was charged).
 */
export class DemoPaymentProvider implements PaymentProvider {
  readonly name = 'demo';
  readonly charges = new Map<string, { amountCents: number; status: 'authorized' | 'captured' | 'voided'; refundedCents: number }>();

  methods(): PaymentMethodOption[] {
    return [
      { id: 'demo_card_ok', label: 'Demo card •••• 4242', hint: 'Always approved' },
      { id: 'demo_card_declined', label: 'Demo card •••• 0002', hint: 'Always declined' },
    ];
  }

  async authorize(req: AuthorizeRequest): Promise<ChargeResult> {
    if (req.method === 'demo_card_declined') {
      return { ok: false, message: 'Your card was declined. Try another payment method.' };
    }
    if (req.method !== 'demo_card_ok') {
      return { ok: false, message: 'Choose a payment method.' };
    }
    const ref = `demo_${randomUUID()}`;
    this.charges.set(ref, { amountCents: req.amountCents, status: 'authorized', refundedCents: 0 });
    return { ok: true, ref };
  }

  async capture(ref: string): Promise<void> {
    const c = this.mustGet(ref);
    if (c.status !== 'authorized') throw new Error(`Cannot capture a ${c.status} payment`);
    c.status = 'captured';
  }

  async void(ref: string): Promise<void> {
    const c = this.charges.get(ref);
    if (!c) return; // forgotten after a restart — nothing was ever taken
    if (c.status === 'captured') throw new Error('Cannot void a captured payment');
    c.status = 'voided';
  }

  async refund(ref: string, amountCents: number): Promise<void> {
    const c = this.mustGet(ref);
    if (c.status !== 'captured') throw new Error(`Cannot refund a ${c.status} payment`);
    if (c.refundedCents + amountCents > c.amountCents) throw new Error('Refund exceeds the amount paid');
    c.refundedCents += amountCents;
  }

  private mustGet(ref: string) {
    const c = this.charges.get(ref);
    // After a restart the in-memory record is gone; treat it as a captured charge
    // so refunds of earlier demo purchases still go through.
    if (!c) {
      const fresh = { amountCents: Number.MAX_SAFE_INTEGER, status: 'captured' as const, refundedCents: 0 };
      this.charges.set(ref, fresh);
      return fresh;
    }
    return c;
  }
}
