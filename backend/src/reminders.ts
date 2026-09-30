import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import { telegramApi } from './telegram.js';
import { loadBookingDetails, fmtWhen, fmtMoney, shortCode } from './notify.js';
import { notifyAdmins } from './admin-notify.js';

/**
 * DARS OLDIDAN ESLATMA VA KECHIKISH QOIDASI
 *
 * 60 / 30 / 20 daqiqa qolganda (sozlamadan o'zgartiriladi) mijozga
 * Telegram xabari va ikkita tugma:
 *   «✅ Kelaman»            → attendance_confirmed_at yoziladi
 *   «🚫 Bekor qilmoqchiman» → admin uchun bekor so'rovi ochiladi
 *
 * Takrorlanishdan himoya: `booking_reminders` jadvalidagi
 * UNIQUE (booking_id, kind). Yozuv AVVAL qo'yiladi, keyin xabar yuboriladi —
 * shunda rejalashtiruvchi bir vaqtda ikki marta ishga tushsa ham
 * ikkinchisi UNIQUE'ga urilib to'xtaydi va xabar takrorlanmaydi.
 */

/** Standart: 1 soat, 30 daqiqa va 20 daqiqa qolganda. */
export const DEFAULT_KINDS = [60, 30, 20];
/** Mijoz shuncha daqiqa kechiksa bron avtomatik yopiladi (0 — o'chirilgan). */
export const DEFAULT_LATE_MIN = 15;
/** Eslatma yuboriladigan bron holatlari. */
export const REMIND_STATUSES = ['pending', 'confirmed'] as const;
export type ReminderConfig = { kinds: number[]; lateMin: number };

/** admin_settings: reminder_minutes ([60,30,20] yoki "60,30,20"), late_cancel_min (15). */
export async function loadReminderConfig(): Promise<ReminderConfig> {
  const rows = await supabaseRest<any[]>('admin_settings', {
    query: '?key=in.(reminder_minutes,late_cancel_min)&select=key,value',
  }).catch(() => [] as any[]);
  const val = (k: string) => {
    const v = rows.find((r) => r.key === k)?.value;
    return v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? (v as any).value : v;
  };
  let raw: any = val('reminder_minutes');
  if (typeof raw === 'string') raw = raw.split(/[^\d]+/).filter(Boolean);
  let kinds = Array.isArray(raw)
    ? [...new Set(raw.map(Number).filter((n: number) => Number.isInteger(n) && n >= 5 && n <= 720))] as number[]
    : [];
  kinds = kinds.sort((a, b) => b - a).slice(0, 5);
  if (!kinds.length) kinds = [...DEFAULT_KINDS];
  const lr = val('late_cancel_min');
  const ln = lr === undefined || lr === null || lr === '' ? DEFAULT_LATE_MIN : Number(lr);
  const lateMin = Number.isInteger(ln) && ln >= 0 && ln <= 180 ? ln : DEFAULT_LATE_MIN;
  return { kinds, lateMin };
}

/** Ogohlantirish qatori — eslatma va tasdiq xabarlarida. */
export function lateRuleText(lateMin = DEFAULT_LATE_MIN) {
  return lateMin > 0 ? `⚠️ Dars vaqtidan ${lateMin} daqiqa kechiksangiz, bron avtomatik bekor qilinadi.` : '';
}

const q = (v: string) => encodeURIComponent(v);
const token = () => String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
const miniApp = () => String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');

/** «Darsingizga N daqiqa qoldi» — haqiqiy qolgan vaqt bilan.
 *  Bron dars boshlanishiga 45 daqiqa qolganda qilingan bo'lsa,
 *  «1 soat qoldi» deb noto'g'ri yozmaymiz. */
export function leftText(minutesLeft: number) {
  const m = Math.max(1, Math.round(minutesLeft));
  if (m <= 12) return `⏰ Darsingiz ${m} daqiqadan keyin!`;
  if (m < 55) return `⏰ Darsingizga ${m} daqiqa qoldi`;
  if (m <= 70) return '⏰ Darsingizga 1 soat qoldi';
  const h = Math.floor(m / 60), r = m % 60;
  if (m < 24 * 60) return `⏰ Darsingizga ${h} soat${r >= 5 ? ` ${r} daqiqa` : ''} qoldi`;
  return '⏰ Darsingizni unutmang';
}

