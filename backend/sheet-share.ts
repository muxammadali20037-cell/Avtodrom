import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';

/**
 * EXCEL BRON — GURUHGA HAVOLA
 *
 * Muammo: adminlar Excel’dagi jadvalni guruhga tashlardi — telefonda Excel
 * ochilmaydi, skrinshot esa mayda, o'qib bo'lmaydi.
 * Yechim: guruhga instruktor boti BITTA xabar tashlaydi — «📋 Jadvalni
 * ochish» tugmasi bilan. Bosilsa telefonda jadval sahifasi ochiladi
 * (/jadval): instruktorni tanlab ko'radi, raqamni bosib qo'ng'iroq qiladi.
 * Sahifa har doim ENG YANGI holatni ko'rsatadi (skrinshot kabi eskirmaydi).
 *
 * Qachon yuboriladi (foydalanuvchi tanlagan):
 *   • Excel bron sahifasidagi «📤 Guruhga» tugmasi bosilganda — yangi xabar;
 *   • admin «Saqlash» bosganda — o'sha kun xabari YANGILANADI (guruhni
 *     to'ldirib yubormaslik uchun), xabar bo'lmasa — yangisi;
 *   • har kuni 20:00 da — ertangi kun.
 *
 * Havola imzolangan (HMAC): sanani o'zgartirib boshqa kunni ochib bo'lmaydi,
 * havola kun o'tgach 2 kundan keyin yopiladi.
 *
 * Guruhni ulash — bir martalik kod: admin panelda kod olinadi, guruhda
 * «/ulash 123456» yoziladi. Begona guruh o'zini ulay olmaydi.
 */

const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const GROUP_KEY = 'sheet_group';
const CODE_KEY = 'sheet_group_code';
const MSG_PREFIX = 'sheet_group_msg:';
const EVENING_PREFIX = 'sheet_group_evening:';
export const SHEET_SHARE_KEYS = [GROUP_KEY, CODE_KEY];
export const SHEET_SHARE_PREFIXES = [MSG_PREFIX, EVENING_PREFIX];

const TOKEN = () => String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
const BASE = () => String(process.env.PUBLIC_BASE_URL || 'https://avtodrom.vercel.app').replace(/\/+$/, '');
function secret(): string {
  const s = process.env.SHEET_LINK_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.TELEGRAM_WEBHOOK_SECRET || TOKEN();
  return crypto.createHash('sha256').update(`avtodrom-sheet-link:${s}`).digest('hex');
}

/* ------------------------------------------------------------------ */
/* Havola                                                              */
/* ------------------------------------------------------------------ */
export function sheetLinkToken(date: string): string {
  return crypto.createHmac('sha256', secret()).update(`sheet:${date}`).digest('base64url').slice(0, 22);
}
export function sheetLinkUrl(date: string): string {
  return `${BASE()}/jadval?d=${date}&k=${sheetLinkToken(date)}`;
}
/** Havola to'g'rimi va hali amal qiladimi */
export function checkSheetLink(date: string, token: string, nowMs = Date.now()): string | null {
  if (!YMD.test(date)) return 'Sana noto‘g‘ri';
  const want = sheetLinkToken(date);
  const got = String(token || '');
  if (got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return 'Havola noto‘g‘ri';
  if (date < addDaysYmd(tashkentYmdOf(nowMs), -2)) return 'Havola eskirgan — guruhdagi yangi xabarni oching';
  return null;
}

/* ------------------------------------------------------------------ */
/* Sozlamalar                                                          */
/* ------------------------------------------------------------------ */
async function getSetting<T = any>(key: string): Promise<T | null> {
  const r = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(key)}&select=value&limit=1` });
  return (r?.[0]?.value ?? null) as T | null;
}
async function setSetting(key: string, value: unknown): Promise<void> {
  const now = new Date().toISOString();
  const rows = await supabaseRest<any[]>('admin_settings', {
    method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${q(key)}`,
    body: JSON.stringify({ value, updated_at: now }),
  });
  if (!rows?.length) {
    await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key, value, updated_at: now }) });
  }
}
async function delSetting(key: string): Promise<void> {
  await supabaseRest('admin_settings', { method: 'DELETE', query: `?key=eq.${q(key)}` });
}

export type SheetGroup = { chat_id: number; title: string | null; linked_at: string; linked_by: string | null };
export async function getSheetGroup(): Promise<SheetGroup | null> {
  const g = await getSetting<SheetGroup>(GROUP_KEY).catch(() => null);
  return g && Number.isSafeInteger(Number(g.chat_id)) ? { ...g, chat_id: Number(g.chat_id) } : null;
}

