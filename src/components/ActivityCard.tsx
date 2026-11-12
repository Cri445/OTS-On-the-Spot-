import { Star } from 'lucide-react';
import { Link } from 'react-router';
import type { ActivitySummary } from '../../shared/types';
import { useApp } from '../app-context';
import { dayLabel, formatDistance, formatDuration, formatTime, phaseOf } from '../lib/format';
import { categoryOf } from '../../shared/catalog';
import { ActivityTags, CategoryIcon, SpotsBar, cx } from './ui';

interface Props {
  a: ActivitySummary;
  now: number;
  distanceKm?: number;
  active?: boolean;
  onHover?: (id: number | null) => void;
}

/** "Happening now · 2 h left", "Today 9:00 PM · in 45 min", "Sat, Nov 14 · 7:00 PM" */
export function whenLine(a: ActivitySummary, now: number): { live: boolean; text: string } {
  const phase = phaseOf(a, now);
  if (phase === 'live') return { live: true, text: `Happening now · ${formatDuration(Date.parse(a.endsAt) - now)} left` };
  if (phase === 'ended') return { live: false, text: `Ended · ${dayLabel(a.startsAt, new Date(now))}` };
  if (phase === 'cancelled') return { live: false, text: 'Cancelled' };
  const until = Date.parse(a.startsAt) - now;
  const soon = until < 3 * 3_600_000 ? ` · in ${formatDuration(until)}` : '';
  return { live: false, text: `${dayLabel(a.startsAt, new Date(now))} ${formatTime(a.startsAt)}${soon}` };
}

export function ActivityCard({ a, now, distanceKm, active, onHover }: Props) {
  const { money } = useApp();
  const when = whenLine(a, now);
  return (
    <Link
      to={`/a/${a.id}`}
      className={cx('acard', active && 'is-active', a.featured && 'is-featured')}
      onMouseEnter={() => onHover?.(a.id)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(a.id)}
      onBlur={() => onHover?.(null)}
    >
      {a.coverUrl ? (
        <span className="acard__thumb">
          <img src={a.coverUrl} alt="" loading="lazy" />
          <span className="acard__emoji" aria-hidden>
            {categoryOf(a.category).emoji}
          </span>
        </span>
      ) : (
        <CategoryIcon a={a} />
      )}
      <div className="acard__body">
        <div className="acard__top">
          <h3>{a.title}</h3>
          <span className={cx('price', a.priceCents === 0 && 'price--free')}>{a.priceCents === 0 ? 'Free' : money(a.priceCents)}</span>
        </div>
        <div className="acard__when">
          {when.live && <span className="live-dot" aria-hidden />}
          <span className={cx(when.live && 'is-live')}>{when.text}</span>
          {distanceKm !== undefined && <span className="acard__dist">· {formatDistance(distanceKm)} away</span>}
        </div>
        <ActivityTags a={a} max={2} />
        <SpotsBar a={a} />
      </div>
      {a.featured && (
        <span className="acard__star" title="Featured">
          <Star size={12} fill="currentColor" aria-hidden /> Featured
        </span>
      )}
    </Link>
  );
}