/** Eslatma matni. `from` berilsa — instruktor qo'lda yuborgan eslatma. */
export function reminderText(minutesLeft: number, booking: any, d: any, from?: string, lateMin = DEFAULT_LATE_MIN) {
  const lines: string[] = [];
  if (from) lines.push(`🔔 ${from} eslatmoqda`);
  lines.push(leftText(minutesLeft), '');
  if (d.courseName) lines.push(`📚 ${d.courseName}`);
  if (d.instructorName) lines.push(`👨‍🏫 ${d.instructorName}`);
  const when = fmtWhen(booking.start_at || booking.booking_date);
  if (when) lines.push(`📅 ${when}`);
  const price = fmtMoney(d.price);
  if (price) lines.push(`💵 ${price}`);
  const code = String(booking.pickup_code || '').trim();
  if (code) lines.push(`🔑 Kassa kodi: ${code}`);
  if (String(booking.status) === 'pending') lines.push('', 'ℹ️ Broningiz qabul qilingan — kassada tasdiqlanadi.');
  const rule = lateRuleText(lateMin);
  if (rule) lines.push('', rule);
  lines.push('', reminderCallbacksOn() ? 'Iltimos, javob bering:' : 'Kela olmasangiz, Mini App orqali bronni bekor qiling.');
  return lines.join('\n');
}
/** Callback tugmalari faqat webhook Vercel'ga ulanganda (REMINDER_CALLBACKS=1) */
export const reminderCallbacksOn = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.REMINDER_CALLBACKS || '').toLowerCase());

/* Eslatma ostidagi tugmalar. Mijoz botining webhook'i Vercel'ga emas,
   Supabase edge-funksiyasiga ulangan bo'lishi mumkin — u holda
   callback (Kelaman / Bekor) tugmalari serverga YETIB KELMAYDI va mijoz
   bosganda hech narsa bo'lmaydi. Shuning uchun standart holatda faqat
   Mini App tugmasi (u har doim ishlaydi); callback tugmalari faqat
   REMINDER_CALLBACKS=1 bo'lganda (webhook Vercel'ga ulanganda) chiqadi. */
