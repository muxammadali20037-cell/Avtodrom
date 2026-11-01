import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { findUserByTelegram } from './identity.js';
import { telegramApi, type TelegramWebAppUser } from './telegram.js';
import { checkControlToken } from './control-view.js';

/**
 * SHARHLAR — avtodrom va instruktorlar haqida mijozlar fikri.
 *
 *  · Mini App → «Sharh qoldirish» oynasi: avtodromga baho, instruktor va
 *    unga baho, izoh, taklif. Sharh SIR saqlanadi: nazorat panelida mijoz
 *    ismi ko'rsatilmaydi, instruktorga hech narsa yuborilmaydi.
 *  · Admin bir marta «so'rov» yuboradi: Mini App orqali bron qilgan hamma
 *    mijozga mijoz botidan xabar va «✍️ Sharh qoldirish» tugmasi.
 *  · Nazorat paneli → «💬 Sharhlar»: hamma sharhlar, o'rtacha baholar.
 */

const q = (v: string) => encodeURIComponent(v);
const CAMPAIGN_KEY = 'feedback_campaign';
const botToken = () => String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
const appUrl = () => String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || 'https://avtodrom.vercel.app/');
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unwrap = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);

/** Ismning birinchi so'zi («Ali Valiyev» → «Ali»); «Mijoz +998…» kabi bo'lsa — bo'sh */
function firstName(full: unknown): string {
  const s = String(full || '').trim();
  if (!s || /^mijoz\b/i.test(s) || /\d{5,}/.test(s)) return '';
  return s.split(/\s+/)[0].slice(0, 30);
}

export function inviteText(name: string): string {
  return [
    `🙏 Assalomu alaykum${name ? `, ${esc(name)}` : ''}!`,
    '',
    'TASH INDEX AVTODROM’da mashg‘ulot o‘tganingiz uchun rahmat.',
    '',
    'Fikringiz biz uchun muhim: avtodrom va instruktorlar haqida qisqa sharh yoki taklif qoldiring — 1 daqiqa vaqt oladi.',
    '',
    '🔒 Sharhingiz sir saqlanadi: ismingiz instruktorga ko‘rsatilmaydi.',
  ].join('\n');
}
const formUrl = () => {
  const base = appUrl();
  return base + (base.includes('?') ? '&' : '?') + 'open=feedback';
};

