import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List, LocateFixed, Map as MapIcon, Minus, Plus, Search, SlidersHorizontal, X } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { CATEGORIES, TAGS, VIBES, type CategoryId, type TagId, type VibeId } from '../../shared/catalog';
import type { ActivitySummary } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { ActivityCard } from '../components/ActivityCard';
import { ExploreMap, type Bounds, type ExploreMapHandle, type MapView } from '../components/maps';
import { Empty, Modal, Spinner, cx } from '../components/ui';
import { distanceKm, plural, type LatLng } from '../lib/format';
import { useNow } from '../lib/use-load';

type When = 'any' | 'today' | 'tomorrow' | 'week';
type Price = 'any' | 'free' | 'max';

interface Filters {
  q: string;
  vibes: VibeId[];
  categories: CategoryId[];
  tags: TagId[];
  when: When;
  price: Price;
  maxPrice: number;
  verifiedOnly: boolean;
  groupSize: number;
}

const NO_FILTERS: Filters = { q: '', vibes: [], categories: [], tags: [], when: 'any', price: 'any', maxPrice: 20, verifiedOnly: false, groupSize: 1 };

// Remembered while the app is open, so coming back from an activity restores the same map.
const memory: { filters: Filters; view: MapView | null } = { filters: NO_FILTERS, view: null };

const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

function toQuery(f: Filters): string {
  const p = new URLSearchParams();
  const today = new Date();
  const midnight = (daysAhead: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysAhead).toISOString();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.vibes.length) p.set('vibe', f.vibes.join(','));
  if (f.categories.length) p.set('category', f.categories.join(','));
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.when === 'today') p.set('to', midnight(1));
  if (f.when === 'tomorrow') {
    p.set('from', midnight(1));
    p.set('to', midnight(2));
  }
  if (f.when === 'week') p.set('to', midnight(7));
  if (f.price === 'free') p.set('free', '1');
  if (f.price === 'max') p.set('maxPrice', String(f.maxPrice * 100));
  if (f.verifiedOnly) p.set('security', 'verified');
  if (f.groupSize > 1) p.set('minSpots', String(f.groupSize));
  return p.toString();
}

/** How many of the filters tucked away in the sheet are switched on. */
const sheetCount = (f: Filters) => f.tags.length + Number(f.when !== 'any') + Number(f.price !== 'any') + Number(f.verifiedOnly) + Number(f.groupSize > 1);