export function reminderKeyboard(bookingId: string) {
  const cb = reminderCallbacksOn();
  const rows: any[] = [];
  if (cb) rows.push([{ text: '✅ Kelaman', callback_data: `come:${bookingId}` }], [{ text: '🚫 Bekor qilmoqchiman', callback_data: `cxl:${bookingId}` }]);
  if (miniApp()) rows.push([{ text: cb ? '🚗 Mini Appni ochish' : '🚗 Bronlarimni ochish', web_app: { url: miniApp() } }]);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/**
 * Muddati kelgan eslatmalarni yuboradi.
 * Rejalashtiruvchi buni bir necha daqiqada bir marta chaqiradi.
 * Bir necha marta chaqirilishi xavfsiz (idempotent).
 */
export async function sendDueReminders(nowMs = Date.now(), cfg?: ReminderConfig) {
  const bot = token();
  const result = { checked: 0, sent: 0, skipped: 0, failed: 0, no_telegram: 0, details: [] as string[] };
  if (!bot) { result.details.push('CUSTOMER_BOT_TOKEN sozlanmagan'); return result; }
  const { kinds, lateMin } = cfg || await loadReminderConfig();
  const maxKind = Math.max(...kinds);

  // Eng katta eslatma oralig'ida boshlanadigan HAR BIR faol bron — tasdiqlangan
  // ham, hali kutilayotgan (pending) ham. Ilgari faqat `confirmed`
  // olinardi: admin tasdiqlamagan bronlar egasiga eslatma umuman
  // bormasdi. `select=*` — pickup_code kabi ixtiyoriy ustunlar
  // bazada bo'lmasa ham so'rov yiqilmasin.
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + (maxKind + 5) * 60 * 1000).toISOString();
  const bookings = await supabaseRest<any[]>('bookings', {
    query:
      `?status=in.(${REMIND_STATUSES.join(',')})&start_at=gte.${q(from)}&start_at=lte.${q(to)}` +
      '&select=*&order=start_at.asc&limit=200',
  });
  result.checked = bookings.length;
  if (!bookings.length) return result;

  // Allaqachon yuborilganlar
  const ids = bookings.map((b) => String(b.id));
  const sentRows = await supabaseRest<any[]>('booking_reminders', {
    query: `?booking_id=in.(${ids.map(q).join(',')})&select=booking_id,kind`,
  });
  const already = new Set(sentRows.map((r) => `${r.booking_id}:${r.kind}`));

  for (const b of bookings) {
    // Bekor so'rovi ochiq bo'lsa bezovta qilmaymiz
    if (b.cancel_requested_at && !b.cancel_reviewed_at) { result.skipped++; continue; }

    const startMs = new Date(b.start_at || b.booking_date).getTime();
    const minutesLeft = Math.floor((startMs - nowMs) / 60000);

    // Mos keladigan eng kichik oraliq: 20 daq qolganda 20-eslatma ketadi.
    // Bron dars oldidan kech qilingan bo'lsa (25 daq qoldi) — faqat bittasi (30).
    const kind = kinds.filter((k) => minutesLeft <= k).sort((a, x) => a - x)[0];
    if (!kind) { result.skipped++; continue; }
    if (minutesLeft < 0) { result.skipped++; continue; }
    if (already.has(`${b.id}:${kind}`)) { result.skipped++; continue; }

    // AVVAL yozuv — takrorlanishning oldini oladi
    try {
      await supabaseRest('booking_reminders', {
        method: 'POST',
        body: JSON.stringify({ booking_id: b.id, kind }),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // UNIQUE'ga urildi = boshqa chaqiruv allaqachon yubordi
      if (/duplicate key|23505|Supabase 409/i.test(msg)) { result.skipped++; continue; }
      // Boshqa xato (jadval/ustun yo'q) — JIM o'tkazib yubormaymiz,
      // aks holda eslatma hech qachon ketmaydi va hech kim bilmaydi.
      result.failed++;
      result.details.push(`booking_reminders jadvali xatosi: ${msg}`);
      continue;
    }

    try {
      const u = (await supabaseRest<any[]>('users', {
        query: `?id=eq.${q(String(b.customer_id))}&select=telegram_id&limit=1`,
      }))[0];
      const chatId = Number(u?.telegram_id);
      if (!Number.isSafeInteger(chatId) || chatId <= 0) {
        // Kassada qo'lda yozilgan mijoz — Telegrami yo'q, xabar yuborib bo'lmaydi
        result.no_telegram++;
        result.details.push(`${shortCode(b.id)} → Telegram yo‘q`);
        continue;
      }

      const d = await loadBookingDetails(b);
      await telegramApi(bot, 'sendMessage', {
        chat_id: chatId,
        text: reminderText(minutesLeft, b, d, undefined, lateMin),
        reply_markup: reminderKeyboard(String(b.id)),
      });
      result.sent++;
      result.details.push(`${shortCode(b.id)} → ${kind} daq`);
    } catch (e) {
      result.failed++;
      result.details.push(`${shortCode(b.id)} ${kind}daq XATO: ${e instanceof Error ? e.message : e}`);
      await supabaseRest('booking_reminders', {
        method: 'PATCH',
        query: `?booking_id=eq.${q(String(b.id))}&kind=eq.${kind}`,
        body: JSON.stringify({ telegram_ok: false }),
      }).catch(() => {});
    }
  }
  return result;
}

/* =====================================================================
   ISHGA TUSHIRISH
   Eslatma faqat kimdir `sendDueReminders`ni chaqirganda ketadi.
   Vercel Hobby cron'i kuniga 1 marta ishlaydi — bu yetmaydi. Shuning
   uchun uch manba bor, hammasi xavfsiz (takror xabar ketmaydi):
     1) /api/cron/reminders — Supabase pg_cron yoki Vercel cron;
     2) ochiq turgan admin/kassa paneli har 2 daqiqada «tick» yuboradi;
     3) ochiq turgan instruktor paneli ham shunday qiladi.
   Oxirgi ishga tushish vaqti admin_settings'ga yoziladi — admin
   «Eslatmalar» kartasida tizim ishlayaptimi, darhol ko'radi.
   ===================================================================== */

export const LAST_RUN_KEY = 'reminders_last_run';

/* =====================================================================
   KECHIKKAN BRONLAR — AVTOMATIK YOPISH
   Dars vaqtidan `lateMin` (15) daqiqa o'tdi, mijoz kelmadi (dars
   boshlanmadi) — bron o'z-o'zidan yopiladi, instruktor soati bo'shaydi:
     tasdiqlangan → «Kelmagan» (no_show; to'langan pul hisobotda qoladi)
     tasdiqlanmagan (pending) → «Bekor qilingan»
   Mijozga (va instruktorga) Telegram orqali xabar ketadi. Eski, unutilib
   qolgan bronlar (3 soatdan oldingilar) jimgina yopiladi — kechagi
   bron uchun bugun xabar yuborilmaydi.
   ISTISNO: kassada «hozir» chiqarilgan chek (bron emas) — mijoz joyida,
   instruktor skanerlashini kutadi. U faqat ertasigacha ochiq qolib
   ketsa yopiladi.
   Takrorlanishdan himoya: PATCH faqat holat hali o'zgarmagan bo'lsa
   (`status=eq.<eski>`) ishlaydi — ikki jarayon bir vaqtda ishlasa ham
   xabar bir marta ketadi.
   ===================================================================== */
export async function closeLateBookings(nowMs = Date.now(), cfg?: ReminderConfig) {
  const { lateMin } = cfg || await loadReminderConfig();
  const out = { checked: 0, closed: 0, no_show: 0, cancelled: 0, notified: 0, skipped: 0, details: [] as string[] };
  if (!(lateMin > 0)) return out;
  const cutoff = new Date(nowMs - lateMin * 60000).toISOString();
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?status=in.(pending,confirmed)&start_at=lt.${q(cutoff)}&select=*&order=start_at.asc&limit=300`,
  });
  out.checked = rows.length;
  /* TO'LANGAN bronlar 15 daqiqa qoidasi bilan yopilmaydi: mijoz pulini
     to'lagan (oldindan yoki kassada), instruktor chekni kechroq skanerlashi
     mumkin. Ular faqat dars tugagandan 12 soat o'tib, jimgina yopiladi. */
  const paid = new Set<string>();
  try {
    const pays = await selectIn<any>('payments', 'booking_id', rows.map((b) => String(b.id)), 'booking_id,status');
    for (const p of pays) if (String(p.status) === 'paid') paid.add(String(p.booking_id));
  } catch (e) { console.error('late-close: payments o‘qilmadi', e); }
  for (const b of rows) {
    const startMs = new Date(b.start_at || b.booking_date).getTime();
    if (!Number.isFinite(startMs)) { out.skipped++; continue; }
    // Mijoz kelgan deb belgilangan, lekin dars boshlanmagan — xodim hal qiladi
    if (b.arrived_at) { out.skipped++; continue; }
    const createdMs = new Date(b.created_at || '').getTime();
    const walkNow = String(b.source || '') === 'walk_in' && Number.isFinite(createdMs) && startMs - createdMs < 10 * 60000;
    const isPaid = paid.has(String(b.id));
    if (walkNow || isPaid) {
      const endMs = new Date(b.end_at || '').getTime() || startMs + 3600e3;
      if (nowMs < endMs + 12 * 3600e3) { out.skipped++; continue; }
    }
    const next = String(b.status) === 'pending' ? 'cancelled' : 'no_show';
    const at = new Date(nowMs).toISOString();
    const reason = walkNow
      ? 'Avtomatik yopildi: chek skanerlanmadi'
      : isPaid ? 'Avtomatik yopildi: to‘langan, lekin dars boshlanmadi (chek skanerlanmadi)'
      : `Avtomatik: mijoz dars vaqtidan ${lateMin} daqiqa o‘tguncha kelmadi`;
    const patch: any = { status: next, updated_at: at };
    if (next === 'cancelled') { patch.cancelled_at = at; patch.cancellation_reason = reason; }
    let upd: any[] = [];
    try {
      upd = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(String(b.id))}&status=eq.${q(String(b.status))}`,
        body: JSON.stringify(patch),
      });
    } catch (e) {
      out.details.push(`${shortCode(b.id)} yopilmadi: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!upd?.length) { out.skipped++; continue; }          // boshqa jarayon allaqachon o'zgartirgan
    out.closed++; if (next === 'no_show') out.no_show++; else out.cancelled++;
    out.details.push(`${shortCode(b.id)} → ${next === 'no_show' ? 'kelmagan' : 'bekor'}`);
    await supabaseRest('admin_audit_logs', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        admin_id: null, action: 'BOOKING_AUTO_LATE', entity_type: 'bookings', entity_id: b.id,
        old_data: { status: b.status, start_at: b.start_at }, new_data: { status: next, reason },
      }),
    }).catch(() => {});
    if (!walkNow && !isPaid && nowMs - startMs < 3 * 3600e3) {
      if (await notifyLateClosed({ ...b, ...upd[0] }, lateMin)) out.notified++;
    }
  }
  return out;
}

async function notifyLateClosed(b: any, lateMin: number): Promise<boolean> {
  let sent = false;
  try {
    const d = await loadBookingDetails(b);
    const when = fmtWhen(b.start_at || b.booking_date);
    const code = String(b.pickup_code || '').trim();
    const info = [when && `📅 ${when}`, d.instructorName && `👨‍🏫 ${d.instructorName}`, code && `🔑 ${code}`].filter(Boolean);
    const cText = ['🚫 Broningiz bekor qilindi', '', ...info, '',
      `Dars vaqtidan ${lateMin} daqiqa o‘tdi, siz kelmadingiz — bron avtomatik bekor qilindi.`,
      'Yangi vaqtga bron qilish uchun Mini Appni oching.'].join('\n');
    await supabaseRest('notifications', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ user_id: b.customer_id, type: 'booking', title: '🚫 Bron bekor qilindi',
        message: `${when}. Dars vaqtidan ${lateMin} daqiqa o‘tdi — bron avtomatik bekor qilindi.` }),
    }).catch(() => {});
    const bot = token();
    const u = (await supabaseRest<any[]>('users', {
      query: `?id=eq.${q(String(b.customer_id))}&select=telegram_id&limit=1`,
    }))[0];
    const chatId = Number(u?.telegram_id);
    if (bot && Number.isSafeInteger(chatId) && chatId > 0) {
      await telegramApi(bot, 'sendMessage', {
        chat_id: chatId, text: cText,
        ...(miniApp() ? { reply_markup: { inline_keyboard: [[{ text: '🚗 Mini Appni ochish', web_app: { url: miniApp() } }]] } } : {}),
      });
      sent = true;
    }
    // Instruktorga: soat bo'shadi
    const iBot = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
    if (iBot && b.instructor_id) {
      const ip = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(String(b.instructor_id))}&select=user_id&limit=1`,
      }))[0];
      const iu = ip?.user_id ? (await supabaseRest<any[]>('users', {
        query: `?id=eq.${q(String(ip.user_id))}&select=telegram_id&limit=1`,
      }))[0] : null;
      const iChat = Number(iu?.telegram_id);
      if (Number.isSafeInteger(iChat) && iChat > 0) {
        await telegramApi(iBot, 'sendMessage', {
          chat_id: iChat,
          text: `ℹ️ Mijoz kelmadi — bron avtomatik yopildi\n\n${d.customerName ? `👤 ${d.customerName}\n` : ''}${when ? `📅 ${when}\n` : ''}\nBu vaqt endi bo‘sh.`,
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('late notify failed:', e);
  }
  return sent;
}

async function recordRun(source: string, r: Awaited<ReturnType<typeof sendDueReminders>>, late?: Awaited<ReturnType<typeof closeLateBookings>>) {
  const value = {
    at: new Date().toISOString(), source,
    checked: r.checked, sent: r.sent, failed: r.failed, no_telegram: r.no_telegram,
    late_closed: late?.closed ?? 0,
    error: r.details.find((x) => /xato|sozlanmagan/i.test(x)) || late?.details.find((x) => /yopilmadi|xato/i.test(x)) || null,
  };
  try {
    const rows = await supabaseRest<any[]>('admin_settings', {
      method: 'PATCH', headers: { Prefer: 'return=representation' },
      query: `?key=eq.${LAST_RUN_KEY}`,
      body: JSON.stringify({ value, updated_at: value.at }),
    });
    if (!rows?.length) {
      await supabaseRest('admin_settings', {
        method: 'POST', headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ key: LAST_RUN_KEY, value, updated_at: value.at }),
      });
    }
  } catch (e) {
    console.error('reminders last-run save failed:', e);
  }
}

