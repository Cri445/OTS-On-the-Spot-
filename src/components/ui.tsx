import { useEffect, useId, useRef, type ReactNode } from 'react';
import { BadgeCheck, LoaderCircle, ShieldCheck, X } from 'lucide-react';
import { categoryOf, tagLabel, vibeOf } from '../../shared/catalog';
import type { ActivitySummary } from '../../shared/types';
import { plural } from '../lib/format';

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function Avatar({ name, color, size = 36 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <LoaderCircle size={18} />
    </span>
  );
}

export function VerifiedBadge({ children = 'ID verified' }: { children?: ReactNode }) {
  return (
    <span className="verified">
      <BadgeCheck size={14} aria-hidden /> {children}
    </span>
  );
}

export function VibeChip({ vibe }: { vibe: string }) {
  const v = vibeOf(vibe);
  return (
    <span className={`tag tag--${v.id}`}>
      <span aria-hidden>{v.emoji}</span> {v.label}
    </span>
  );
}

/** The little row of labels that describes an activity at a glance. */
export function ActivityTags({ a, max = 3 }: { a: ActivitySummary; max?: number }) {
  return (
    <div className="tags">
      <VibeChip vibe={a.vibe} />
      {a.security === 'verified' && (
        <span className="tag tag--secure">
          <ShieldCheck size={13} aria-hidden /> ID only
        </span>
      )}
      {a.tags.slice(0, max).map((t) => (
        <span key={t} className="tag">
          {tagLabel(t)}
        </span>
      ))}
    </div>
  );
}

export function CategoryIcon({ a, size = 'md' }: { a: Pick<ActivitySummary, 'category' | 'vibe'>; size?: 'md' | 'lg' }) {
  return (
    <span className={`caticon caticon--${a.vibe} caticon--${size}`} aria-hidden>
      {categoryOf(a.category).emoji}
    </span>
  );
}

export function SpotsBar({ a }: { a: Pick<ActivitySummary, 'capacity' | 'spotsLeft'> }) {
  const taken = a.capacity - a.spotsLeft;
  const pct = Math.round((taken / a.capacity) * 100);
  const label = a.spotsLeft === 0 ? 'Full' : a.spotsLeft <= 3 ? `Only ${plural(a.spotsLeft, 'spot')} left` : `${plural(a.spotsLeft, 'spot')} left`;
  return (
    <div className={cx('spots', a.spotsLeft === 0 && 'is-full', a.spotsLeft > 0 && a.spotsLeft <= 3 && 'is-low')}>
      <div className="spots__bar" role="img" aria-label={`${taken} of ${a.capacity} spots taken`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="spots__label">{label}</span>
    </div>
  );
}

export function Empty({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__emoji" aria-hidden>
        {emoji}
      </div>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/** Standard "still loading / failed to load" body for a page. */
export function LoadState({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) {
  if (error) {
    return (
      <Empty emoji="🛰️" title="That didn't load">
        <p>{error}</p>
        <button className="btn btn--primary" onClick={onRetry}>
          Try again
        </button>
      </Empty>
    );
  }
  if (loading) {
    return (
      <div className="page-loading">
        <Spinner />
      </div>
    );
  }
  return null;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'spot' | 'ink' }) {
  return (
    <div className={cx('stat', tone && `stat--${tone}`)}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">{value}</div>
      {hint && <div className="stat__hint">{hint}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close.current();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('no-scroll');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('no-scroll');
      previous?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={panel}>
        <header className="modal__head">
          <h2 id={titleId}>{title}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** Shown wherever money or ID checks are simulated, so nobody mistakes the demo for the real thing. */
export function DemoNote({ children }: { children: ReactNode }) {
  return (
    <p className="demo-note">
      <strong>Demo mode.</strong> {children}
    </p>
  );
}
