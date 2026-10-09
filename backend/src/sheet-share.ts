import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { tashkentYmdOf, addDaysYmd } from './instructor-schedule.js';
import type { SheetEvent } from './booking-sheet-routes.js';

/**
 * EXCEL BRON — GURUHGA TINIQ RASM + HAVOLA
 *
 * Muammo: adminlar Excel’dagi jadvalni guruhga tashlardi — telefonda Excel
 * ochilmaydi, skrinshot esa mayda va xira, o'qib bo'lmaydi.
 * Yechim: guruhga instruktor boti jadvalning TINIQ RASMINI tashlaydi
 * (sheet-image.ts: faqat bronli instruktorlar, katta qalin shrift; ko'p
 * bo'lsa albom) va «📋 Jadvalni ochish» tugmasini. Tugma telefonda jadval
 * sahifasini ochadi (/jadval) — u har doim ENG YANGI holatni ko'rsatadi.
 *
 * Qachon yuboriladi:
 *   • Excel bron sahifasidagi «Guruhga tashlash» tugmasi — yangi rasm(lar);
 *     o'sha kunning eski rasmi guruhdan o'chiriladi (chalkashmasin);
 *   • admin «Saqlash» bosganda — guruhda o'sha kun rasmi bo'lsa, JOYIDA
 *     yangilanadi (yangi xabar emas). Rasm soni o'zgarsa — «eski» deb
 *     belgilanadi, admin tugmani bosadi;
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
  if (!m[2]) return '🔗 Guruhni ulash: admin panel → Excel bron → «Guruh» tugmasidagi 6 xonali kodni yozing: /ulash 123456';
  const c = await getSetting<any>(CODE_KEY).catch(() => null);
  if (!c || String(c.code) !== m[2] || Date.parse(c.exp) < Date.now()) {
    return '⚠️ Kod noto‘g‘ri yoki eskirgan. Admin panel → Excel bron → «Guruh» dan yangi kod oling.';
  }
  await setSetting(GROUP_KEY, { chat_id: chat.id, title: chat.title || null, linked_at: new Date().toISOString(), linked_by: c.by || null });
  await delSetting(CODE_KEY).catch(() => {});
  return `✅ Guruh ulandi${chat.title ? `: «${chat.title}»` : ''}.\n\nExcel bron jadvali shu yerga tiniq rasm bo‘lib keladi. Rasm ostidagi «📋 Jadvalni ochish» tugmasi — telefonda eng yangi holat.`;
}

/* ------------------------------------------------------------------ */
/* Guruhga yuborish                                                    */
/* ------------------------------------------------------------------ */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] as string);
const hm = (ms: number) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));

/** Multipart (rasm bilan) Telegram so'rovi */
async function tgForm(method: string, fields: Record<string, unknown>, files: Array<{ name: string; png: Uint8Array }> = []): Promise<any> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  for (const f of files) form.append(f.name, new Blob([new Uint8Array(f.png)], { type: 'image/png' }), `${f.name}.png`);
  const r = await fetch(`https://api.telegram.org/bot${TOKEN()}/${method}`, { method: 'POST', body: form });
  return r.json();
}

/** Guruhdagi o'sha kun xabari(lar)i: rasm(lar), tugmali xabar yoki matn */
type GroupPost = { chat_id: number; photos: number[]; button_id: number | null; text_id: number | null; at: string; by: string | null };
const ids = (v: unknown): number[] => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
async function getPost(date: string): Promise<GroupPost | null> {
  const p = await getSetting<any>(MSG_PREFIX + date).catch(() => null);
  if (!p || !Number.isSafeInteger(Number(p.chat_id))) return null;
  /* oldingi ko'rinish: faqat havolali matn (message_id) */
  return { chat_id: Number(p.chat_id), photos: ids(p.photos), button_id: Number(p.button_id) || null, text_id: Number(p.text_id ?? p.message_id) || null, at: p.at || '', by: p.by || null };
}