/** Har qanday manbadan chaqirish + natijani yozib qo'yish.
 *  Avval kechikkanlar yopiladi, keyin eslatmalar yuboriladi. */
export async function runRemindersNow(source: string, nowMs = Date.now()) {
  const cfg = await loadReminderConfig();
  const late = await closeLateBookings(nowMs, cfg).catch((e) => ({
    checked: 0, closed: 0, no_show: 0, cancelled: 0, notified: 0, skipped: 0,
    details: [`kechikkanlarni yopish xatosi: ${e instanceof Error ? e.message : e}`],
  }));
  const r = await sendDueReminders(nowMs, cfg);
  await recordRun(source, r, late);
  return { ...r, late_closed: late.closed, late };
}

let lastTickAt = 0;
let tickRunning: Promise<any> | null = null;

/**
 * Panellardan keladigan «tick». Bir instansiyada daqiqasiga ko'pi bilan
 * bir marta ishlaydi — o'nta panel ochiq tursa ham bazaga yuk tushmaydi.
 */
export async function tickReminders(source: string, minGapMs = 60_000) {
  const now = Date.now();
  if (tickRunning) return { ran: false, reason: 'running' };
  if (now - lastTickAt < minGapMs) return { ran: false, reason: 'recent' };
  lastTickAt = now;
  tickRunning = runRemindersNow(source, now);
  try {
    const r = await tickRunning;
    return { ran: true, sent: r.sent, checked: r.checked, failed: r.failed, late_closed: r.late_closed };
  } finally {
    tickRunning = null;
  }
}

