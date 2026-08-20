import type { VercelRequest, VercelResponse } from '@vercel/node';

const BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function tg(method: string, body: unknown) {
  if (!BOT_TOKEN) throw new Error('ADMIN_BOT_TOKEN is missing');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

async function isAdmin(chatId: number) {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins?telegram_chat_id=eq.${chatId}&is_active=eq.true&select=id&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'admin-telegram-webhook' });
  try {
    const update = req.body ?? {};
    const message = update.message;
    if (!message?.chat?.id) return res.status(200).json({ ok: true });
    const chatId = Number(message.chat.id);
    const text = String(message.text ?? '').trim();
    if (!text.startsWith('/start')) return res.status(200).json({ ok: true });

    const admin = await isAdmin(chatId);
    if (!admin) {
      await tg('sendMessage', { chat_id: chatId, text: '⛔ Sizda Admin Botga kirish huquqi yo‘q.' });
      return res.status(200).json({ ok: true, admin: false });
    }

    await tg('sendMessage', {
      chat_id: chatId,
      text: '🛡️ AVTODROM ADMIN BOT\n\nXush kelibsiz, administrator!\n\nBu bot orqali yangi bronlar, instruktor arizalari va muhim tizim xabarnomalarini boshqarasiz.',
      reply_markup: { inline_keyboard: [[{ text: '📊 Admin panel', web_app: { url: process.env.MINI_APP_URL || process.env.FRONTEND_ORIGIN || '' } }]] }
    });
    return res.status(200).json({ ok: true, admin: true });
  } catch (e) {
    console.error('admin telegram webhook error', e);
    return res.status(200).json({ ok: false });
  }
}
