import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import L from 'leaflet';
import { categoryOf } from '../../shared/catalog';
import type { ActivitySummary } from '../../shared/types';
import { useApp } from '../app-context';
import { phaseOf, type LatLng } from '../lib/format';

export interface MapView {
  lat: number;
  lng: number;
  zoom: number;
}

export interface Bounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface ExploreMapHandle {
  flyTo(pos: LatLng, zoom?: number): void;
  fit(points: LatLng[]): void;
  center(): LatLng;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function baseMap(el: HTMLElement, view: MapView, tileUrl: string, attribution: string, interactive = true): L.Map {
  const map = L.map(el, {
    zoomControl: false,
    scrollWheelZoom: interactive,
    dragging: interactive,
    doubleClickZoom: interactive,
    touchZoom: interactive,
    boxZoom: interactive,
    keyboard: interactive,
  }).setView([view.lat, view.lng], view.zoom);
  map.attributionControl.setPrefix(false);
  L.tileLayer(tileUrl, { attribution, maxZoom: 19 }).addTo(map);
  if (interactive) L.control.zoom({ position: 'bottomright' }).addTo(map);
  return map;
}

/** Keep Leaflet's idea of the map size in step with its container. */
function watchSize(el: HTMLElement, map: L.Map): () => void {
  const observer = new ResizeObserver(() => map.invalidateSize());
  observer.observe(el);
  return () => observer.disconnect();
}

function pinHtml(a: ActivitySummary, price: string, now: number): string {
  const classes = [
    'pin',
    `pin--${a.vibe}`,
    a.featured && 'is-featured',
    phaseOf(a, now) === 'live' && 'is-live',
    a.spotsLeft === 0 && 'is-full',
    a.approximate && 'is-approx',
  ]
    .filter(Boolean)
    .join(' ');
  return `<div class="${classes}"><span class="pin__emoji">${categoryOf(a.category).emoji}</span><span class="pin__price">${escapeHtml(price)}</span></div>`;
}

const pinIcon = (html: string) => L.divIcon({ className: 'pin-anchor', html, iconSize: [0, 0] });

interface ExploreMapProps {
  activities: ActivitySummary[];
  selectedId: number | null;
  hoverId: number | null;
  initialView: MapView;
  userPos: LatLng | null;
  now: number;
  onSelect: (id: number | null) => void;
  onViewChange: (view: MapView, bounds: Bounds) => void;
  ref?: Ref<ExploreMapHandle>;
}

/** The main map: one price pin per activity, coloured by vibe. */
export function ExploreMap({ activities, selectedId, hoverId, initialView, userPos, now, onSelect, onViewChange, ref }: ExploreMapProps) {
  const { config, money } = useApp();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const pins = useRef(new Map<number, { marker: L.Marker; html: string }>());
  const me = useRef<L.CircleMarker | null>(null);
  const handlers = useRef({ onSelect, onViewChange });
  handlers.current = { onSelect, onViewChange };

  useEffect(() => {
    const m = baseMap(el.current!, initialView, config.tileUrl, config.tileAttribution);
    map.current = m;
    const report = () => {
      const c = m.getCenter();
      const b = m.getBounds();
      handlers.current.onViewChange({ lat: c.lat, lng: c.lng, zoom: m.getZoom() }, { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });
    };
    m.on('moveend', report);
    m.on('click', () => handlers.current.onSelect(null));
    report();
    const unwatch = watchSize(el.current!, m);
    return () => {
      unwatch();
      m.remove();
      map.current = null;
      pins.current.clear();
      me.current = null;
    };
    // The map is created once; later view changes go through the imperative handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flyTo: (pos, zoom) => map.current?.flyTo([pos.lat, pos.lng], zoom ?? Math.max(map.current.getZoom(), 14), { duration: 0.8 }),
      fit: (points) => {
        if (points.length && map.current) map.current.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lng] as [number, number])), { padding: [60, 60], maxZoom: 15 });
      },
      center: () => {
        const c = map.current!.getCenter();
        return { lat: c.lat, lng: c.lng };
      },
    }),
    [],
  );

  // Add, update and remove pins as the list of activities changes.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const seen = new Set<number>();
    for (const a of activities) {
      seen.add(a.id);
      const html = pinHtml(a, a.priceCents === 0 ? 'Free' : money(a.priceCents), now);
      const existing = pins.current.get(a.id);
      if (existing) {
        existing.marker.setLatLng([a.lat, a.lng]);
        if (existing.html !== html) {
          existing.marker.setIcon(pinIcon(html));
          existing.html = html;
        }
      } else {
        const marker = L.marker([a.lat, a.lng], { icon: pinIcon(html), title: a.title, alt: a.title, riseOnHover: true });
        marker.on('click', () => handlers.current.onSelect(a.id));
        marker.on('keypress', (e) => {
          if ((e as L.LeafletKeyboardEvent).originalEvent.key === 'Enter') handlers.current.onSelect(a.id);
        });
        marker.addTo(m);
        pins.current.set(a.id, { marker, html });
      }
    }
    for (const [id, pin] of pins.current) {
      if (!seen.has(id)) {
        pin.marker.remove();
        pins.current.delete(id);
      }
    }
  }, [activities, money, now]);

  // Highlight the selected / hovered pin. Runs after the effect above, which may have rebuilt the elements.
  useEffect(() => {
    const featured = new Set(activities.filter((a) => a.featured).map((a) => a.id));
    for (const [id, pin] of pins.current) {
      const node = pin.marker.getElement();
      node?.classList.toggle('is-selected', id === selectedId);
      node?.classList.toggle('is-hover', id === hoverId);
      pin.marker.setZIndexOffset(id === selectedId ? 2000 : id === hoverId ? 1500 : featured.has(id) ? 500 : 0);
    }
  }, [activities, selectedId, hoverId, now]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    me.current?.remove();
    me.current = userPos ? L.circleMarker([userPos.lat, userPos.lng], { radius: 8, color: '#fff', weight: 3, fillColor: '#2f6fed', fillOpacity: 1, interactive: false }).addTo(m) : null;
  }, [userPos]);

  return <div ref={el} className="map-canvas" aria-label="Map of activities" />;
}