export function Explore() {
  const { config, user, toast } = useApp();
  const navigate = useNavigate();
  const now = useNow();
  const map = useRef<ExploreMapHandle>(null);

  const [filters, setFilterState] = useState(memory.filters);
  const [activities, setActivities] = useState<ActivitySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<number | null>(null);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [userPos, setUserPos] = useState<LatLng | null>(null);
  const [locating, setLocating] = useState(false);
  const [seeding, setSeeding] = useState(false);

  const setFilters = useCallback((patch: Partial<Filters>) => {
    setFilterState((f) => (memory.filters = { ...f, ...patch }));
  }, []);

  const query = toQuery(filters);
  const request = useRef(0);
  const load = useCallback(async () => {
    const mine = ++request.current;
    try {
      const res = await api<{ activities: ActivitySummary[] }>(`/activities${query ? `?${query}` : ''}`);
      if (mine !== request.current) return;
      setActivities(res.activities);
      setError(null);
    } catch (err) {
      if (mine === request.current) setError(errorMessage(err));
    }
  }, [query]);

  // Reload shortly after the filters settle, and keep spots and times fresh while the map is open.
  useEffect(() => {
    const soon = setTimeout(load, 200);
    const poll = setInterval(load, 45_000);
    return () => {
      clearTimeout(soon);
      clearInterval(poll);
    };
  }, [load, user?.id]);

  const inView = useMemo(() => {
    if (!activities) return [];
    if (!bounds) return activities;
    return activities.filter((a) => a.lat >= bounds.south && a.lat <= bounds.north && a.lng >= bounds.west && a.lng <= bounds.east);
  }, [activities, bounds]);

  const selected = activities?.find((a) => a.id === selectedId) ?? null;
  const filtered = query !== '';
  const extra = sheetCount(filters);

  function select(id: number | null) {
    setSelectedId(id);
    if (id !== null) document.getElementById(`card-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function locate() {
    if (!navigator.geolocation) return toast("This browser can't share your location.", 'error');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const pos = { lat: p.coords.latitude, lng: p.coords.longitude };
        setUserPos(pos);
        map.current?.flyTo(pos, 14);
        setLocating(false);
      },
      () => {
        toast("Couldn't get your location. Check the location permission in your browser.", 'error');
        setLocating(false);
      },
      { timeout: 8000, maximumAge: 60_000 },
    );
  }

  async function dropSamples() {
    if (!user) return navigate('/login?next=/');
    setSeeding(true);
    try {
      const c = map.current!.center();
      await post('/demo/populate', { lat: c.lat, lng: c.lng, tzOffsetMinutes: new Date().getTimezoneOffset() });
      await load();
      toast('Sample activities dropped around here.');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSeeding(false);
    }
  }

  const sampleButton = config.demoMode && !filtered && (
    <button className="btn btn--ghost" onClick={dropSamples} disabled={seeding}>
      {seeding && <Spinner />} Drop sample activities here
    </button>
  );

  let listBody;
  if (error && !activities) {
    listBody = (
      <Empty emoji="🛰️" title="The map didn't load">
        <p>{error}</p>
        <button className="btn btn--primary" onClick={load}>
          Try again
        </button>
      </Empty>
    );
  } else if (!activities) {
    listBody = (
      <div className="skeletons" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="skeleton" />
        ))}
      </div>
    );
  } else if (activities.length === 0) {
    listBody = filtered ? (
      <Empty emoji="🔍" title="Nothing matches those filters">
        <p>Loosen them up a little — or be the one who makes it happen.</p>
        <button className="btn btn--primary" onClick={() => setFilters(NO_FILTERS)}>
          Clear filters
        </button>
      </Empty>
    ) : (
      <Empty emoji="📍" title="Nothing on the map yet">
        <p>Be the first to put something on it.</p>
        <Link to="/host" className="btn btn--primary">
          Host an activity
        </Link>
        {sampleButton}
      </Empty>
    );
  } else if (inView.length === 0) {
    listBody = (
      <Empty emoji="🗺️" title="Nothing in this part of the map">
        <p>{plural(activities.length, 'activity', 'activities')} elsewhere.</p>
        <button className="btn btn--primary" onClick={() => map.current?.fit(activities)}>
          Take me there
        </button>
        {sampleButton}
      </Empty>
    );
  } else {
    listBody = (
      <ul className="cards">
        {inView.map((a) => (
          <li key={a.id} id={`card-${a.id}`}>
            <ActivityCard a={a} now={now} active={a.id === selectedId || a.id === hoverId} onHover={setHoverId} distanceKm={userPos ? distanceKm(userPos, a) : undefined} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="explore" data-view={view}>
      <section className="explore__panel" aria-label="Activities">
        <div className="explore__filters">
          <div className="searchrow">
            <label className="search">
              <Search size={18} aria-hidden />
              <input type="search" placeholder="Search activities" aria-label="Search activities" value={filters.q} onChange={(e) => setFilters({ q: e.target.value })} />
            </label>
            <button className={cx('btn btn--ghost filterbtn', extra > 0 && 'is-on')} onClick={() => setSheetOpen(true)}>
              <SlidersHorizontal size={16} aria-hidden /> Filters{extra > 0 && <b>{extra}</b>}
            </button>
          </div>
          <div className="chiprow" role="group" aria-label="Filter by vibe and category">
            {VIBES.map((v) => (
              <button key={v.id} className={cx('chip', `chip--${v.id}`, filters.vibes.includes(v.id) && 'is-on')} aria-pressed={filters.vibes.includes(v.id)} onClick={() => setFilters({ vibes: toggle(filters.vibes, v.id) })}>
                <span aria-hidden>{v.emoji}</span> {v.label}
              </button>
            ))}
            <span className="chiprow__sep" aria-hidden />
            {CATEGORIES.map((c) => (
              <button key={c.id} className={cx('chip', filters.categories.includes(c.id) && 'is-on')} aria-pressed={filters.categories.includes(c.id)} onClick={() => setFilters({ categories: toggle(filters.categories, c.id) })}>
                <span aria-hidden>{c.emoji}</span> {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="explore__list">
          {!user && (
            <div className="intro">
              <h2>Plans, on the spot.</h2>
              <p>See what's happening around you, party up with friends and get in — or put your own plans on the map and fill the room.</p>
              <div className="row">
                <Link to="/signup" className="btn btn--spot btn--sm">
                  Create an account
                </Link>
                <Link to="/login" className="btn btn--ghost btn--sm btn--onink">
                  Log in
                </Link>
              </div>
            </div>
          )}
          <div className="listhead">
            <h1>{activities ? `${plural(inView.length, 'activity', 'activities')} in this area` : 'Finding activities…'}</h1>
            {filtered && (
              <button className="link" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </button>
            )}
          </div>
          {listBody}
        </div>
      </section>

      <section className="explore__map" aria-label="Map">
        <ExploreMap
          ref={map}
          activities={activities ?? []}
          selectedId={selectedId}
          hoverId={hoverId}
          initialView={memory.view ?? { ...config.mapCenter, zoom: config.mapCenter.zoom - (window.innerWidth < 700 ? 1 : 0) }}
          userPos={userPos}
          now={now}
          onSelect={select}
          onViewChange={(v, b) => {
            memory.view = v;
            setBounds(b);
          }}
        />
        <button className="mapbtn" onClick={locate} aria-label="Go to my location" title="Go to my location">
          {locating ? <Spinner /> : <LocateFixed size={20} />}
        </button>
        {selected && (
          <div className="preview">
            <ActivityCard a={selected} now={now} distanceKm={userPos ? distanceKm(userPos, selected) : undefined} />
            <button className="iconbtn preview__close" onClick={() => setSelectedId(null)} aria-label="Close preview">
              <X size={18} />
            </button>
          </div>
        )}
      </section>

      <button className="viewtoggle" onClick={() => setView(view === 'map' ? 'list' : 'map')}>
        {view === 'map' ? (
          <>
            <List size={18} aria-hidden /> List{activities ? ` · ${inView.length}` : ''}
          </>
        ) : (
          <>
            <MapIcon size={18} aria-hidden /> Map
          </>
        )}
      </button>

      {sheetOpen && <FilterSheet filters={filters} setFilters={setFilters} count={activities?.length ?? 0} maxGroup={config.maxGroupSize} onClose={() => setSheetOpen(false)} />}
    </div>
  );
}

const WHEN_OPTIONS: { id: When; label: string }[] = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'week', label: 'Next 7 days' },
];

const PRICE_OPTIONS: { id: Price; label: string }[] = [
  { id: 'any', label: 'Any price' },
  { id: 'free', label: 'Free' },
  { id: 'max', label: 'Up to…' },
];

function FilterSheet({ filters, setFilters, count, maxGroup, onClose }: { filters: Filters; setFilters: (patch: Partial<Filters>) => void; count: number; maxGroup: number; onClose: () => void }) {
  const { money } = useApp();
  return (
    <Modal
      title="Filters"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn--ghost" onClick={() => setFilters({ ...NO_FILTERS, q: filters.q, vibes: filters.vibes, categories: filters.categories })}>
            Reset
          </button>
          <button className="btn btn--primary" onClick={onClose}>
            Show {plural(count, 'activity', 'activities')}
          </button>
        </>
      }
    >
      <div className="filtergroup">
        <h3>When</h3>
        <div className="segmented" role="group" aria-label="When">
          {WHEN_OPTIONS.map((o) => (
            <button key={o.id} className={cx(filters.when === o.id && 'is-on')} aria-pressed={filters.when === o.id} onClick={() => setFilters({ when: o.id })}>
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="filtergroup">
        <h3>Price</h3>
        <div className="segmented" role="group" aria-label="Price">
          {PRICE_OPTIONS.map((o) => (
            <button key={o.id} className={cx(filters.price === o.id && 'is-on')} aria-pressed={filters.price === o.id} onClick={() => setFilters({ price: o.id })}>
              {o.id === 'max' && filters.price === 'max' ? `Up to ${money(filters.maxPrice * 100)}` : o.label}
            </button>
          ))}
        </div>
        {filters.price === 'max' && <input className="range" type="range" min={1} max={100} value={filters.maxPrice} aria-label="Highest price" onChange={(e) => setFilters({ maxPrice: Number(e.target.value) })} />}
      </div>

      <div className="filtergroup filtergroup--row">
        <div>
          <h3>Coming as a group?</h3>
          <p>Only show activities with room for all of you.</p>
        </div>
        <div className="stepper">
          <button onClick={() => setFilters({ groupSize: Math.max(1, filters.groupSize - 1) })} disabled={filters.groupSize <= 1} aria-label="Fewer people">
            <Minus size={16} />
          </button>
          <output aria-live="polite">{plural(filters.groupSize, 'person', 'people')}</output>
          <button onClick={() => setFilters({ groupSize: Math.min(maxGroup, filters.groupSize + 1) })} disabled={filters.groupSize >= maxGroup} aria-label="More people">
            <Plus size={16} />
          </button>
        </div>
      </div>

      <label className="filtergroup filtergroup--row switchrow">
        <div>
          <h3>ID-verified guests only</h3>
          <p>Activities where everyone has scanned their ID.</p>
        </div>
        <input type="checkbox" className="switch" checked={filters.verifiedOnly} onChange={(e) => setFilters({ verifiedOnly: e.target.checked })} />
      </label>

      <div className="filtergroup">
        <h3>What it's like</h3>
        <div className="chipwrap">
          {TAGS.map((t) => (
            <button key={t.id} className={cx('chip', filters.tags.includes(t.id) && 'is-on')} aria-pressed={filters.tags.includes(t.id)} onClick={() => setFilters({ tags: toggle(filters.tags, t.id) })}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}