const clampRating = (v: unknown): number | null => {
  const n = Math.round(Number(v));
  return Number.isInteger(n) && n >= 1 && n <= 5 ? n : null;
};
const cleanText = (v: unknown, max = 2000): string | null => {
  const s = String(v ?? '').replace(/\s+\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};

/** Mini App orqali bron qilgan, Telegram'i bor mijozlar */
async function audience(): Promise<{ id: string; telegram_id: number; name: string }[]> {
  const out = new Map<string, any>();
  for (let offset = 0; offset < 50000; offset += 1000) {
    const rows = await supabaseRest<any[]>('bookings', {
      query: `?source=eq.app&customer_id=not.is.null&select=customer_id&order=created_at.asc&limit=1000&offset=${offset}`,
    });
    for (const r of rows) out.set(String(r.customer_id), true);
    if (rows.length < 1000) break;
  }
  const users = await selectIn<any>('users', 'id', [...out.keys()], 'id,full_name,telegram_id,is_blocked');
  return users
    .filter((u) => Number(u.telegram_id) > 0 && !u.is_blocked)
    .map((u) => ({ id: String(u.id), telegram_id: Number(u.telegram_id), name: firstName(u.full_name) }));
}

async function loadCampaign(): Promise<any | null> {
  const r = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${CAMPAIGN_KEY}&select=value&limit=1` }).catch(() => []);
  return unwrap(r?.[0]?.value) || null;
}

/** Nazorat paneli uchun: hamma sharhlar (mijoz ismisiz), o'rtacha baholar */
export async function feedbackSummary(limit = 500) {
  const rows = await supabaseRest<any[]>('feedback', {
    query: `?select=id,instructor_id,place_rating,instructor_rating,comment,suggestion,created_at&order=created_at.desc&limit=${Math.min(1000, limit)}`,
  });
  const ips = await selectIn<any>('instructor_profiles', 'id', rows.map((r) => r.instructor_id).filter(Boolean), 'id,user_id');
  const us = await selectIn<any>('users', 'id', ips.map((i) => i.user_id).filter(Boolean), 'id,full_name');
  const um = new Map(us.map((u) => [String(u.id), u.full_name]));
  const nameOf = new Map(ips.map((i) => [String(i.id), um.get(String(i.user_id)) || 'Instruktor']));
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const place = rows.map((r) => Number(r.place_rating)).filter((n) => n >= 1);
  const byIns = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.instructor_id || !(Number(r.instructor_rating) >= 1)) continue;
    const k = String(r.instructor_id);
    byIns.set(k, [...(byIns.get(k) || []), Number(r.instructor_rating)]);
  }
  return {
    total: rows.length,
    place: { avg: avg(place), count: place.length, dist: [1, 2, 3, 4, 5].map((s) => place.filter((n) => n === s).length) },
    instructors: [...byIns.entries()].map(([id, xs]) => ({ id, name: nameOf.get(id) || 'Instruktor', avg: avg(xs), count: xs.length }))
      .sort((a, b) => (b.avg ?? 0) - (a.avg ?? 0) || b.count - a.count),
    items: rows.map((r) => ({
      id: r.id, at: r.created_at,
      place_rating: r.place_rating ?? null,
      instructor: r.instructor_id ? (nameOf.get(String(r.instructor_id)) || 'Instruktor') : null,
      instructor_rating: r.instructor_rating ?? null,
      comment: r.comment || null, suggestion: r.suggestion || null,
    })),
  };
}

const SEND_BUDGET_MS = 40_000;

export async function registerFeedbackRoutes(app: FastifyInstance, deps: {
  authenticateCustomer: (req: any) => Promise<TelegramWebAppUser>;
  guardAdmin: (req: any) => Promise<void>;
  currentStaff: (req: any) => Promise<any>;
}) {
  /* Mini App: sharh oynasi uchun — mijoz dars o'tgan instruktorlar */
  app.get('/api/feedback/form', async (req: any, reply: any) => {
    try {
      const tg = await deps.authenticateCustomer(req);
      const user = await findUserByTelegram(tg.id);
      if (!user) return { ok: true, instructors: [], sent: 0 };
      const [bks, mine] = await Promise.all([
        supabaseRest<any[]>('bookings', {
          query: `?customer_id=eq.${q(String(user.id))}&instructor_id=not.is.null&status=not.in.(cancelled,rejected)` +
                 '&select=instructor_id,start_at&order=start_at.desc&limit=200',
        }),
        supabaseRest<any[]>('feedback', { query: `?customer_id=eq.${q(String(user.id))}&select=id&limit=50` }).catch(() => []),
      ]);
      const ids = [...new Set(bks.map((b) => String(b.instructor_id)))];
      const ips = await selectIn<any>('instructor_profiles', 'id', ids, 'id,user_id');
      const us = await selectIn<any>('users', 'id', ips.map((i) => i.user_id), 'id,full_name');
      const um = new Map(us.map((u) => [String(u.id), u.full_name]));
      const instructors = ids.map((id) => {
        const ip = ips.find((i) => String(i.id) === id);
        return { id, name: (ip && um.get(String(ip.user_id))) || 'Instruktor' };
      });
      return { ok: true, instructors, sent: mine.length };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Yuklanmadi' });
    }
  });

  /* Mini App: sharhni yuborish */
  app.post('/api/feedback', async (req: any, reply: any) => {
    try {
      const tg = await deps.authenticateCustomer(req);
      const user = await findUserByTelegram(tg.id);
      if (!user) return reply.code(403).send({ ok: false, error: 'Avval Mini App orqali ro‘yxatdan o‘ting' });
      const b = req.body || {};
      const place = clampRating(b.place_rating);
      const insRating = clampRating(b.instructor_rating);
      const comment = cleanText(b.comment), suggestion = cleanText(b.suggestion);
      if (!place && !insRating && !comment && !suggestion) {
        return reply.code(400).send({ ok: false, error: 'Baho qo‘ying yoki fikringizni yozing' });
      }
      let instructorId: string | null = String(b.instructor_id || '').trim() || null;
      if (instructorId) {
        const ip = (await supabaseRest<any[]>('instructor_profiles', { query: `?id=eq.${q(instructorId)}&select=id&limit=1` }).catch(() => []))[0];
        if (!ip) instructorId = null;
      }
      /* Bir kunda 5 tadan ko'p sharh yozilmasin (tasodifiy takror, spam) */
      const since = new Date(Date.now() - 864e5).toISOString();
      const today = await supabaseRest<any[]>('feedback', {
        query: `?customer_id=eq.${q(String(user.id))}&created_at=gte.${q(since)}&select=id&limit=10`,
      }).catch(() => []);
      if (today.length >= 5) return reply.code(429).send({ ok: false, error: 'Bugun yetarlicha sharh yozdingiz — rahmat!' });
      await supabaseRest('feedback', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          customer_id: user.id, instructor_id: instructorId,
          place_rating: place, instructor_rating: instructorId ? insRating : null,
          comment, suggestion, source: 'mini_app',
        }),
      });
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Yuborilmadi' });
    }
  });

  /* Nazorat paneli (maxfiy havola bilan): sharhlar — mijoz ismisiz */
  app.get('/api/control-feedback', async (req: any, reply: any) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Robots-Tag', 'noindex, nofollow');
    try {
      if (!(await checkControlToken(String(req.query?.k || '')))) {
        return reply.code(403).send({ ok: false, error: 'Havola eskirgan yoki noto‘g‘ri. Admin paneldan yangi havolani oling.' });
      }
      return { ok: true, ...(await feedbackSummary()) };
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || 'Sharhlar yuklanmadi' });
    }
  });

  /* Admin: so'rovni yuborish — oldindan ko'rish (nechta odam, oxirgi yuborish) */
  app.get('/api/admin/feedback-invite', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      const [aud, camp] = await Promise.all([audience(), loadCampaign()]);
      const sentIds = new Set<string>((camp?.ids || []).map(String));
      return {
        ok: true, total: aud.length, pending: aud.filter((a) => !sentIds.has(a.id)).length,
        last: camp ? { at: camp.at, by: camp.by, sent: camp.sent, failed: camp.failed } : null,
        text: inviteText('Ali'), button: '✍️ Sharh qoldirish',
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuklanmadi' });
    }
  });

  /* Admin: so'rovni yuborish. Bir odamga bir marta (qayta bosilsa — faqat
     hali olmaganlarga). Telegram cheklovi uchun 5 tadan parallel. */
  app.post('/api/admin/feedback-invite', async (req: any, reply: any) => {
    try {
      await deps.guardAdmin(req);
      const token = botToken();
      if (!token) return reply.code(503).send({ ok: false, error: 'Mijoz boti sozlanmagan (CUSTOMER_BOT_TOKEN)' });
      const me = await deps.currentStaff(req).catch(() => null);
      const [aud, camp] = await Promise.all([audience(), loadCampaign()]);
      const sentIds = new Set<string>((camp?.ids || []).map(String));
      const todo = aud.filter((a) => !sentIds.has(a.id));
      let sent = 0, failed = 0, done = 0;
      const okIds: string[] = [];
      const markup = { inline_keyboard: [[{ text: '✍️ Sharh qoldirish', web_app: { url: formUrl() } }]] };
      const t0 = Date.now();
      for (let i = 0; i < todo.length; i += 5) {
        if (Date.now() - t0 > SEND_BUDGET_MS) break;         // Vercel 60 s — qolganini keyingi bosishda
        const part = todo.slice(i, i + 5);
        done += part.length;
        const res = await Promise.all(part.map((a) => telegramApi(token, 'sendMessage', {
          chat_id: a.telegram_id, text: inviteText(a.name), parse_mode: 'HTML', reply_markup: markup,
        }).then(() => true, () => false)));
        res.forEach((ok, j) => { if (ok) { sent++; okIds.push(part[j].id); } else failed++; });
        if (i + 5 < todo.length) await new Promise((r) => setTimeout(r, 250));
      }
      const value = {
        at: new Date().toISOString(), by: me?.login || null,
        sent: (Number(camp?.sent) || 0) + sent, failed,
        ids: [...sentIds, ...okIds],
      };
      await supabaseRest('admin_settings', {
        method: 'POST', query: '?on_conflict=key',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ key: CAMPAIGN_KEY, value, updated_at: value.at }),
      }).catch((e) => console.error('feedback campaign save failed:', e));
      return { ok: true, sent, failed, total: aud.length, already: aud.length - todo.length, left: todo.length - done };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuborilmadi' });
    }
  });
}
