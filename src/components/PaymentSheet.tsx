import { useState, type ReactNode } from 'react';
import { CreditCard, Lock } from 'lucide-react';
import { errorMessage } from '../api';
import { useApp } from '../app-context';
import { DemoNote, Modal, Spinner, cx } from './ui';

interface Props {
  title: string;
  lines: { label: string; cents: number }[];
  /** Extra information shown above the button, e.g. what the host will see. */
  note?: ReactNode;
  confirmLabel?: string;
  /** Do the purchase. Reject with an Error to show its message (e.g. a declined card). */
  onPay: (paymentMethod: string) => Promise<void>;
  onClose: () => void;
}

/** The checkout: an order summary, a payment method and one button. Also used for free "purchases". */
export function PaymentSheet({ title, lines, note, confirmLabel, onPay, onClose }: Props) {
  const { config, money } = useApp();
  const total = lines.reduce((sum, l) => sum + l.cents, 0);
  const [method, setMethod] = useState(config.paymentMethods[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await onPay(method);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={busy ? () => {} : onClose}>
      <ul className="order">
        {lines.map((l, i) => (
          <li key={i}>
            <span>{l.label}</span>
            <span>{l.cents === 0 ? 'Free' : money(l.cents)}</span>
          </li>
        ))}
        <li className="order__total">
          <span>Total</span>
          <span>{total === 0 ? 'Free' : money(total)}</span>
        </li>
      </ul>

      {total > 0 && (
        <fieldset className="methods">
          <legend>Pay with</legend>
          {config.paymentMethods.map((m) => (
            <label key={m.id} className={cx('method', method === m.id && 'is-on')}>
              <input type="radio" name="payment-method" value={m.id} checked={method === m.id} onChange={() => setMethod(m.id)} />
              <CreditCard size={18} aria-hidden />
              <span className="method__label">{m.label}</span>
              <span className="method__hint">{m.hint}</span>
            </label>
          ))}
          {config.demoMode && <DemoNote>No real money moves. Pick the second card to see what a declined payment looks like.</DemoNote>}
        </fieldset>
      )}

      {note && <div className="sheet-note">{note}</div>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      <button className="btn btn--primary btn--block btn--lg" onClick={submit} disabled={busy}>
        {busy ? <Spinner label="Processing" /> : total > 0 ? <Lock size={16} aria-hidden /> : null}
        {confirmLabel ?? (total > 0 ? `Pay ${money(total)}` : 'Confirm')}
      </button>
    </Modal>
  );
}