/** Testlar uchun: tick cheklovini tozalash. */
export function _resetTickForTests() { lastTickAt = 0; tickRunning = null; }

/**
 * INSTRUKTOR QO'LDA ESLATMA YUBORADI («🔔 Eslatish» tugmasi).
 * Takror bosilsa mijozni bezovta qilmaslik uchun: bitta bronga
 * 10 daqiqada bir martadan ko'p emas (notifications jadvali orqali —
 * serverless instansiyalar almashsa ham ishlaydi).
 */
export async function sendManualReminder(booking: any, fromName: string, nowMs = Date.now()) {
  const bot = token();
  if (!bot) return { ok: false as const, code: 503, error: 'Mijoz boti sozlanmagan (CUSTOMER_BOT_TOKEN)' };
  if (!REMIND_STATUSES.includes(String(booking?.status) as any)) {
    return { ok: false as const, code: 400, error: 'Bu bron faol emas — eslatma kerak emas' };
  }
  const startMs = new Date(booking.start_at || booking.booking_date).getTime();
  if (!Number.isFinite(startMs) || startMs < nowMs - 15 * 60000) {
    return { ok: false as const, code: 400, error: 'Dars vaqti o‘tib ketgan' };
  }
  const u = (await supabaseRest<any[]>('users', {
    query: `?id=eq.${q(String(booking.customer_id))}&select=id,full_name,phone,telegram_id&limit=1`,
  }))[0];
  const chatId = Number(u?.telegram_id);
  if (!Number.isSafeInteger(chatId) || chatId <= 0) {
    return {
      ok: false as const, code: 400,
      error: u?.phone ? `Mijozda Telegram yo‘q — qo‘ng‘iroq qiling: ${u.phone}` : 'Mijozda Telegram yo‘q',
      phone: u?.phone || null,
    };
  }
  const code = shortCode(booking.id);
  const since = new Date(nowMs - 10 * 60000).toISOString();
  const recent = await supabaseRest<any[]>('notifications', {
    query: `?user_id=eq.${q(String(u.id))}&type=eq.reminder&created_at=gte.${q(since)}` +
           `&message=ilike.${q(`*${code}*`)}&select=id&limit=1`,
  }).catch(() => []);
  if (recent.length) {
    return { ok: false as const, code: 429, error: 'Eslatma hozirgina yuborilgan — 10 daqiqadan keyin qayta urinib ko‘ring' };
  }

  const d = await loadBookingDetails(booking);
  const minutesLeft = Math.max(0, Math.round((startMs - nowMs) / 60000));
  const { lateMin } = await loadReminderConfig();
  await telegramApi(bot, 'sendMessage', {
    chat_id: chatId,
    text: reminderText(minutesLeft, booking, d, fromName ? `Instruktor ${fromName}` : 'Instruktoringiz', lateMin),
    reply_markup: reminderKeyboard(String(booking.id)),
  });
  await supabaseRest('notifications', {
    method: 'POST', headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: u.id, type: 'reminder', title: '🔔 Dars eslatmasi',
      message: `Instruktor eslatdi: ${fmtWhen(booking.start_at || booking.booking_date)} (bron ${code})`,
    }),
  }).catch((e) => console.error('reminder notification insert failed:', e));
  return { ok: true as const };
}