const TAIL_TEXT = '👇 Bosing — telefonda jadval ochiladi (har doim eng yangi holat), raqamni bosib qo‘ng‘iroq qilasiz.';
/** Jadval → izoh matni, tugma va tiniq rasmlar */
export async function sheetContent(date: string, by?: string | null, nowMs = Date.now()) {
  const { publicSheetData } = await import('./booking-sheet-routes.js');
  const { dayTitle } = await import('./instructor-notify.js');
  const { buildSheetParts, renderSheetPngs } = await import('./sheet-image.js');
  const d = await publicSheetData(date);
  const s = d.stats;
  const title = dayTitle(date);
  const line = s.bron || s.band
    ? [s.bron ? `${s.bron} ta bron` : '', s.band ? `${s.band} ta band` : '', `${s.busy_instructors} instruktor`].filter(Boolean).join(' · ')
    : 'Hozircha bron yo‘q';
  const parts = buildSheetParts(d, { title, line, at: `${hm(nowMs)} holati`, nowMs });
  const pngs = await renderSheetPngs(parts);
  const caption = [`📅 <b>${esc(title)}</b>`, `📋 ${esc(line)}`, `🕘 ${hm(nowMs)} holati${by ? ` (${esc(by)})` : ''}`].join('\n');
  const reply_markup = { inline_keyboard: [[{ text: '📋 Jadvalni ochish', url: sheetLinkUrl(date) }]] };
  return { title, caption, reply_markup, pngs };
}
type Content = Awaited<ReturnType<typeof sheetContent>>;

/** Yangi xabar(lar): 1 rasm — tugma rasmning o'zida; ko'p rasm — albom + tugmali xabar; rasm yo'q — matn */
async function sendPost(chatId: number, c: Content): Promise<{ r: any; post?: Pick<GroupPost, 'photos' | 'button_id' | 'text_id'> }> {
  if (c.pngs.length === 1) {
    const r = await tgForm('sendPhoto', { chat_id: chatId, caption: c.caption, parse_mode: 'HTML', reply_markup: c.reply_markup }, [{ name: 'photo', png: c.pngs[0] }]);
    return { r, post: r?.ok ? { photos: ids([r.result?.message_id]), button_id: null, text_id: null } : undefined };
  }
  if (c.pngs.length > 1) {
    /* albomda ko'pi bilan 10 ta rasm (50 instruktordan ko'p bo'lsa — bir nechta albom) */
    const photos: number[] = [];
    let r: any = null;
    for (let at = 0; at < c.pngs.length; at += 10) {
      const part = c.pngs.slice(at, at + 10);
      if (part.length === 1) {                                              // yakka qolgan rasm — oddiy rasm
        r = await tgForm('sendPhoto', { chat_id: chatId }, [{ name: 'photo', png: part[0] }]);
        if (!r?.ok) return { r };
        photos.push(...ids([r.result?.message_id]));
        continue;
      }
      const media = part.map((_, i) => ({ type: 'photo', media: `attach://p${i}`, ...(at || i ? {} : { caption: c.caption, parse_mode: 'HTML' }) }));
      r = await tgForm('sendMediaGroup', { chat_id: chatId, media }, part.map((png, i) => ({ name: `p${i}`, png })));
      if (!r?.ok) return { r };
      photos.push(...ids((Array.isArray(r.result) ? r.result : []).map((m: any) => m?.message_id)));
    }
    const b = await tg('sendMessage', { chat_id: chatId, text: `👆 ${c.title} — ${c.pngs.length} ta rasm.\n${TAIL_TEXT}`, reply_markup: c.reply_markup, disable_web_page_preview: true }).catch(() => null);
    return { r, post: { photos, button_id: Number(b?.result?.message_id) || null, text_id: null } };
  }
  const r = await tg('sendMessage', { chat_id: chatId, text: `${c.caption}\n\n${TAIL_TEXT}`, parse_mode: 'HTML', reply_markup: c.reply_markup, disable_web_page_preview: true });
  return { r, post: r?.ok ? { photos: [], button_id: null, text_id: Number(r.result?.message_id) || null } : undefined };
}

/**
 * «Guruhga tashlash» (va 20:00): yangi rasm(lar). O'sha kunning guruhdagi
 * eski xabarlari o'chiriladi — guruhda bir kunga bitta, eng yangi jadval.
 */
