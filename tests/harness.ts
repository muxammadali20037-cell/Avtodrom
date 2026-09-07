/**
 * SINOV MUHITI
 *
 * Haqiqiy Supabase o'rniga xotiradagi soxta baza. Bu:
 *   · testlarni tez qiladi (tarmoqqa chiqmaydi)
 *   · production ma'lumotiga tegmaydi
 *   · har testda toza holatdan boshlaydi
 *
 * Muhit o'zgaruvchilari HAR QANDAY importdan OLDIN o'rnatilishi shart —
 * modullar ularni yuklanish paytida o'qiydi.
 */

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
process.env.ADMIN_LOGIN = 'root';
process.env.ADMIN_PASSWORD = 'rootpass123';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';
process.env.TELEGRAM_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.CRON_SECRET = 'test-cron-secret';
// Testlar ko'p marta kiradi — login cheklovi ularni to'smasin.
// Cheklovning o'zi alohida testda tekshiriladi.
process.env.LOGIN_RATE_MAX = '10000';
process.env.CUSTOMER_BOT_TOKEN = '1:customer';
process.env.INSTRUCTOR_BOT_TOKEN = '1:instructor';

export interface FakeDb {
  [table: string]: any[];
}

export interface Harness {
  app: any;
  db: FakeDb;
  telegram: Array<{ chat: number; text: string }>;
  login(login: string, password: string): Promise<{ status: number; body: any; cookie: string }>;
  call(method: string, url: string, opts?: { cookie?: string; payload?: any }): Promise<{ status: number; body: any }>;
  reset(): void;
}

function emptyDb(): FakeDb {
  return {
    users: [], staff: [], bookings: [], payments: [], courses: [],
    instructor_profiles: [], instructor_applications: [], cash_registers: [],
    admin_media: [], admin_settings: [], admin_audit_logs: [],
    attendance_verifications: [], booking_reminders: [], notifications: [],
    reviews: [], cashier_shifts: [],
  };
}

/** PostgREST filtrlarini soddalashtirib qo'llaydi. */
function applyFilters(rows: any[], query: string): any[] {
  const qs = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query);
  let out = [...rows];
  for (const [field, raw] of qs.entries()) {
    if (['select', 'order', 'limit', 'offset'].includes(field)) continue;
    const [op, ...rest] = String(raw).split('.');
    const val = decodeURIComponent(rest.join('.'));
    out = out.filter((r) => {
      const v = r[field];
      switch (op) {
        case 'eq':    return String(v) === val;
        case 'neq':   return String(v) !== val;
        case 'gte':   return new Date(v).getTime() >= new Date(val).getTime();
        case 'lte':   return new Date(v).getTime() <= new Date(val).getTime();
        case 'gt':    return new Date(v).getTime() >  new Date(val).getTime();
        case 'lt':    return new Date(v).getTime() <  new Date(val).getTime();
        case 'is':    return val === 'null' ? v == null : String(v) === val;
        case 'ilike': return String(v ?? '').toLowerCase() === val.toLowerCase().replace(/%/g, '');
        case 'in': {
          const list = val.replace(/^\(|\)$/g, '').split(',').map((x) => x.replace(/^"|"$/g, ''));
          return list.includes(String(v));
        }
        case 'cs': {
          const want = val.replace(/^\{|\}$/g, '').split(',');
          return Array.isArray(v) && want.every((w) => v.includes(w));
        }
        default: return true;
      }
    });
  }
  const limit = Number(qs.get('limit') || 0);
  return limit > 0 ? out.slice(0, limit) : out;
}

export async function makeHarness(): Promise<Harness> {
  const db = emptyDb();
  const telegram: Array<{ chat: number; text: string }> = [];

  globalThis.fetch = (async (u: any, o: any = {}) => {
    const url = String(u);
    const method = String(o.method || 'GET').toUpperCase();
    const body = o.body ? JSON.parse(o.body) : null;
    const H = new Map<string, string>();

    if (url.includes('api.telegram.org')) {
      if (body?.chat_id) telegram.push({ chat: Number(body.chat_id), text: String(body.text || '') });
      return { ok: true, status: 200, text: async () => '{"ok":true}', json: async () => ({ ok: true, result: {} }), headers: H } as any;
    }

    if (url.includes('/storage/v1/')) {
      // Bucket va yuklash — har doim muvaffaqiyatli
      const payload = url.includes('upload/sign') ? { token: 'test-token' } : { id: 'customer-media', file_size_limit: 209715200 };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload), headers: H } as any;
    }

    const m = /\/rest\/v1\/([a-z_]+)(\?.*)?$/.exec(url);
    if (!m) return { ok: true, status: 200, text: async () => '[]', headers: H } as any;

    const table = m[1];
    const query = m[2] || '';
    db[table] = db[table] || [];

    if (method === 'GET') {
      const all = applyFilters(db[table], query);

      /* PostgREST kabi `Range` sarlavhasini qo'llaymiz — sahifalash
         testlari haqiqiy xatti-harakatni tekshirsin. */
      const range = o.headers?.get?.('Range') || o.headers?.Range;
      let rows = all;
      let from = 0;
      if (range) {
        const [f, t] = String(range).split('-').map(Number);
        if (Number.isFinite(f) && Number.isFinite(t)) {
          from = f;
          rows = all.slice(f, t + 1);
        }
      }
      const last = rows.length ? from + rows.length - 1 : 0;
      H.set('content-range', `${from}-${last}/${all.length}`);
      return { ok: true, status: 200, text: async () => JSON.stringify(rows), headers: H } as any;
    }

    if (method === 'POST') {
      const items = Array.isArray(body) ? body : [body];
      const created = items.map((it: any) => {
        const row = { id: it.id ?? `${table}-${db[table].length + 1}`, created_at: new Date().toISOString(), ...it };
        db[table].push(row);
        return row;
      });
      return { ok: true, status: 201, text: async () => JSON.stringify(created), headers: H } as any;
    }

    if (method === 'PATCH') {
      const target = applyFilters(db[table], query);
      target.forEach((r) => Object.assign(r, body));
      return { ok: true, status: 200, text: async () => JSON.stringify(target), headers: H } as any;
    }

    if (method === 'DELETE') {
      const target = applyFilters(db[table], query);
      db[table] = db[table].filter((r) => !target.includes(r));
      return { ok: true, status: 200, text: async () => JSON.stringify(target), headers: H } as any;
    }

    return { ok: true, status: 200, text: async () => '[]', headers: H } as any;
  }) as any;

  const { app } = await import('../backend/src/app.js');
  await app.ready();

  const login = async (l: string, p: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { login: l, password: p } });
    const sc = r.headers['set-cookie'];
    const arr = Array.isArray(sc) ? sc : (sc ? [sc] : []);
    let body: any = {};
    try { body = JSON.parse(r.payload); } catch { /* bo'sh */ }
    return { status: r.statusCode, body, cookie: arr.map((c: any) => String(c).split(';')[0]).join('; ') };
  };

  const call = async (method: string, url: string, opts: any = {}) => {
    const r = await app.inject({
      method, url,
      headers: opts.cookie ? { cookie: opts.cookie } : {},
      payload: opts.payload,
    });
    let body: any = {};
    try { body = JSON.parse(r.payload); } catch { body = r.payload; }
    return { status: r.statusCode, body };
  };

  return {
    app, db, telegram, login, call,
    reset() {
      for (const k of Object.keys(db)) db[k] = [];
      telegram.length = 0;
    },
  };
}
