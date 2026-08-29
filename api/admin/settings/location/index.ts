import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from '../../../../backend/src/supabase.js';

const COOKIE = 'avtodrom_admin_session';
const TTL = 60 * 60 * 12;

function getCookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE + '='));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE.length + 1)); } catch { return ''; }
}

function validSession(token: string) {
  try {
    const secret = String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const decoded = Buffer.from(token || '', 'base64url').toString('utf8');
    const a = decoded.indexOf(':'), b = decoded.indexOf(':', a + 1);
    if (!secret || !expectedLogin || a <= 0 || b <= a) return false;
    const login = decoded.slice(0, a);
    const ts = Number(decoded.slice(a + 1, b));
    const sig = decoded.slice(b + 1);
    if (login !== expectedLogin || !Number.isFinite(ts) || Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${ts}`).digest('hex');
    const x = Buffer.from(sig), y = Buffer.from(expected);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

function json(res: any, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function adminId() {
  const rows = await supabaseRest<any[]>('users', {
    query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=id&limit=1',
  });
  return rows[0]?.id || null;
}

export default async function handler(req: any, res: any) {
  if (!validSession(getCookie(req))) {
    return json(res, 401, { ok: false, error: 'Admin sessiyasi tugagan. Qayta kiring.' });
  }

  if (req.method === 'GET') {
    try {
      const rows = await supabaseRest<any[]>('admin_settings', {
        query: '?key=eq.location&select=key,value,updated_at&limit=1',
      });
      return json(res, 200, { ok: true, setting: rows[0] || null });
    } catch (error: any) {
      console.error('Location read failed:', error);
      return json(res, 500, { ok: false, error: error?.message || 'Lokatsiyani o‘qishda xato' });
    }
  }

  if (req.method !== 'PUT' && req.method !== 'PATCH') {
    res.setHeader('Allow', 'GET, PUT, PATCH');
    return json(res, 405, { ok: false, error: 'Method ruxsat etilmagan' });
  }

  try {
    const body = req.body || {};
    const raw = body.value !== undefined ? body.value : body;
    const v = raw && typeof raw === 'object' ? raw : {};
    const name = String(v.name || '').trim();
    const address = String(v.address || '').trim();
    const latitude = Number(v.latitude ?? v.lat);
    const longitude = Number(v.longitude ?? v.lng);

    if (!name) return json(res, 400, { ok: false, error: 'Lokatsiya nomi majburiy' });
    if (!address) return json(res, 400, { ok: false, error: 'Manzilni kiriting.' });
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return json(res, 400, { ok: false, error: 'Latitude noto‘g‘ri.' });
    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return json(res, 400, { ok: false, error: 'Longitude noto‘g‘ri.' });

    const value = {
      name,
      address,
      latitude,
      longitude,
      google_url: String(v.google_url || v.google || '').trim(),
      yandex_url: String(v.yandex_url || v.yandex || '').trim(),
      two_gis_url: String(v.two_gis_url || v['2gis'] || '').trim(),
    };

    const oldRows = await supabaseRest<any[]>('admin_settings', {
      query: '?key=eq.location&select=*&limit=1',
    });
    const updated_at = new Date().toISOString();
    const rows = oldRows[0]
      ? await supabaseRest<any[]>('admin_settings', {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          query: '?key=eq.location',
          body: JSON.stringify({ value, updated_at }),
        })
      : await supabaseRest<any[]>('admin_settings', {
          method: 'POST',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify({ key: 'location', value, updated_at }),
        });

    try {
      const admin = await adminId();
      if (admin) {
        await supabaseRest('admin_audit_logs', {
          method: 'POST',
          body: JSON.stringify({
            admin_id: admin,
            action: 'SETTING_UPDATED',
            entity_type: 'admin_settings',
            entity_id: 'location',
            old_data: oldRows[0]?.value ?? null,
            new_data: value,
          }),
        });
      }
    } catch (auditError) {
      console.error('Location audit log failed:', auditError);
    }

    return json(res, 200, { ok: true, setting: rows[0] || { key: 'location', value, updated_at } });
  } catch (error: any) {
    console.error('Location save failed:', error);
    return json(res, 500, { ok: false, error: error?.message || 'Lokatsiyani saqlashda xato' });
  }
}
