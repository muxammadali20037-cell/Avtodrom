import { supabaseRest } from './supabase.js';
import { telegramApi } from './telegram.js';
import { loadBookingDetails, fmtWhen, fmtMoney, shortCode } from './notify.js';

/**
 * DARS OLDIDAN ESLATMA
 *
 * 60 / 30 / 10 daqiqa qolganda mijozga Telegram xabari va ikkita tugma:
 *   «✅ Kelaman»            → attendance_confirmed_at yoziladi
 *   «🚫 Bekor qilmoqchiman» → admin uchun bekor so'rovi ochiladi
 *
 * Takrorlanishdan himoya: `booking_reminders` jadvalidagi
 * UNIQUE (booking_id, kind). Yozuv AVVAL qo'yiladi, keyin xabar yuboriladi —
 * shunda rejalashtiruvchi bir vaqtda ikki marta ishga tushsa ham
 * ikkinchisi UNIQUE'ga urilib to'xtaydi va xabar takrorlanmaydi.
 */

const KINDS = [60, 30, 10] as const;
/** Eslatma yuboriladigan bron holatlari. */
export const REMIND_STATUSES = ['pending', 'confirmed'] as const;
export type ReminderKind = (typeof KINDS)[number];

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
export function reminderText(minutesLeft: number, booking: any, d: any, from?: string) {
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
  lines.push('', 'Iltimos, javob bering:');
  return lines.join('\n');
}

export function reminderKeyboard(bookingId: string) {
  return {
    inline_keyboard: [
      [{ text: '✅ Kelaman', callback_data: `come:${bookingId}` }],
      [{ text: '🚫 Bekor qilmoqchiman', callback_data: `cxl:${bookingId}` }],
      ...(miniApp() ? [[{ text: '🚗 Mini Appni ochish', web_app: { url: miniApp() } }]] : []),
    ],
  };
}

/**
 * Muddati kelgan eslatmalarni yuboradi.
 * Rejalashtiruvchi buni bir necha daqiqada bir marta chaqiradi.
 * Bir necha marta chaqirilishi xavfsiz (idempotent).
 */
export async function sendDueReminders(nowMs = Date.now()) {
  const bot = token();
  const result = { checked: 0, sent: 0, skipped: 0, failed: 0, no_telegram: 0, details: [] as string[] };
  if (!bot) { result.details.push('CUSTOMER_BOT_TOKEN sozlanmagan'); return result; }

  // Keyingi 65 daqiqada boshlanadigan HAR BIR faol bron — tasdiqlangan
  // ham, hali kutilayotgan (pending) ham. Ilgari faqat `confirmed`
  // olinardi: admin tasdiqlamagan bronlar egasiga eslatma umuman
  // bormasdi. `select=*` — pickup_code kabi ixtiyoriy ustunlar
  // bazada bo'lmasa ham so'rov yiqilmasin.
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + 65 * 60 * 1000).toISOString();
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

    // Mos keladigan eng kichik oraliq: 10 daq qolganda 10-eslatma ketadi
    const kind = KINDS.filter((k) => minutesLeft <= k).sort((a, x) => a - x)[0];
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
        text: reminderText(minutesLeft, b, d),
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

async function recordRun(source: string, r: Awaited<ReturnType<typeof sendDueReminders>>) {
  const value = {
    at: new Date().toISOString(), source,
    checked: r.checked, sent: r.sent, failed: r.failed, no_telegram: r.no_telegram,
    error: r.details.find((x) => /xato|sozlanmagan/i.test(x)) || null,
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

/** Har qanday manbadan chaqirish + natijani yozib qo'yish. */
export async function runRemindersNow(source: string, nowMs = Date.now()) {
  const r = await sendDueReminders(nowMs);
  await recordRun(source, r);
  return r;
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
    return { ran: true, sent: r.sent, checked: r.checked, failed: r.failed };
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
  await telegramApi(bot, 'sendMessage', {
    chat_id: chatId,
    text: reminderText(minutesLeft, booking, d, fromName ? `Instruktor ${fromName}` : 'Instruktoringiz'),
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
      const adminToken = String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '');
      if (adminToken) {
        const admins = await supabaseRest<any[]>('telegram_admins', { query: '?select=telegram_chat_id' });
        for (const a of admins) {
          const chatId = Number(a.telegram_chat_id);
          if (Number.isSafeInteger(chatId) && chatId > 0) {
            await telegramApi(adminToken, 'sendMessage', {
              chat_id: chatId,
              text: `🚫 Bekor qilish so‘rovi (eslatma orqali)\n\n👤 ${owner.full_name || 'Mijoz'}\nBron: ${shortCode(bookingId)}\n\nAdmin panelda ko‘rib chiqing.`,
            }).catch(() => {});
          }
        }
      }
    } catch { /* xabar ketmasa ham so'rov saqlangan */ }

    return true;
  } catch (e) {
    console.error('Reminder callback failed:', e);
    await ack('Xatolik yuz berdi, keyinroq urinib ko‘ring');
    return true;
  }
}