export async function postSheetToGroup(date: string, o: { by?: string | null } = {}): Promise<{ ok: boolean; link: string; images: number; error?: string }> {
  const link = sheetLinkUrl(date);
  if (!TOKEN()) return { ok: false, link, images: 0, error: 'Instruktor boti tokeni yo‘q' };
  const g = await getSheetGroup();
  if (!g) return { ok: false, link, images: 0, error: 'Guruh ulanmagan' };
  const c = await sheetContent(date, o.by);
  const prev = await getPost(date);
  let chatId = g.chat_id;
  let { r, post } = await sendPost(chatId, c);
  /* Guruh supergroup'ga aylangan — yangi ID bilan qayta */
  const moved = Number(r?.parameters?.migrate_to_chat_id);
  if (!r?.ok && Number.isSafeInteger(moved) && moved) {
    await setSetting(GROUP_KEY, { ...g, chat_id: moved });
    chatId = moved;
    ({ r, post } = await sendPost(chatId, c));
  }
  if (!r?.ok || !post) return { ok: false, link, images: 0, error: String(r?.description || 'Telegram xatosi') };
  await setSetting(MSG_PREFIX + date, { chat_id: chatId, ...post, at: new Date().toISOString(), by: o.by || null }).catch(() => {});
  if (prev && prev.chat_id === chatId) {
    const old = [...prev.photos, prev.button_id, prev.text_id].filter((x): x is number => !!x);
    if (old.length) await tg('deleteMessages', { chat_id: chatId, message_ids: old }).catch(() => {});
  }
  return { ok: true, link, images: c.pngs.length };
}

/**
 * Saqlaganda: guruhda o'sha kun rasmi bo'lsa — JOYIDA yangilanadi.
 * 'updated' — yangilandi; 'stale' — rasm soni o'zgardi yoki tahrirlab
 * bo'lmadi (admin «Guruhga tashlash»ni bosadi); null — guruhda xabar yo'q.
 */
export async function refreshGroupPost(date: string, by?: string | null): Promise<'updated' | 'stale' | null> {
  if (!TOKEN()) return null;
  const g = await getSheetGroup();
  const prev = await getPost(date);
  if (!g || !prev || prev.chat_id !== g.chat_id) return null;
  const c = await sheetContent(date, by);
  const okOrSame = (r: any) => r?.ok || /not modified/i.test(String(r?.description || ''));
  if (prev.photos.length && c.pngs.length === prev.photos.length) {
    const single = prev.photos.length === 1;
    for (let i = 0; i < prev.photos.length; i++) {
      const media = { type: 'photo', media: 'attach://p', ...(i ? {} : { caption: c.caption, parse_mode: 'HTML' }) };
      const r = await tgForm('editMessageMedia', { chat_id: g.chat_id, message_id: prev.photos[i], media, ...(single ? { reply_markup: c.reply_markup } : {}) }, [{ name: 'p', png: c.pngs[i] }]);
      if (!okOrSame(r)) return 'stale';
    }
  } else if (!prev.photos.length && prev.text_id && !c.pngs.length) {
    const r = await tg('editMessageText', { chat_id: g.chat_id, message_id: prev.text_id, text: `${c.caption}\n\n${TAIL_TEXT}`, parse_mode: 'HTML', reply_markup: c.reply_markup, disable_web_page_preview: true });
    if (!okOrSame(r)) return 'stale';
  } else return 'stale';
  await setSetting(MSG_PREFIX + date, { ...prev, at: new Date().toISOString(), by: by || prev.by }).catch(() => {});
  return 'updated';
}

/**
 * HAR SAQLASHDA (admin Excel bron yoki instruktor boti): guruhga YANGI xabar —
 * faqat o'zgargan instruktor(lar)ning o'sha kungi jadvali (tiniq rasm, o'zgargan
 * kataklar to'q sariq ramkada) va izohda nima o'zgargani. Foydalanuvchi
 * so'rovi: «har yangilanganda guruhga o'sha yangilangan instruktorniki borsin».
 */
