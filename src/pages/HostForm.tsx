import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, EyeOff, LocateFixed, Lock, Minus, Plus, Search, ShieldCheck, Star, Users } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { CATEGORIES, TAGS, VIBES, categoryOf, type CategoryId, type TagId, type VibeId } from '../../shared/catalog';
import { commissionCents } from '../../shared/money';
import type { ActivityDetail, Photo, Security } from '../../shared/types';
import { api, errorMessage, post } from '../api';
import { useApp } from '../app-context';
import { PinMap } from '../components/maps';
import { PaymentSheet } from '../components/PaymentSheet';
import { MAX_PHOTOS, PhotoPicker } from '../components/Photos';
import { LoadState, Spinner, VibeChip, cx } from '../components/ui';
import { dayLabel, formatTime, plural, type LatLng } from '../lib/format';
import { reverseGeocode, searchAddress, type Place } from '../lib/geocode';

interface Draft {
  title: string;
  description: string;
  category: CategoryId | '';
  vibe: VibeId | '';
  tags: TagId[];
  date: string;
  time: string;
  durationMin: number;
  pos: LatLng | null;
  address: string;
  hideExact: boolean;
  capacity: number;
  price: string;
  security: Security;
  minAge: number | null;
  photos: Photo[];
  featured: boolean;
}

const DURATIONS = [30, 60, 90, 120, 180, 240, 300, 360, 480, 720];
const AGE_PRESETS = [16, 18, 21];
const durationLabel = (min: number) => (min < 60 ? `${min} minutes` : min % 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : plural(min / 60, 'hour'));

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

function blankDraft(): Draft {
  // Default to the next half hour that's at least an hour away.
  const half = 30 * 60_000;
  const start = new Date(Math.ceil((Date.now() + 60 * 60_000) / half) * half);
  return {
    title: '', description: '', category: '', vibe: '', tags: [],
    date: localDate(start), time: localTime(start), durationMin: 120,
    pos: null, address: '', hideExact: false,
    capacity: 10, price: '', security: 'open', minAge: null, photos: [], featured: false,
  };
}

function draftFrom(a: ActivityDetail): Draft {
  const start = new Date(a.startsAt);
  return {
    title: a.title, description: a.description, category: a.category, vibe: a.vibe, tags: a.tags,
    date: localDate(start), time: localTime(start), durationMin: Math.round((Date.parse(a.endsAt) - start.getTime()) / 60_000),
    pos: { lat: a.lat, lng: a.lng }, address: a.address ?? '', hideExact: a.hideExact,
    capacity: a.capacity, price: a.priceCents ? (a.priceCents / 100).toFixed(2) : '', security: a.security, minAge: a.minAge, photos: a.photos, featured: a.featured,
  };
}

/** "12", "12.5" or "12,50" → cents. Empty means free. Returns null when it isn't a number. */
function parsePrice(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (t === '') return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
}

