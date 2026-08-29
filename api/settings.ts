import { supabaseRest } from '../backend/src/supabase.js';

const PUBLIC_KEYS = ['system_name', 'contact_phone', 'address', 'working_hours', 'booking_enabled', 'location'];

function normalizeLocation(value: any) {
  const v = value && typeof value === 'object' ? value : {};
  const lat = Number(v.latitude ?? v.lat);
  const lng = Number(v.longitude ?? v.lng);
  return {
    ...v,
    name: String(v.name || 'TASH INDEX AVTODROM'),
    address: String(v.address || 'Toshkent shahri'),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    // Backward-compatible aliases used by the existing customer mini app.
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    google_url: String(v.google_url || v.google || ''),
    yandex_url: String(v.yandex_url || v.yandex || ''),
    two_gis_url: String(v.two_gis_url || v['2gis'] || ''),
    google: String(v.google_url || v.google || ''),
    yandex: String(v.yandex_url || v.yandex || ''),
    '2gis': String(v.two_gis_url || v['2gis'] || ''),
  };
}

export default async function handler(_req: any, res: any) {
  try {
    const rows = await supabaseRest<any[]>('admin_settings', {
      query: `?key=in.(${PUBLIC_KEYS.map(encodeURIComponent).join(',')})&select=key,value`,
    });
    const settings: any = {};
    for (const r of rows) {
      const value = r.value?.value !== undefined ? r.value.value : r.value;
      settings[r.key] = r.key === 'location' ? normalizeLocation(value) : value;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, settings }));
  } catch (e: any) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ ok: true, settings: {} }));
  }
}