export async function postSheetChanges(date: string, events: Map<string, SheetEvent>, by?: string | null): Promise<'sent' | null> {
  if (!TOKEN()) return null;
  const ids = [...events.entries()].filter(([, e]) => e.created.length || e.cancelled.length || e.notes.length).map(([id]) => id);
  if (!ids.length) return null;
  const g = await getSheetGroup();
  if (!g) return null;
  const { publicSheetData } = await import('./booking-sheet-routes.js');
  const { dayTitle } = await import('./instructor-notify.js');
  const { buildSheetParts, renderSheetPngs } = await import('./sheet-image.js');
  const d = await publicSheetData(date);
  const name = new Map(d.instructors.map((i) => [String(i.id), i.name]));
  const hourOf = (iso: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', hour12: false }).format(new Date(iso))) % 24;
  const span = (start: string, minutes: number) => `${hm(Date.parse(start))}–${hm(Date.parse(start) + minutes * 60000)}`;
  const ph = (p?: string | null) => { const m = /(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(String(p || '').replace(/\D/g, '')); return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4]}` : ''; };
  const marks: Record<string, number[]> = {};
  const lines: string[] = [];
  for (const id of ids) {
    const e = events.get(id)!, hs = new Set<number>(), out: string[] = [];
    for (const c of e.created) {
      for (let h = hourOf(c.start); h < hourOf(c.start) + Math.max(1, Math.ceil(c.minutes / 60)); h++) hs.add(h);
      out.push(`✅ ${span(c.start, c.minutes)} ${ph(c.phone)}${c.category ? ` · ${esc(c.category)}` : ''}${c.minutes !== 60 ? ` · ${c.minutes < 60 ? `${c.minutes} daq` : `${c.minutes / 60} soat`}` : ''}`);
    }
    for (const c of e.cancelled) {
      for (let h = hourOf(c.start); h < hourOf(c.start) + Math.max(1, Math.ceil(c.minutes / 60)); h++) hs.add(h);
      out.push(`❌ ${span(c.start, c.minutes)} bekor`);
    }
    for (const n of e.notes) { hs.add(n.h); out.push(n.removed ? `🔓 ${n.h}:00 bo‘shadi` : `📌 ${n.h}:00 «${esc(n.text)}»`); }
    marks[id] = [...hs];
    lines.push(`👤 <b>${esc(name.get(id) || 'Instruktor')}</b>: ${out.join('; ')}`);
  }
  const title = dayTitle(date);
  const parts = buildSheetParts(d, { title, line: `O‘zgardi: ${ids.map((id) => name.get(id) || '').filter(Boolean).join(', ')}`, at: `${hm(Date.now())} holati`, only: ids, marks });
  const pngs = await renderSheetPngs(parts);
  let caption = [`✏️ <b>Jadval yangilandi</b> — ${esc(title)}`, ...lines, `🕘 ${hm(Date.now())}${by ? ` (${esc(by)})` : ''}`].join('\n');
  if (caption.length > 1000) caption = caption.slice(0, 990) + '…';
  const reply_markup = { inline_keyboard: [[{ text: '📋 Butun jadvalni ochish', url: sheetLinkUrl(date) }]] };
  let { r } = await sendPost(g.chat_id, { title, caption, reply_markup, pngs });
  const moved = Number(r?.parameters?.migrate_to_chat_id);
  if (!r?.ok && Number.isSafeInteger(moved) && moved) {
    await setSetting(GROUP_KEY, { ...g, chat_id: moved });
    ({ r } = await sendPost(moved, { title, caption, reply_markup, pngs }));
  }
  return r?.ok ? 'sent' : null;
}

/** Saqlashdan keyin guruh: o'zgarish xabari + o'sha kun rasmi joyida yangilanadi */
export async function afterSheetSave(date: string, events: Map<string, SheetEvent>, by?: string | null): Promise<string | null> {
  if (!(await getSheetGroup())) return null;
  const sent = await postSheetChanges(date, events, by).catch((e) => { console.error('sheet changes post failed:', e); return null; });
  const refreshed = await refreshGroupPost(date, by).catch(() => 'stale' as const);
  return sent ? (refreshed === 'stale' ? 'sent+stale' : 'sent') : refreshed;
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
  const r = await postSheetToGroup(date, { by: null });
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
  /* Guruhga boradigan rasmni oldindan ko'rish / yuklab olish: ?date=&i=0 */
  app.get('/api/admin/sheet-image', async (req: any, reply: any) => {
    try {
      await deps.guardDesk(req);
      const date = String(req.query?.date || '');
      if (!YMD.test(date)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      const c = await sheetContent(date);
      const i = Math.max(0, Math.min(c.pngs.length - 1, Number(req.query?.i) || 0));
      reply.header('Cache-Control', 'no-store');
      return { ok: true, count: c.pngs.length, i, image: c.pngs.length ? `data:image/png;base64,${Buffer.from(c.pngs[i]).toString('base64')}` : null };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Rasm chizilmadi' });
    }
  });
  app.post('/api/admin/sheet-share', async (req: any, reply: any) => {
    try {
      const me = await deps.guardDesk(req);
      const date = String(req.body?.date || '');
      if (!YMD.test(date)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      const r = await postSheetToGroup(date, { by: me?.login || null });
      if (!r.ok) return reply.code(r.error === 'Guruh ulanmagan' ? 409 : 502).send({ ok: false, error: r.error, link: r.link });
      return { ok: true, link: r.link, images: r.images };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Yuborilmadi' });
    }
  });
}