/** Host a new activity, or edit one you already host. */
export function HostForm() {
  const params = useParams();
  const editId = params.id ? Number(params.id) : null;
  const { config, money, toast } = useApp();
  const navigate = useNavigate();
  const [d, setDraft] = useState<Draft>(blankDraft);
  const [original, setOriginal] = useState<ActivityDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paying, setPaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [customAge, setCustomAge] = useState(false);
  const set = (patch: Partial<Draft>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
    setError(null);
  };

  useEffect(() => {
    if (editId === null) return;
    api<{ activity: ActivityDetail }>(`/activities/${editId}`)
      .then(({ activity }) => {
        if (!activity.viewer.isHost) return setLoadError('Only the host can edit this activity.');
        setOriginal(activity);
        setDraft(draftFrom(activity));
        setCustomAge(activity.minAge !== null && !AGE_PRESETS.includes(activity.minAge));
      })
      .catch((err) => setLoadError(errorMessage(err)));
  }, [editId]);

  // Once guests have joined they've agreed to this time, place and price, so those can no longer change.
  const locked = original !== null && original.capacity - original.spotsLeft > 0;
  const priceCents = parsePrice(d.price);
  const fee = priceCents ? commissionCents(priceCents, config.commissionBps) : 0;
  const start = new Date(`${d.date}T${d.time}`);
  const startValid = !Number.isNaN(start.getTime());
  const listingFee = d.featured ? config.listingFeeCents.featured : config.listingFeeCents.standard;

  // ---- Where: address search, map pin, current location ----
  const [query, setQuery] = useState('');
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [searching, setSearching] = useState(false);
  const addressIsAuto = useRef(true);

  async function runSearch(e: { preventDefault(): void }) {
    e.preventDefault();
    if (query.trim().length < 3) return;
    setSearching(true);
    try {
      setPlaces(await searchAddress(config.geocoderUrl, query));
    } catch {
      setPlaces([]);
    } finally {
      setSearching(false);
    }
  }

  function choosePlace(p: Place) {
    addressIsAuto.current = true;
    set({ pos: { lat: p.lat, lng: p.lng }, address: p.label.split(', ').slice(0, 3).join(', ') });
    setPlaces(null);
    setQuery('');
  }

  async function pickOnMap(pos: LatLng) {
    set({ pos });
    // Fill in the address for them, unless they've typed their own.
    if (!addressIsAuto.current && d.address.trim()) return;
    const found = await reverseGeocode(config.geocoderUrl, pos.lat, pos.lng);
    if (found && addressIsAuto.current) set({ address: found });
  }

  function useMyLocation() {
    navigator.geolocation?.getCurrentPosition(
      (p) => void pickOnMap({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => toast("Couldn't get your location. Drop the pin by hand instead.", 'error'),
      { timeout: 8000 },
    );
  }

  // ---- Submit ----
  function validate(): string | null {
    if (d.title.trim().length < 3) return 'Give your activity a title.';
    if (!d.category) return 'Pick a category.';
    if (!d.vibe) return 'Pick a vibe: calm, lively or active.';
    if (!startValid) return 'Pick a date and a start time.';
    if (!locked && start.getTime() < Date.now() - 10 * 60_000) return 'The start time is in the past.';
    if (!d.pos) return 'Drop a pin on the map so people can find you.';
    if (d.address.trim().length < 3) return 'Add an address or a meeting point.';
    if (priceCents === null) return 'Enter the price as a number, like 12 or 12.50.';
    if (priceCents !== 0 && (priceCents < config.minPriceCents || priceCents > config.maxPriceCents)) {
      return `Make it free, or charge between ${money(config.minPriceCents)} and ${money(config.maxPriceCents)}.`;
    }
    if (customAge && (d.minAge === null || d.minAge < config.minAccountAge || d.minAge > 99)) {
      return `Set the age limit to ${config.minAccountAge} or more — or choose "No limit".`;
    }
    return null;
  }

  function body() {
    const always = { title: d.title.trim(), description: d.description.trim(), category: d.category, vibe: d.vibe, tags: d.tags, capacity: d.capacity, photos: d.photos.map((p) => p.id) };
    if (locked) return always;
    return {
      ...always,
      lat: d.pos!.lat,
      lng: d.pos!.lng,
      address: d.address.trim(),
      hideExact: d.hideExact,
      startsAt: start.toISOString(),
      endsAt: new Date(start.getTime() + d.durationMin * 60_000).toISOString(),
      priceCents,
      security: d.security,
      minAge: d.minAge,
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const problem = validate();
    setError(problem);
    if (problem) return;
    if (editId === null) return setPaying(true);
    setSaving(true);
    try {
      await api(`/activities/${editId}`, { method: 'PATCH', body: body() });
      toast('Changes saved.');
      navigate(`/a/${editId}`);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function publish(paymentMethod: string) {
    const res = await post<{ id: number }>('/activities', { ...body(), featured: d.featured, paymentMethod });
    toast("You're on the map! 📍");
    navigate(`/a/${res.id}`);
  }

  if (editId !== null && !original) {
    return (
      <div className="page">
        <LoadState loading={!loadError} error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );
  }

  const category = d.category ? categoryOf(d.category) : null;
  const ages = AGE_PRESETS.filter((age) => age >= config.minAccountAge);
  const durations = DURATIONS.includes(d.durationMin) ? DURATIONS : [...DURATIONS, d.durationMin].sort((a, b) => a - b);

  return (
    <div className="page page--wide">
      <div className="pagebar">
        <Link to={editId ? `/a/${editId}` : '/'} className="backlink">
          <ArrowLeft size={18} aria-hidden /> {editId ? 'Activity' : 'Map'}
        </Link>
      </div>
      <h1 className="pagetitle">{editId ? 'Edit your activity' : 'Host an activity'}</h1>
      {!editId && <p className="lede">Short on people? Put your plans on the map and let them come to you.</p>}
      {locked && (
        <div className="callout">
          <Lock size={18} aria-hidden />
          <div>
            <strong>Guests have already joined</strong>
            <p>They signed up for this time, place, price and guest rules, so those are locked. You can still change the description, the photos, the tags and the number of spots.</p>
          </div>
        </div>
      )}

      <form className="hostform" onSubmit={submit} noValidate>
        <div className="hostform__main">
          <section className="card">
            <h2>What are you doing?</h2>
            <label className="field">
              <span>Title</span>
              <input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} maxLength={80} placeholder="Rooftop party — need 15 more!" />
            </label>
            <div className="field">
              <span id="cat-label">Category</span>
              <div className="tiles" role="radiogroup" aria-labelledby="cat-label">
                {CATEGORIES.map((c) => (
                  <button type="button" key={c.id} role="radio" aria-checked={d.category === c.id} className={cx('tile', d.category === c.id && 'is-on')} onClick={() => set({ category: c.id })}>
                    <span aria-hidden>{c.emoji}</span>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <label className="field">
              <span>
                Description <small>optional</small>
              </span>
              <textarea className="input" rows={4} value={d.description} onChange={(e) => set({ description: e.target.value })} maxLength={2000} placeholder="What's the plan, what should people bring, who is it for?" />
            </label>
          </section>

          <section className="card">
            <h2>
              Photos <small>optional · free</small>
            </h2>
            <p className="muted">Show people the place. The first photo is the cover — it leads your page and shows in the list on the map. Up to {MAX_PHOTOS}, and you can change them any time.</p>
            <PhotoPicker photos={d.photos} onChange={(photos) => set({ photos })} />
          </section>

          <section className="card">
            <h2>What's the vibe?</h2>
            <p className="muted">People filter the map by this, so they find what they're in the mood for.</p>
            <div className="vibes" role="radiogroup" aria-label="Vibe">
              {VIBES.map((v) => (
                <button type="button" key={v.id} role="radio" aria-checked={d.vibe === v.id} className={cx('vibe', `vibe--${v.id}`, d.vibe === v.id && 'is-on')} onClick={() => set({ vibe: v.id })}>
                  <span className="vibe__emoji" aria-hidden>
                    {v.emoji}
                  </span>
                  <strong>{v.label}</strong>
                  <span>{v.blurb}</span>
                </button>
              ))}
            </div>
            <div className="field">
              <span>
                Describe it <small>pick up to 8</small>
              </span>
              <div className="chipwrap">
                {TAGS.map((t) => {
                  const on = d.tags.includes(t.id);
                  return (
                    <button type="button" key={t.id} className={cx('chip', on && 'is-on')} aria-pressed={on} disabled={!on && d.tags.length >= 8} onClick={() => set({ tags: on ? d.tags.filter((x) => x !== t.id) : [...d.tags, t.id] })}>
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <section className="card">
            <h2>When?</h2>
            <div className="grid3">
              <label className="field">
                <span>Date</span>
                <input className="input" type="date" value={d.date} min={localDate(new Date())} onChange={(e) => set({ date: e.target.value })} disabled={locked} />
              </label>
              <label className="field">
                <span>Starts</span>
                <input className="input" type="time" value={d.time} onChange={(e) => set({ time: e.target.value })} disabled={locked} />
              </label>
              <label className="field">
                <span>Lasts</span>
                <select className="input" value={d.durationMin} onChange={(e) => set({ durationMin: Number(e.target.value) })} disabled={locked}>
                  {durations.map((m) => (
                    <option key={m} value={m}>
                      {durationLabel(m)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </section>

          <section className="card">
            <h2>Where?</h2>
            {!locked && (
              <>
                <p className="muted">Search for an address, or click the map to drop the pin. Drag the pin to fine-tune.</p>
                <div className="placesearch">
                  <div className="searchrow" role="search">
                    <label className="search">
                      <Search size={18} aria-hidden />
                      <input
                        type="search"
                        placeholder="Search for an address or place"
                        aria-label="Search for an address or place"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void runSearch(e);
                        }}
                      />
                    </label>
                    <button type="button" className="btn btn--ghost" onClick={runSearch} disabled={searching}>
                      {searching ? <Spinner /> : 'Search'}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={useMyLocation} title="Use my current location" aria-label="Use my current location">
                      <LocateFixed size={18} />
                    </button>
                  </div>
                  {places && (
                    <ul className="places">
                      {places.length === 0 && <li className="muted">No matches. Try a different search, or drop the pin by hand.</li>}
                      {places.map((p) => (
                        <li key={`${p.lat},${p.lng}`}>
                          <button type="button" onClick={() => choosePlace(p)}>
                            {p.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
            <PinMap pos={d.pos} onPick={locked ? undefined : pickOnMap} className="map-canvas--picker" />
            <label className="field">
              <span>Address or meeting point</span>
              <input
                className="input"
                value={d.address}
                onChange={(e) => {
                  addressIsAuto.current = e.target.value.trim() === '';
                  set({ address: e.target.value });
                }}
                maxLength={200}
                placeholder="12 Mercer St, 4th floor — ring “Maya”"
                disabled={locked}
              />
            </label>
            <label className="checkrow">
              <input type="checkbox" checked={d.hideExact} onChange={(e) => set({ hideExact: e.target.checked })} disabled={locked} />
              <span>
                <strong>
                  <EyeOff size={15} aria-hidden /> Keep the exact address private
                </strong>
                <small>The map shows the rough area only. Guests get the address once they've joined. Good for house parties.</small>
              </span>
            </label>
          </section>

          <section className="card">
            <h2>Guests & price</h2>
            <div className="grid2">
              <div className="field">
                <span id="cap-label">Spots for guests</span>
                <div className="stepper stepper--wide" role="group" aria-labelledby="cap-label">
                  <button type="button" onClick={() => set({ capacity: Math.max(1, d.capacity - 1) })} disabled={d.capacity <= 1} aria-label="Fewer spots">
                    <Minus size={16} />
                  </button>
                  <input className="stepper__input" type="number" min={1} max={500} value={d.capacity} aria-labelledby="cap-label" onChange={(e) => set({ capacity: Math.min(500, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} />
                  <button type="button" onClick={() => set({ capacity: Math.min(500, d.capacity + 1) })} disabled={d.capacity >= 500} aria-label="More spots">
                    <Plus size={16} />
                  </button>
                </div>
              </div>
              <label className="field">
                <span>
                  Price per person <small>leave empty for free</small>
                </span>
                <div className="moneyinput">
                  <span aria-hidden>{config.currency}</span>
                  <input className="input" inputMode="decimal" value={d.price} onChange={(e) => set({ price: e.target.value })} placeholder="0" disabled={locked} />
                </div>
              </label>
            </div>
            {priceCents !== null && priceCents > 0 && (
              <ul className="breakdown" aria-label="What you earn">
                <li>
                  <span>Each guest pays</span>
                  <span>{money(priceCents)}</span>
                </li>
                <li>
                  <span>OTS keeps {config.commissionBps / 100}%</span>
                  <span>− {money(fee)}</span>
                </li>
                <li className="breakdown__total">
                  <span>You get per guest</span>
                  <span>{money(priceCents - fee)}</span>
                </li>
                <li className="muted">
                  <span>If all {plural(d.capacity, 'spot')} fill</span>
                  <span>{money((priceCents - fee) * d.capacity)}</span>
                </li>
              </ul>
            )}

            <div className="field">
              <span id="sec-label">Who can join?</span>
              <div className="choices" role="radiogroup" aria-labelledby="sec-label">
                <button type="button" role="radio" aria-checked={d.security === 'open'} className={cx('choice', d.security === 'open' && 'is-on')} onClick={() => { set({ security: 'open', minAge: null }); setCustomAge(false); }} disabled={locked}>
                  <Users size={20} aria-hidden />
                  <strong>Open</strong>
                  <span>Anyone with an OTS account can join.</span>
                </button>
                <button type="button" role="radio" aria-checked={d.security === 'verified'} className={cx('choice', d.security === 'verified' && 'is-on')} onClick={() => set({ security: 'verified' })} disabled={locked}>
                  <ShieldCheck size={20} aria-hidden />
                  <strong>ID-verified only</strong>
                  <span>Only people who've scanned their ID. You see each guest's legal name, so you know exactly who was there.</span>
                </button>
              </div>
            </div>

            <div className="field">
              <span id="age-label">
                Age limit <small>checked against each guest's scanned ID</small>
              </span>
              <div className="segmented" role="group" aria-labelledby="age-label">
                <button type="button" className={cx(d.minAge === null && !customAge && 'is-on')} aria-pressed={d.minAge === null && !customAge} disabled={locked} onClick={() => { set({ minAge: null }); setCustomAge(false); }}>
                  No limit
                </button>
                {ages.map((age) => (
                  <button type="button" key={age} className={cx(d.minAge === age && !customAge && 'is-on')} aria-pressed={d.minAge === age && !customAge} disabled={locked} onClick={() => { set({ minAge: age, security: 'verified' }); setCustomAge(false); }}>
                    {age}+
                  </button>
                ))}
                <button type="button" className={cx(customAge && 'is-on')} aria-pressed={customAge} disabled={locked} onClick={() => { set({ minAge: d.minAge ?? config.minAccountAge, security: 'verified' }); setCustomAge(true); }}>
                  Other
                </button>
              </div>
              {customAge && (
                <label className="agecustom">
                  Guests must be at least
                  <input className="input" type="number" min={config.minAccountAge} max={99} value={d.minAge ?? ''} disabled={locked} aria-label="Minimum age" onChange={(e) => set({ minAge: e.target.value === '' ? null : Math.round(Number(e.target.value)) })} />
                  years old
                </label>
              )}
              {d.minAge !== null && <p className="fineprint">Anyone younger than {d.minAge} on the day can't join — not on their own and not with a group. An age limit switches on ID-verified guests, because the ID is how the age is checked.</p>}
            </div>
          </section>
        </div>

        <aside className="hostform__side">
          <div className="card summary">
            <span className="eyebrow">Preview</span>
            <div className="summary__preview">
              {d.photos[0] ? (
                <span className="acard__thumb">
                  <img src={d.photos[0].url} alt="" />
                </span>
              ) : (
                <span className={cx('caticon', `caticon--${d.vibe || 'none'}`)} aria-hidden>
                  {category?.emoji ?? '📍'}
                </span>
              )}
              <div>
                <strong>{d.title.trim() || 'Your activity'}</strong>
                <span className="muted">{startValid ? `${dayLabel(start.toISOString())} ${formatTime(start.toISOString())} · ${durationLabel(d.durationMin)}` : 'Pick a time'}</span>
                <div className="tags">
                  {d.vibe && <VibeChip vibe={d.vibe} />}
                  <span className="tag">{priceCents ? money(priceCents) : 'Free'}</span>
                  <span className="tag">{plural(d.capacity, 'spot')}</span>
                  {d.minAge !== null && <span className="tag tag--age">{d.minAge}+</span>}
                </div>
              </div>
            </div>

            {editId === null && (
              <div className="field">
                <span id="tier-label">Put it on the map</span>
                <div className="choices choices--stack" role="radiogroup" aria-labelledby="tier-label">
                  <button type="button" role="radio" aria-checked={!d.featured} className={cx('choice choice--row', !d.featured && 'is-on')} onClick={() => set({ featured: false })}>
                    <strong>Standard · {money(config.listingFeeCents.standard)}</strong>
                    <span>A pin on the map until your activity ends.</span>
                  </button>
                  <button type="button" role="radio" aria-checked={d.featured} className={cx('choice choice--row', d.featured && 'is-on')} onClick={() => set({ featured: true })}>
                    <strong>
                      <Star size={14} fill="currentColor" aria-hidden /> Featured · {money(config.listingFeeCents.featured)}
                    </strong>
                    <span>A highlighted pin, and first in the list.</span>
                  </button>
                </div>
              </div>
            )}

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn--primary btn--block btn--lg" disabled={saving}>
              {saving && <Spinner />}
              {editId === null ? `Continue · ${money(listingFee)}` : 'Save changes'}
            </button>
            {editId === null && <p className="fineprint">You pay the listing fee once. Guests pay you the price you set, minus OTS's {config.commissionBps / 100}%.</p>}
          </div>
        </aside>
      </form>

      {paying && (
        <PaymentSheet
          title="Put it on the map"
          lines={[{ label: `${d.featured ? 'Featured' : 'Standard'} listing · ${d.title.trim()}`, cents: listingFee }]}
          confirmLabel={`Pay ${money(listingFee)} & publish`}
          onPay={publish}
          onClose={() => setPaying(false)}
        />
      )}
    </div>
  );
}
