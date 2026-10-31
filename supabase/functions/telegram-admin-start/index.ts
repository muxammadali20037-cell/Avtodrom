/**
 * AVTODROM — ADMIN BOT (Telegram webhook, Supabase Edge Function).
 *
 * Kirish huquqi: telegram_admins jadvali (is_active = true).
 * Shu jadval yangi bron xabarlarini ham boshqaradi — ruxsat olgan odam
 * admin panelni ochadi va yangi bronlar haqida xabar oladi.
 *
 * RUXSAT SO'RASH:
 *   Ruxsati yo'q odam /start bossa — unga «so'rov yuborildi» deyiladi,
 *   hamma faol adminlarga esa «✅ Ruxsat berish / ❌ Rad etish» tugmali
 *   xabar boradi. Admin bir bosishda ruxsat beradi, odamga darhol
 *   admin menyusi keladi. Bitta odam 10 daqiqada bir martadan ko'p
 *   so'rov yubora olmaydi (adminlar bezovta bo'lmasin).
 *
 * XAVFSIZLIK: webhook ochiq manzil. Soxta «Ruxsat berish» bosilishini
 * oldini olish uchun avval answerCallbackQuery chaqiriladi — Telegram uni
 * faqat HAQIQIY tugma bosilishi uchun qabul qiladi. Soxta so'rovda
 * (bot yoza olmaydigan chat) adminlarga hech narsa yuborilmaydi.
 */
const BOT_TOKEN = Deno.env.get('TELEGRAM_ADMIN_BOT_TOKEN') || '';
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || 'https://izmonnkzyolaqwjwjvzj.supabase.co';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const WEBHOOK_URL = `${SUPABASE_URL}/functions/v1/telegram-admin-start`;
const ADMIN_PANEL_URL = 'https://avtodrom.vercel.app/admin';
const REQUEST_COOLDOWN_MS = 10 * 60 * 1000;

async function tg(method: string, body: Record<string, unknown>) {
  if (!BOT_TOKEN) throw Error('TELEGRAM_ADMIN_BOT_TOKEN missing');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return await r.json();
}

/* ---- telegram_admins ---- */
const dbHeaders = () => ({ apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'content-type': 'application/json' });
async function adminRow(chatId: number): Promise<{ id: number; is_active: boolean; updated_at: string } | null> {
  if (!SERVICE_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins?telegram_chat_id=eq.${chatId}&select=id,is_active,updated_at&limit=1`, { headers: dbHeaders() });
  if (!r.ok) return null;
  const rows = await r.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}
async function isAdmin(chatId: number) {
  if (!Number.isSafeInteger(chatId) || !chatId) return false;
  const row = await adminRow(chatId);
  return !!row && row.is_active === true;
}
async function activeAdminChats(): Promise<number[]> {
  if (!SERVICE_KEY) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins?is_active=eq.true&select=telegram_chat_id`, { headers: dbHeaders() });
  if (!r.ok) return [];
  const rows = await r.json();
  return Array.isArray(rows) ? rows.map((x: any) => Number(x.telegram_chat_id)).filter((n: number) => Number.isSafeInteger(n) && n !== 0) : [];
}
/** Qatorni yozadi: bor bo'lsa yangilaydi, yo'q bo'lsa qo'shadi. */
async function setAdmin(chatId: number, active: boolean) {
  const now = new Date().toISOString();
  const row = await adminRow(chatId);
  if (row) {
    await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins?id=eq.${row.id}`, {
      method: 'PATCH', headers: dbHeaders(), body: JSON.stringify({ is_active: active, updated_at: now }),
    });
  } else {
    await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins`, {
      method: 'POST', headers: { ...dbHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ telegram_chat_id: chatId, is_active: active, updated_at: now }),
    });
  }
}

/* ---- matnlar ---- */
const nameOf = (u: any, chat?: any) =>
  String(chat?.title || [u?.first_name, u?.last_name].filter(Boolean).join(' ') || 'Nomsiz').slice(0, 80);

function adminMenu(chatId: number, text = '👨‍💼 AVTODROM INDEX — ADMIN BOT\n\nXush kelibsiz, administrator!') {
  return tg('sendMessage', {
    chat_id: chatId, text,
    reply_markup: { inline_keyboard: [
      [{ text: '📊 Admin panel', web_app: { url: ADMIN_PANEL_URL } }],
      [{ text: '💬 Admin Chat', web_app: { url: `${ADMIN_PANEL_URL}/chat` } }, { text: '🔄 Yangilash', callback_data: 'admin_refresh' }],
    ] },
  });
}

