// Address lookup through a Nominatim-compatible service (OpenStreetMap by default).
// It is a convenience only: if the service is unreachable, hosts can still drop a pin by hand.

export interface Place {
  label: string;
  lat: number;
  lng: number;
}

export async function searchAddress(baseUrl: string, query: string, signal?: AbortSignal): Promise<Place[]> {
  if (!baseUrl || query.trim().length < 3) return [];
  const url = `${baseUrl}/search?format=jsonv2&limit=5&q=${encodeURIComponent(query.trim())}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
  return rows.map((r) => ({ label: r.display_name, lat: Number(r.lat), lng: Number(r.lon) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export async function reverseGeocode(baseUrl: string, lat: number, lng: number, signal?: AbortSignal): Promise<string | null> {
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`, { signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const row = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    const a = row.address;
    if (a) {
      const street = [a.house_number, a.road ?? a.pedestrian ?? a.footway].filter(Boolean).join(' ');
      const area = a.suburb ?? a.neighbourhood ?? a.city ?? a.town ?? a.village;
      const short = [a.amenity ?? a.leisure ?? a.building, street, area].filter(Boolean).join(', ');
      if (short) return short;
    }
    return row.display_name ?? null;
  } catch {
    return null;
  }
}