interface PinMapProps {
  pos: LatLng | null;
  /** Draw a soft circle instead of a pin: the exact spot is hidden. */
  approximate?: boolean;
  /** When given, the map is a picker: click or drag to choose the spot. */
  onPick?: (pos: LatLng) => void;
  className?: string;
}

const dotIcon = L.divIcon({ className: 'pin-anchor', html: '<div class="pin-dot"></div>', iconSize: [0, 0] });

/** A small map with a single spot on it — used to show where an activity is, and to pick where a new one will be. */
export function PinMap({ pos, approximate, onPick, className }: PinMapProps) {
  const { config } = useApp();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.Layer | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;
  const editable = Boolean(onPick);

  useEffect(() => {
    const start = pos ?? config.mapCenter;
    const m = baseMap(el.current!, { lat: start.lat, lng: start.lng, zoom: pos ? 15 : config.mapCenter.zoom }, config.tileUrl, config.tileAttribution, true);
    if (!editable) m.scrollWheelZoom.disable();
    map.current = m;
    m.on('click', (e) => pick.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    const unwatch = watchSize(el.current!, m);
    return () => {
      unwatch();
      m.remove();
      map.current = null;
      layer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    layer.current?.remove();
    layer.current = null;
    if (!pos) return;
    if (approximate) {
      layer.current = L.circle([pos.lat, pos.lng], { radius: 450, color: '#12131a', weight: 1.5, dashArray: '6 6', fillColor: '#ffd400', fillOpacity: 0.28, interactive: false }).addTo(m);
    } else {
      const marker = L.marker([pos.lat, pos.lng], { icon: dotIcon, draggable: editable, keyboard: false });
      marker.on('dragend', () => {
        const p = marker.getLatLng();
        pick.current?.({ lat: p.lat, lng: p.lng });
      });
      layer.current = marker.addTo(m);
    }
    if (!m.getBounds().pad(-0.2).contains([pos.lat, pos.lng])) m.setView([pos.lat, pos.lng], Math.max(m.getZoom(), 15));
  }, [pos?.lat, pos?.lng, approximate, editable]);

  return <div ref={el} className={`map-canvas ${className ?? ''}`} aria-label={editable ? 'Click the map to place your activity' : 'Location'} />;
}
