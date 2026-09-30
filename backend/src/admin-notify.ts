/**
 * ADMIN BOTI — YANGI BRON XABARI.
 *
 * Mijoz Mini App orqali bron qilsa, admin botiga (telegram_admins dagi
 * har bir faol chat) darhol TO'LIQ ma'lumot boradi: kim, telefoni, qaysi
 * instruktorga, qaysi mashinada, qaysi kuni soat nechaga, narxi, bron
 * kodi. Xabar ostida «Admin panelni ochish» tugmasi — bosilsa panel
 * to'g'ridan-to'g'ri «Yangi bronlar» ro'yxatida ochiladi.
 *
 * Xabar ketmasa ham bron yaratiladi — bu yerdagi xato asosiy oqimni
 * to'xtatmaydi.
 */
import { supabaseRest } from './supabase.js';
import { telegramApi } from './telegram.js';
import { fmtWhen, fmtMoney } from './notify.js';
import { durText } from './packages.js';

const TZ = 'Asia/Tashkent';
const enc = encodeURIComponent;

export const adminBotToken = () =>
  String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim();

/** Admin panel manzili. `open` — panel ochilganda qaysi bo'lim ko'rsatilsin (masalan, bookings/new). */
export function adminPanelUrl(open?: string): string {
  const base = String(process.env.ADMIN_MINI_APP_URL || 'https://avtodrom.vercel.app/admin').trim();
  if (!open) return base;
  try {
    const u = new URL(base);
    u.searchParams.set('open', open);
    u.hash = '';
    return u.toString();
  } catch {
    return base;
  }
}

/** Xabar oladigan chatlar: telegram_admins (faqat faollari) + ixtiyoriy ADMIN_TELEGRAM_CHAT_IDS. */
export async function adminChatIds(): Promise<number[]> {
  const out = new Set<number>();
  try {
    const rows = await supabaseRest<any[]>('telegram_admins', { query: '?is_active=eq.true&select=telegram_chat_id' });
    for (const r of rows) {
      const n = Number(r?.telegram_chat_id);
      if (Number.isSafeInteger(n) && n !== 0) out.add(n);
    }
  } catch (e) {
    console.error('telegram_admins o‘qilmadi:', e);
  }
  for (const s of String(process.env.ADMIN_TELEGRAM_CHAT_IDS || '').split(/[\s,;]+/)) {
    const n = Number(s);
    if (s && Number.isSafeInteger(n) && n !== 0) out.add(n);
  }
  return [...out];
}

export const escHtml = (v: unknown) =>
  String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** web_app tugmasi faqat shaxsiy chatda ishlaydi — guruhda oddiy havola beramiz. */
export function panelButton(chatId: number, text: string, url: string) {
  return chatId > 0 ? { text, web_app: { url } } : { text, url };
}

export interface AdminSendResult { chats: number; sent: number; failed: number; errors: string[]; skipped?: string }

/** Bitta chatga yuboradi. HTML xato bo'lsa — oddiy matn bilan qayta urinadi. */
export async function sendToAdminChat(token: string, chatId: number, text: string, opts: { html?: boolean; open?: string; button?: string } = {}) {
  const markup = { inline_keyboard: [[panelButton(chatId, opts.button || '🛡️ Admin panelni ochish', adminPanelUrl(opts.open))]] };
  const base = { chat_id: chatId, disable_web_page_preview: true, reply_markup: markup };
  try {
    return await telegramApi(token, 'sendMessage', { ...base, text, ...(opts.html ? { parse_mode: 'HTML' } : {}) });
  } catch (e: any) {
    if (!opts.html || !/parse|entit/i.test(String(e?.message || ''))) throw e;
    const plain = text.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    return telegramApi(token, 'sendMessage', { ...base, text: plain });
  }
}

/** Barcha faol admin chatlarga xabar. Hech qachon xato otmaydi — natijani qaytaradi. */
export async function notifyAdmins(text: string, opts: { html?: boolean; open?: string; button?: string } = {}): Promise<AdminSendResult> {
  const res: AdminSendResult = { chats: 0, sent: 0, failed: 0, errors: [] };
  const token = adminBotToken();
  if (!token) return { ...res, skipped: 'ADMIN_BOT_TOKEN sozlanmagan' };
  const ids = await adminChatIds();
  res.chats = ids.length;
  if (!ids.length) return { ...res, skipped: 'Admin chat qo‘shilmagan' };
  await Promise.all(ids.map(async (chatId) => {
    try {
      await sendToAdminChat(token, chatId, text, opts);
      res.sent++;
    } catch (e: any) {
      res.failed++;
      res.errors.push(`${chatId}: ${String(e?.message || e)}`);
      console.error(`Admin chat ${chatId} ga xabar ketmadi:`, e);
    }
  }));
  return res;
}

/* ---------------------------- matn yordamchilari ---------------------------- */