/**
 * Telegram tugmasi bosilganda (callback_query).
 * `come:<id>` — kelaman, `cxl:<id>` — bekor qilmoqchiman.
 */
export async function handleReminderCallback(cb: any): Promise<boolean> {
  const bot = token();
  const data = String(cb?.data || '');
  const m = data.match(/^(come|cxl):([0-9a-f-]{36})$/i);
  if (!bot || !m) return false;

  const [, action, bookingId] = m;
  const fromId = Number(cb?.from?.id);
  const ack = (text: string, alert = false) =>
    telegramApi(bot, 'answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert }).catch(() => {});

  try {
    // Egalik tekshiruvi: bron aynan shu Telegram foydalanuvchisiga tegishlimi
    const b = (await supabaseRest<any[]>('bookings', {
      query: `?id=eq.${q(bookingId)}&select=id,customer_id,status,cancel_requested_at,cancel_reviewed_at&limit=1`,
    }))[0];
    if (!b) { await ack('Bron topilmadi'); return true; }

    const owner = (await supabaseRest<any[]>('users', {
      query: `?id=eq.${q(String(b.customer_id))}&select=id,telegram_id,full_name&limit=1`,
    }))[0];
    if (!owner || Number(owner.telegram_id) !== fromId) { await ack('Bu bron sizga tegishli emas', true); return true; }

    if (action === 'come') {
      if (!['pending', 'confirmed'].includes(String(b.status))) { await ack('Bron holati o‘zgargan'); return true; }
      await supabaseRest('bookings', {
        method: 'PATCH',
        query: `?id=eq.${q(bookingId)}`,
        body: JSON.stringify({ attendance_confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString() }),
      });
      await ack('Rahmat! Kutamiz ✅');
      await telegramApi(bot, 'sendMessage', {
        chat_id: fromId,
        text: '✅ Javobingiz qabul qilindi — sizni kutamiz.\nVaqtida yetib kelishga harakat qiling.',
      }).catch(() => {});
      return true;
    }

    // action === 'cxl'
    if (!['pending', 'confirmed'].includes(String(b.status))) { await ack('Bu bronni endi bekor qilib bo‘lmaydi', true); return true; }
    if (b.cancel_requested_at && !b.cancel_reviewed_at) { await ack('So‘rovingiz allaqachon yuborilgan', true); return true; }

    const now = new Date().toISOString();
    await supabaseRest('bookings', {
      method: 'PATCH',
      query: `?id=eq.${q(bookingId)}`,
      body: JSON.stringify({
        cancel_requested_at: now,
        cancel_request_reason: 'Telegram eslatmasi orqali: mijoz kela olmasligini bildirdi',
        cancel_requested_by: owner.id,
        cancel_reviewed_at: null,
        cancel_reviewed_by: null,
        updated_at: now,
      }),
    });
    await ack('So‘rov Adminga yuborildi');
    await telegramApi(bot, 'sendMessage', {
      chat_id: fromId,
      text: '🚫 Bekor qilish so‘rovi Adminga yuborildi.\nJavobni kuting — natija shu yerga keladi.',
    }).catch(() => {});

    // Adminlarga xabar
    try {
      await notifyAdmins(`🚫 Bekor qilish so‘rovi (eslatma orqali)\n\n👤 ${owner.full_name || 'Mijoz'}\nBron: ${shortCode(bookingId)}\n\nAdmin panelda ko‘rib chiqing.`,
        { open: 'bookings/cancels', button: '🛡️ So‘rovni ochish' });
    } catch { /* xabar ketmasa ham so'rov saqlangan */ }

    return true;
  } catch (e) {
    console.error('Reminder callback failed:', e);
    await ack('Xatolik yuz berdi, keyinroq urinib ko‘ring');
    return true;
  }
}