/* ------------------------------------------------------------------ */
/* Telegram (to'liq javob kerak: guruh supergroup bo'lsa yangi ID keladi) */
/* ------------------------------------------------------------------ */
async function tg(method: string, body: Record<string, unknown>): Promise<any> {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
}
let botName: string | null = null;
export async function instructorBotUsername(): Promise<string | null> {
  if (botName || !TOKEN()) return botName;
  try { const r = await tg('getMe', {}); botName = r?.ok ? r.result?.username || null : null; } catch { botName = null; }
  return botName;
}

/* ------------------------------------------------------------------ */
/* Guruhni ulash                                                       */
/* ------------------------------------------------------------------ */
export async function newLinkCode(by: string): Promise<{ code: string; expires_at: string }> {
  const code = String(crypto.randomInt(100000, 1000000));
  const expires_at = new Date(Date.now() + 15 * 60000).toISOString();
  await setSetting(CODE_KEY, { code, exp: expires_at, by });
  return { code, expires_at };
}

/**
 * Instruktor botiga GURUHDAN kelgan xabar. «/ulash 123456» bo'lsa —
 * guruhni ulaydi va javob matnini qaytaradi; boshqa xabar — null.
 */
export async function handleGroupMessage(chat: { id: number; title?: string; type?: string }, text: string): Promise<string | null> {
  const m = /^\/(ulash|link)(?:@\w+)?(?:\s+(\d{6}))?\s*$/i.exec(String(text || '').trim());
  if (!m) return null;
  if (!m[2]) return '🔗 Guruhni ulash: admin panel → Excel bron → «📤 Guruhga» tugmasidagi 6 xonali kodni yozing: /ulash 123456';
  const c = await getSetting<any>(CODE_KEY).catch(() => null);
  if (!c || String(c.code) !== m[2] || Date.parse(c.exp) < Date.now()) {
    return '⚠️ Kod noto‘g‘ri yoki eskirgan. Admin panel → Excel bron → «📤 Guruhga» dan yangi kod oling.';
  }
  await setSetting(GROUP_KEY, { chat_id: chat.id, title: chat.title || null, linked_at: new Date().toISOString(), linked_by: c.by || null });
  await delSetting(CODE_KEY).catch(() => {});
  return `✅ Guruh ulandi${chat.title ? `: «${chat.title}»` : ''}.\n\nExcel bron jadvali shu yerga havola bo‘lib keladi — bosib telefonda ko‘rasiz.`;
}

/* ------------------------------------------------------------------ */
/* Guruhga yuborish                                                    */
/* ------------------------------------------------------------------ */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string);
const hm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

async function messageFor(date: string, by?: string | null) {
  const { publicSheetData } = await import('./booking-sheet-routes.js');
  const { dayTitle } = await import('./instructor-notify.js');
  const d = await publicSheetData(date);
  const s = d.stats;
  const text = [
    `📅 <b>Excel bron — ${esc(dayTitle(date))}</b>`,
    `👥 ${s.busy_instructors} ta instruktorda yozuv · 📋 ${s.bron} ta bron${s.band ? ` · ${s.band} ta band` : ''}`,
    `🕘 Yangilandi: ${hm(Date.now())}${by ? ` (${esc(by)})` : ''}`,
    '',
    '👇 Bosing — telefonda jadval ochiladi, har doim eng yangi holat. Raqamni bosib qo‘ng‘iroq qilasiz.',
  ].join('\n');
  const reply_markup = { inline_keyboard: [[{ text: '📋 Jadvalni ochish', url: sheetLinkUrl(date) }]] };
  return { text, reply_markup };
}

/**
 * mode: 'new' — har doim yangi xabar (tugma, 20:00);
 *       'update' — o'sha kun xabari bo'lsa tahrirlanadi, bo'lmasa yangisi (saqlash).
 */