/** "11:00" — Toshkent vaqtida. */
export function hmTashkent(value: unknown): string {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

/** "3-oktabr, juma · 10:00–11:00" */
export function whenRange(start: unknown, end: unknown): string {
  const w = fmtWhen(start);
  const e = hmTashkent(end);
  return w && e ? `${w}–${e}` : w;
}

/** +998901112233 → +998 90 111 22 33 */
export function fmtPhone(p: unknown): string {
  const s = String(p ?? '').trim();
  const m = /^\+?998(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(s.replace(/[\s()-]/g, ''));
  return m ? `+998 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : s;
}

/** "2 soat 15 daqiqadan keyin" */
export function untilText(start: unknown, nowMs = Date.now()): string {
  const t = typeof start === 'number' ? start : new Date(String(start ?? '')).getTime();
  if (!Number.isFinite(t)) return '';
  const min = Math.round((t - nowMs) / 60000);
  if (min <= 0) return 'hozir';
  if (min < 60) return `${min} daqiqadan keyin`;
  if (min >= 1440) return `${Math.floor(min / 1440)} kundan keyin`;
  const h = Math.floor(min / 60), r = min % 60;
  return r ? `${h} soat ${r} daqiqadan keyin` : `${h} soatdan keyin`;
}

export interface AdminBookingContext {
  customer: { name: string; phone: string };
  instructor: { name: string; phone: string; vehicle: string };
  course: { name: string; category: string };
  history: { prior: number; completed: number; noShow: number; cancelled: number };
}

/** Xabar uchun hamma ma'lumotni bazadan yig'adi. Bittasi topilmasa ham qolganlari chiqadi. */
export async function loadAdminContext(booking: any, excludeIds: string[] = []): Promise<AdminBookingContext> {
  const ctx: AdminBookingContext = {
    customer: { name: '', phone: '' },
    instructor: { name: String(booking?.instructor_name || ''), phone: '', vehicle: '' },
    course: { name: '', category: String(booking?.category || '').toUpperCase() },
    history: { prior: 0, completed: 0, noShow: 0, cancelled: 0 },
  };
  const one = async (table: string, query: string) => {
    try { return (await supabaseRest<any[]>(table, { query }))[0] ?? null; } catch (e) { console.error(`admin-notify: ${table}`, e); return null; }
  };
  const [cust, ip, course, hist] = await Promise.all([
    booking?.customer_id ? one('users', `?id=eq.${enc(String(booking.customer_id))}&select=full_name,phone&limit=1`) : null,
    booking?.instructor_id ? one('instructor_profiles', `?id=eq.${enc(String(booking.instructor_id))}&select=user_id,vehicle_model,vehicle_plate&limit=1`) : null,
    booking?.course_id ? one('courses', `?id=eq.${enc(String(booking.course_id))}&select=name,category&limit=1`) : null,
    booking?.customer_id
      ? supabaseRest<any[]>('bookings', { query: `?customer_id=eq.${enc(String(booking.customer_id))}&select=id,status` }).catch(() => [] as any[])
      : Promise.resolve([] as any[]),
  ]);
  if (cust) { ctx.customer.name = String(cust.full_name || ''); ctx.customer.phone = fmtPhone(cust.phone); }
  if (course) { ctx.course.name = String(course.name || ''); if (!ctx.course.category) ctx.course.category = String(course.category || '').toUpperCase(); }
  if (ip) {
    ctx.instructor.vehicle = [ip.vehicle_model, ip.vehicle_plate].map((x: any) => String(x ?? '').trim()).filter(Boolean).join(' · ');
    if (ip.user_id) {
      const iu = await one('users', `?id=eq.${enc(String(ip.user_id))}&select=full_name,phone&limit=1`);
      if (iu) { ctx.instructor.name = String(iu.full_name || ctx.instructor.name); ctx.instructor.phone = fmtPhone(iu.phone); }
    }
  }
  const skip = new Set([String(booking?.id ?? ''), ...excludeIds.map(String)]);
  for (const b of hist || []) {
    if (skip.has(String(b.id))) continue;
    ctx.history.prior++;
    if (b.status === 'completed') ctx.history.completed++;
    else if (b.status === 'no_show') ctx.history.noShow++;
    else if (b.status === 'cancelled' || b.status === 'rejected') ctx.history.cancelled++;
  }
  return ctx;
}

function historyLine(h: AdminBookingContext['history']): string {
  if (!h.prior) return '🌱 Yangi mijoz — birinchi broni';
  const parts = [`${h.completed} tasi o‘tgan`];
  if (h.noShow) parts.push(`${h.noShow} tasida kelmagan`);
  if (h.cancelled) parts.push(`${h.cancelled} tasi bekor`);
  return `🔁 Oldin ${h.prior} marta bron qilgan · ${parts.join(', ')}`;
}

/**
 * Admin uchun to'liq matn (HTML). Bitta bron yoki paket (bir nechta bron).
 * `nowMs` — test uchun.
 */
export function adminNewBookingText(
  bookings: any[],
  ctx: AdminBookingContext,
  opts: { packagePrice?: number; listPrice?: number; nowMs?: number } = {},
): string {
  const first = bookings[0] ?? {};
  const isPkg = bookings.length > 1 || opts.packagePrice !== undefined;
  const totalMin = bookings.reduce((s, b) => s + (Number(b?.duration_minutes) || Math.round((Date.parse(b?.end_at) - Date.parse(b?.start_at)) / 60000) || 0), 0);
  const L: string[] = [];

  L.push(`🆕 <b>YANGI BRON</b>${isPkg ? ' · 5 soatlik paket' : ''} · Mini App`);
  L.push('');
  L.push(`👤 <b>${escHtml(ctx.customer.name || 'Mijoz')}</b>`);
  if (ctx.customer.phone) L.push(`📞 ${escHtml(ctx.customer.phone)}`);
  L.push(historyLine(ctx.history));
  L.push('');

  const ins = ctx.instructor.name ? `<b>${escHtml(ctx.instructor.name)}</b>` : 'tanlanmagan';
  L.push(`👨‍🏫 Instruktor: ${ins}${ctx.instructor.phone ? ` · ${escHtml(ctx.instructor.phone)}` : ''}`);
  if (ctx.instructor.vehicle) L.push(`🚘 ${escHtml(ctx.instructor.vehicle)}`);

  const cat = ctx.course.category ? `${ctx.course.category} toifa` : (ctx.course.name || '');
  const dur = totalMin > 0 ? durText(totalMin) : '';
  const courseLine = [cat, dur, isPkg ? `${bookings.length} ta mashg‘ulot` : ''].filter(Boolean).join(' · ');
  if (courseLine) L.push(`📚 ${escHtml(courseLine)}`);

  if (isPkg) {
    L.push('📅 Mashg‘ulotlar:');
    bookings.forEach((b, i) => {
      const code = b?.pickup_code ? ` · <code>${escHtml(b.pickup_code)}</code>` : '';
      L.push(`   ${i + 1}) ${escHtml(whenRange(b?.start_at, b?.end_at))}${code}`);
    });
  } else {
    L.push(`📅 <b>${escHtml(whenRange(first.start_at || first.booking_date, first.end_at))}</b>`);
  }
  /* Dars yaqin bo'lsa — admin darhol ko'rsin */
  const startMs = Date.parse(first.start_at || first.booking_date);
  const leftMin = Number.isFinite(startMs) ? Math.round((startMs - (opts.nowMs ?? Date.now())) / 60000) : Infinity;
  if (leftMin < 180) L.push(`⚡ <b>Dars ${escHtml(untilText(startMs, opts.nowMs))}</b> — tezroq tasdiqlang`);
  else if (leftMin < 1440) L.push(`⏰ Dars ${escHtml(untilText(startMs, opts.nowMs))}`);

  const price = isPkg ? Number(opts.packagePrice ?? 0) : Number(first.price ?? 0);
  const money = fmtMoney(price);
  if (money) {
    const was = isPkg && Number(opts.listPrice) > price ? ` (odatda ${fmtMoney(opts.listPrice)})` : '';
    L.push(`💵 ${escHtml(money + was)}`);
  }
  /* Paketda izoh boshida avtomatik «5 soatlik paket · 1/2-mashg‘ulot» turadi — uni tashlab, faqat mijoz yozganini ko'rsatamiz */
  const note = String(first.customer_note || '').replace(/^5 soatlik paket · (?:\d+\/\d+-mashg‘ulot|bir kunda)(?: · )?/, '').trim();
  if (note) L.push(`💬 Izoh: ${escHtml(note.slice(0, 300))}`);
  if (!isPkg && first.pickup_code) L.push(`🎫 Bron kodi: <code>${escHtml(first.pickup_code)}</code>`);

  L.push('');
  L.push('⏳ <b>Tasdiqlash kutilmoqda</b> — admin panelda tasdiqlang yoki rad eting.');
  const created = fmtWhen(first.created_at || new Date(opts.nowMs ?? Date.now()).toISOString());
  if (created) L.push(`🕒 Bron qilindi: ${escHtml(created)}`);
  return L.join('\n');
}

/**
 * Mini App'dan kelgan yangi bron (yoki paket) haqida adminlarga xabar.
 * Hech qachon xato otmaydi.
 */
export async function notifyAdminsNewBooking(
  bookings: any[],
  opts: { packagePrice?: number; listPrice?: number } = {},
): Promise<AdminSendResult> {
  try {
    const list = (bookings || []).filter(Boolean);
    if (!list.length) return { chats: 0, sent: 0, failed: 0, errors: [], skipped: 'bron yo‘q' };
    if (!adminBotToken()) return { chats: 0, sent: 0, failed: 0, errors: [], skipped: 'ADMIN_BOT_TOKEN sozlanmagan' };
    const ctx = await loadAdminContext(list[0], list.map((b) => String(b.id)));
    const text = adminNewBookingText(list, ctx, opts);
    return await notifyAdmins(text, { html: true, open: 'bookings/new', button: '🛡️ Admin panelda ochish' });
  } catch (e: any) {
    console.error('Yangi bron — admin xabari ketmadi:', e);
    return { chats: 0, sent: 0, failed: 1, errors: [String(e?.message || e)] };
  }
}
