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
export type ReminderKind = (typeof KINDS)[number];

const q = (v: string) => encodeURIComponent(v);
const token = () => String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
const miniApp = () => String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || '');

function reminderText(kind: ReminderKind, booking: any, d: any) {
  const lines = [
    kind === 10 ? '⏰ Darsingiz 10 daqiqadan keyin!' :
    kind === 30 ? '⏰ Darsingizga 30 daqiqa qoldi' :
                  '⏰ Darsingizga 1 soat qoldi',
    '',
  ];
  if (d.courseName) lines.push(`📚 ${d.courseName}`);
  if (d.instructorName) lines.push(`👨‍🏫 ${d.instructorName}`);
  const when = fmtWhen(booking.start_at || booking.booking_date);
  if (when) lines.push(`📅 ${when}`);
  const price = fmtMoney(d.price);
  if (price) lines.push(`💵 ${price}`);
  lines.push('', 'Iltimos, javob bering:');
  return lines.join('\n');
}

function keyboard(bookingId: string) {
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
  const result = { checked: 0, sent: 0, skipped: 0, failed: 0, details: [] as string[] };
  if (!bot) { result.details.push('CUSTOMER_BOT_TOKEN sozlanmagan'); return result; }

  // Keyingi 65 daqiqada boshlanadigan tasdiqlangan bronlar
  const from = new Date(nowMs).toISOString();
  const to = new Date(nowMs + 65 * 60 * 1000).toISOString();
  const bookings = await supabaseRest<any[]>('bookings', {
    query:
      `?status=eq.confirmed&start_at=gte.${q(from)}&start_at=lte.${q(to)}` +
      '&select=id,customer_id,instructor_id,course_id,start_at,booking_date,cancel_requested_at,cancel_reviewed_at' +
      '&order=start_at.asc&limit=200',
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
      // UNIQUE'ga urildi = boshqa chaqiruv allaqachon yubordi
      result.skipped++;
      continue;
    }

    try {
      const u = (await supabaseRest<any[]>('users', {
        query: `?id=eq.${q(String(b.customer_id))}&select=telegram_id&limit=1`,
      }))[0];
      const chatId = Number(u?.telegram_id);
      if (!Number.isSafeInteger(chatId) || chatId <= 0) throw new Error('telegram_id yo‘q');

      const d = await loadBookingDetails(b);
      await telegramApi(bot, 'sendMessage', {
        chat_id: chatId,
        text: reminderText(kind, b, d),
        reply_markup: keyboard(String(b.id)),
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
      if (b.status !== 'confirmed') { await ack('Bron holati o‘zgargan'); return true; }
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