export async function postSheetToGroup(date: string, o: { mode: 'new' | 'update'; by?: string | null }): Promise<{ ok: boolean; link: string; error?: string; edited?: boolean }> {
  const link = sheetLinkUrl(date);
  if (!TOKEN()) return { ok: false, link, error: 'Instruktor boti tokeni yo‘q' };
  const g = await getSheetGroup();
  if (!g) return { ok: false, link, error: 'Guruh ulanmagan' };
  const msg = await messageFor(date, o.by);
  const key = MSG_PREFIX + date;

  if (o.mode === 'update') {
    const prev = await getSetting<any>(key).catch(() => null);
    if (prev?.message_id && Number(prev.chat_id) === g.chat_id) {
      const r = await tg('editMessageText', { chat_id: g.chat_id, message_id: prev.message_id, text: msg.text, parse_mode: 'HTML', reply_markup: msg.reply_markup, disable_web_page_preview: true });
      if (r?.ok || /not modified/i.test(String(r?.description || ''))) return { ok: true, link, edited: true };
    }
  }
  let r = await tg('sendMessage', { chat_id: g.chat_id, text: msg.text, parse_mode: 'HTML', reply_markup: msg.reply_markup, disable_web_page_preview: true });
  /* Guruh supergroup'ga aylangan — yangi ID bilan qayta */
  const moved = Number(r?.parameters?.migrate_to_chat_id);
  if (!r?.ok && Number.isSafeInteger(moved) && moved) {
    await setSetting(GROUP_KEY, { ...g, chat_id: moved });
    r = await tg('sendMessage', { chat_id: moved, text: msg.text, parse_mode: 'HTML', reply_markup: msg.reply_markup, disable_web_page_preview: true });
  }
  if (!r?.ok) return { ok: false, link, error: String(r?.description || 'Telegram xatosi') };
  await setSetting(key, { chat_id: Number(r.result?.chat?.id ?? g.chat_id), message_id: r.result?.message_id, at: new Date().toISOString() }).catch(() => {});
  return { ok: true, link };
}

/** Har kuni 20:00 dan keyin — ertangi kun havolasi (kuniga bir marta) */
export async function runSheetGroupEvening(nowMs = Date.now()): Promise<{ ran: boolean; reason?: string }> {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(nowMs))) % 24;
  if (h < 20) return { ran: false, reason: 'not time' };
  if (!(await getSheetGroup())) return { ran: false, reason: 'no group' };
  const date = addDaysYmd(tashkentYmdOf(nowMs), 1);
  const key = EVENING_PREFIX + date;
  const done = await supabaseRest<any[]>('admin_settings', { query: `?key=eq.${q(key)}&select=key&limit=1` }).catch(() => null);
  if (!done || done.length) return { ran: false, reason: 'sent' };
  try {
    await supabaseRest('admin_settings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ key, value: { at: new Date(nowMs).toISOString() }, updated_at: new Date(nowMs).toISOString() }) });
  } catch { return { ran: false, reason: 'sent' }; }
  const r = await postSheetToGroup(date, { mode: 'new', by: null });
  return { ran: r.ok, reason: r.error };
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */
type Deps = { currentStaff: (req: any) => Promise<any>; guardDesk: (req: any) => Promise<any> };

export async function registerSheetShareRoutes(app: FastifyInstance, deps: Deps) {
  /* Ochiq (havola bilan) — telefonda jadval sahifasi shu yerdan o'qiydi */
  app.get('/api/sheet-view', async (req: any, reply: any) => {
    const date = String(req.query?.d || '');
    const bad = checkSheetLink(date, String(req.query?.k || ''));
    if (bad) return reply.code(403).send({ ok: false, error: bad });
    try {
      const { publicSheetData } = await import('./booking-sheet-routes.js');
      const { dayTitle } = await import('./instructor-notify.js');
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Robots-Tag', 'noindex');
      return { ok: true, title: dayTitle(date), ...(await publicSheetData(date)) };
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: e?.message || 'Jadval yuklanmadi' });
    }
  });

  app.get('/api/admin/sheet-group', async (req: any, reply: any) => {
    try {
      await deps.guardDesk(req);
      const date = YMD.test(String(req.query?.date || '')) ? String(req.query.date) : tashkentYmdOf(Date.now());
      return { ok: true, group: await getSheetGroup(), bot: await instructorBotUsername(), link: sheetLinkUrl(date) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuklanmadi' });
    }
  });
  app.post('/api/admin/sheet-group-code', async (req: any, reply: any) => {
    try {
      const me = await deps.guardDesk(req);
      return { ok: true, ...(await newLinkCode(String(me?.login || ''))), bot: await instructorBotUsername() };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kod yaratilmadi' });
    }
  });
  app.delete('/api/admin/sheet-group', async (req: any, reply: any) => {
    try {
      await deps.guardDesk(req);
      await delSetting(GROUP_KEY);
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Uzilmadi' });
    }
  });
  app.post('/api/admin/sheet-share', async (req: any, reply: any) => {
    try {
      const me = await deps.guardDesk(req);
      const date = String(req.body?.date || '');
      if (!YMD.test(date)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      const r = await postSheetToGroup(date, { mode: 'new', by: me?.login || null });
      if (!r.ok) return reply.code(r.error === 'Guruh ulanmagan' ? 409 : 502).send({ ok: false, error: r.error, link: r.link });
      return { ok: true, link: r.link };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuborilmadi' });
    }
  });
}
