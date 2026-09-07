import 'dotenv/config';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase server credentials are missing');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Qayta urinishga arziydigan (vaqtinchalik) xatolar:
 *  - PGRST303 "JWT issued at future" — Supabase tugunlari soatidagi kichik farq.
 *    Bir xil kalit bilan yonma-yon so'rovlarning bittasi yiqilib, qolgani o'tadi.
 *  - PGRST301 — JWT muddati o'tgan (tugun soati orqada).
 *  - 502/503/504 va tarmoq uzilishi.
 * Login/parol xatosi (haqiqiy 401) qayta urinilmaydi — u o'z-o'zidan tuzalmaydi.
 */
function isTransient(status: number, body: string) {
  if (status === 502 || status === 503 || status === 504) return true;
  if (status === 401 && /PGRST30[13]|issued at future|JWT expired/i.test(body)) return true;
  return false;
}

/** Xom Supabase javobidan foydalanuvchi uchun tushunarli sabab ajratadi. */
function reason(status: number, body: string) {
  try {
    const d = JSON.parse(body);
    if (d?.code === 'PGRST303') return 'Supabase kaliti vaqt tamg‘asi mos kelmadi (PGRST303). Bir necha soniyadan keyin qayta urinib ko‘ring.';
    if (d?.code === 'PGRST301') return 'Supabase kaliti muddati o‘tgan (PGRST301). Kalitni yangilang.';
    if (d?.code === '42P01') return `Jadval topilmadi: ${d?.message || ''}`;
    if (d?.code === '42703') return `Ustun topilmadi: ${d?.message || ''}`;
    if (d?.message) return `${d.message}${d.hint ? ' — ' + d.hint : ''}`;
  } catch { /* JSON bo'lmasa xom matn */ }
  return body || `HTTP ${status}`;
}

export async function supabaseRest<T>(
  table: string,
  options: RequestInit & { query?: string } = {},
): Promise<T> {
  requireSupabase();
  const url = `${SUPABASE_URL}/rest/v1/${table}${options.query || ''}`;
  const headers = new Headers(options.headers);
  headers.set('apikey', SUPABASE_SERVICE_ROLE_KEY);
  headers.set('Authorization', `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`);
  headers.set('Content-Type', 'application/json');

  const MAX = 3;
  let lastStatus = 0;
  let lastBody = '';

  for (let attempt = 1; attempt <= MAX; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { ...options, headers });
    } catch (e) {
      // Tarmoq uzilishi — oxirgi urinish bo'lmasa qayta urinamiz
      lastBody = e instanceof Error ? e.message : 'network error';
      lastStatus = 0;
      if (attempt < MAX) { await sleep(attempt * 250); continue; }
      throw new Error(`Supabase network error: ${lastBody}`);
    }

    const text = await response.text();
    if (response.ok) return text ? (JSON.parse(text) as T) : (undefined as T);

    lastStatus = response.status;
    lastBody = text;

    if (attempt < MAX && isTransient(response.status, text)) {
      console.warn(`Supabase ${response.status} on "${table}" (urinish ${attempt}/${MAX}) — qayta urinilmoqda`);
      await sleep(attempt * 250);
      continue;
    }
    break;
  }

  throw new Error(`Supabase ${lastStatus}: ${reason(lastStatus, lastBody)}`);
}

/**
 * Sahifalangan o'qish — qatorlar bilan birga UMUMIY SONNI ham qaytaradi.
 *
 * PostgREST bir so'rovda ko'pi bilan 1000 qator beradi va bu haqda xato
 * bermaydi. Shuning uchun sahifalash shart. `Prefer: count=exact` sarlavhasi
 * `Content-Range: 0-24/1337` ko'rinishida umumiy sonni qaytaradi —
 * shundan "nechta sahifa bor" ni bilamiz.
 *
 * Diqqat: count=exact katta jadvalda sekin. 100k+ qatorda
 * `count=planned` ga o'tish kerak (taxminiy, lekin tez).
 */
export async function supabaseRestPaged<T>(
  table: string,
  query: string,
  page: number,
  perPage: number,
): Promise<{ rows: T[]; total: number; page: number; per_page: number; has_more: boolean }> {
  requireSupabase();

  const size = Math.max(1, Math.min(200, Math.trunc(perPage) || 50));
  const p = Math.max(1, Math.trunc(page) || 1);
  const from = (p - 1) * size;
  const to = from + size - 1;

  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const headers = new Headers();
  headers.set('apikey', SUPABASE_SERVICE_ROLE_KEY);
  headers.set('Authorization', `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`);
  headers.set('Content-Type', 'application/json');
  headers.set('Range-Unit', 'items');
  headers.set('Range', `${from}-${to}`);
  headers.set('Prefer', 'count=exact');

  const response = await fetch(url, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${reason(response.status, text)}`);
  }

  const rows = text ? (JSON.parse(text) as T[]) : [];
  // Content-Range: 0-24/1337  yoki  */0 (bo'sh natija)
  const cr = String(response.headers.get('content-range') || '');
  const totalRaw = cr.split('/')[1];
  const total = totalRaw && totalRaw !== '*' ? Number(totalRaw) : rows.length;

  return {
    rows,
    total: Number.isFinite(total) ? total : rows.length,
    page: p,
    per_page: size,
    has_more: from + rows.length < total,
  };
}
