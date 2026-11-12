import type { ActivitySummary } from '../../shared/types';

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatDateTime = (iso: string) => fullFmt.format(new Date(iso));

/** "Today", "Tomorrow", "Yesterday" or "Sat, Nov 14". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  return dayFmt.format(d);
}

/** "Today · 9:00 PM – 2:00 AM" */
export function formatWhen(a: Pick<ActivitySummary, 'startsAt' | 'endsAt'>, now = new Date()): string {
  return `${dayLabel(a.startsAt, now)} · ${formatTime(a.startsAt)} – ${formatTime(a.endsAt)}`;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export type Phase = 'upcoming' | 'live' | 'ended' | 'cancelled';

export function phaseOf(a: Pick<ActivitySummary, 'startsAt' | 'endsAt' | 'status'>, now = Date.now()): Phase {
  if (a.status === 'cancelled') return 'cancelled';
  if (Date.parse(a.endsAt) <= now) return 'ended';
  return Date.parse(a.startsAt) <= now ? 'live' : 'upcoming';
}

/** A short status line: "Happening now", "Starts in 45 min", "Ended", ... */
export function timingLabel(a: Pick<ActivitySummary, 'startsAt' | 'endsAt' | 'status'>, now = Date.now()): string {
  switch (phaseOf(a, now)) {
    case 'cancelled':
      return 'Cancelled';
    case 'ended':
      return 'Ended';
    case 'live':
      return `Happening now · ${formatDuration(Date.parse(a.endsAt) - now)} left`;
    default:
      return `Starts in ${formatDuration(Date.parse(a.startsAt) - now)}`;
  }
}

export interface LatLng {
  lat: number;
  lng: number;
}

export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

export const formatDistance = (km: number) => (km < 1 ? `${Math.max(50, Math.round(km * 20) * 50)} m` : `${km < 10 ? km.toFixed(1) : Math.round(km)} km`);

/** "ABCD2345" → "ABCD-2345", easier to read out at the door. */
export const prettyCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