/** Ruxsati yo'q odam /start bosdi — so'rov adminlarga boradi. */
async function requestAccess(message: any) {
  const chatId = Number(message.chat.id);
  const u = message.from || {};
  const row = await adminRow(chatId);
  if (row && !row.is_active && Date.now() - Date.parse(row.updated_at) < REQUEST_COOLDOWN_MS) {
    await tg('sendMessage', { chat_id: chatId, text: '⏳ So‘rovingiz administratorga yuborilgan. Ruxsat berilishi bilan shu yerga xabar keladi.' });
    return 'request_pending';
  }
  /* Avval so'rovchining o'ziga yozamiz. Bot unga yoza olmasa — bu soxta
     so'rov: adminlarni bezovta qilmaymiz, bazaga ham yozmaymiz. */
  const sent = await tg('sendMessage', {
    chat_id: chatId,
    text: `⛔ Sizda hali administrator botidan foydalanish huquqi yo‘q.\n\n✉️ Ruxsat so‘rovi administratorga yuborildi. Ruxsat berilishi bilan shu yerga xabar keladi.\n\n🆔 Sizning ID: ${chatId}`,
  });
  if (sent?.ok !== true) return 'request_unreachable';

  await setAdmin(chatId, false);   // faol emas = so'rov kutilmoqda
  const lines = ['🔐 Admin botga kirish so‘rovi', '', `👤 ${nameOf(u, message.chat?.type !== 'private' ? message.chat : null)}`];
  if (u.username) lines.push(`🔗 @${u.username}`);
  lines.push(`🆔 ${chatId}`, '', 'Ruxsat berilsa — admin panelni ochadi va yangi bron xabarlarini oladi.');
  const keyboard = { inline_keyboard: [[
    { text: '✅ Ruxsat berish', callback_data: `adm_ok:${chatId}` },
    { text: '❌ Rad etish', callback_data: `adm_no:${chatId}` },
  ]] };
  const admins = (await activeAdminChats()).filter((id) => id !== chatId);
  await Promise.all(admins.map((id) => tg('sendMessage', { chat_id: id, text: lines.join('\n'), reply_markup: keyboard }).catch(() => null)));
  return 'request_sent';
}

/** Admin «Ruxsat berish» / «Rad etish» ni bosdi. */
async function decide(cb: any, ok: boolean, target: number) {
  const pressedIn = Number(cb.message?.chat?.id);
  const presser = Number(cb.from?.id);
  const answer = (text: string, alert = false) => tg('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alert });

  /* Haqiqiy tugma bosilishimi — Telegram faqat haqiqiy callback'ni qabul qiladi */
  if (!(await isAdmin(pressedIn)) && !(await isAdmin(presser))) {
    await answer('⛔ Faqat administrator ruxsat bera oladi', true);
    return 'denied';
  }
  const row = await adminRow(target);
  const by = nameOf(cb.from);
  const base = String(cb.message?.text || '🔐 Admin botga kirish so‘rovi');
  const close = (status: string) => tg('editMessageText', {
    chat_id: pressedIn, message_id: cb.message?.message_id, text: `${base}\n\n${status}`,
  }).catch(() => null);

  if (ok) {
    if (row?.is_active) {
      const ack = await answer('Bu odamga allaqachon ruxsat berilgan');
      if (ack?.ok !== true) return 'forged';
      await close(`✅ Ruxsat berilgan`);
      return 'already';
    }
    const ack = await answer('✅ Ruxsat berildi');
    if (ack?.ok !== true) return 'forged';
    await setAdmin(target, true);
    await close(`✅ Ruxsat berildi — ${by}`);
    await adminMenu(target, '✅ Sizga AVTODROM admin botidan foydalanish ruxsati berildi!\n\nAdmin panelni pastdagi tugma orqali oching.').catch(() => null);
    return 'granted';
  }

  if (row?.is_active) {
    /* Tasodifan eski xabardagi «Rad etish» ni bosib, faol adminni
       o'chirib qo'ymaslik uchun: o'chirish faqat admin panelda. */
    const ack = await answer('Bu odamda allaqachon ruxsat bor. O‘chirish — admin panelda: Narxlar va ish vaqti → Admin bot.', true);
    if (ack?.ok !== true) return 'forged';
    return 'kept';
  }
  const ack = await answer('❌ Rad etildi');
  if (ack?.ok !== true) return 'forged';
  await setAdmin(target, false);
  await close(`❌ Rad etildi — ${by}`);
  await tg('sendMessage', { chat_id: target, text: '❌ Admin botga kirish so‘rovingiz rad etildi.' }).catch(() => null);
  return 'rejected';
}

const out = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  try {
    if (req.method === 'GET') {
      const result = await tg('setWebhook', { url: WEBHOOK_URL, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      return out({ ok: result?.ok === true, webhook_url: WEBHOOK_URL, telegram: result });
    }
    if (req.method !== 'POST') return out({ ok: false, error: 'Method not allowed' }, 405);
    const update = await req.json();

    const message = update?.message;
    const chatId = Number(message?.chat?.id);
    const text = typeof message?.text === 'string' ? message.text.trim() : '';
    if (message && chatId && (text === '/start' || text.startsWith('/start '))) {
      if (!(await isAdmin(chatId))) return out({ ok: true, action: await requestAccess(message) });
      await adminMenu(chatId);
      return out({ ok: true, action: 'menu' });
    }

    const cb = update?.callback_query;
    if (cb) {
      const data = String(cb.data || '');
      const m = /^adm_(ok|no):(-?\d{3,16})$/.exec(data);
      if (m) return out({ ok: true, action: await decide(cb, m[1] === 'ok', Number(m[2])) });
      await tg('answerCallbackQuery', { callback_query_id: cb.id });
      if (data === 'admin_refresh' && (await isAdmin(Number(cb.message?.chat?.id)))) {
        await tg('sendMessage', { chat_id: cb.message?.chat?.id, text: '✅ Admin bot ishlayapti. Supabase bilan ulanish faol.' });
      }
    }
    return out({ ok: true });
  } catch (e) {
    console.error(e);
    return out({ ok: false, error: String(e) }, 200);
  }
});
