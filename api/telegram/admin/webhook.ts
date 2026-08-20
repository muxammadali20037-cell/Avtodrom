import type { VercelRequest, VercelResponse } from '@vercel/node';

const BOT_TOKEN = process.env.ADMIN_BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function telegram(method: string, body: unknown) {
  if (!BOT_TOKEN) throw new Error('ADMIN_BOT_TOKEN is missing');
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function adminExists(chatId: number) {
  if (!SUPABASE_URL || !SERVICE_KEY) return false;
  const r = await fetch(`${SUPABASE_URL}/rest/v1/telegram_admins?telegram_chat_id=eq.${chatId}&is_active=eq.true&select=id&limit=1`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'GET') return res.status(200).json({ ok: true, service: 'admin-telegram-webhook', webhook: true });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });
  try {
    const update = req.body ?? {};
    const chatId = Number(update?.message?.chat?.id);
    const text = String(update?.message?.text ?? '').trim();
    if (!chatId) return res.status(200).json({ ok: true });
    if (!text.startsWith('/start')) return res.status(200).json({ ok: true });

    if (!(await adminExists(chatId))) {
      await telegram('sendMessage', { chat_id: chatId, text: '⛔ Sizda Avtodrom Admin Botga kirish huquqi yo‘q.' });
      return res.status(200).json({ ok: true, admin: false });
    }

    const panelUrl = process.env.MINI_APP_URL || process.env.FRONTEND_ORIGIN;
    const payload: any = {
      chat_id: chatId,
      text: '🛡️ AVTODROM ADMIN BOT\n\nXush kelibsiz, administrator!\n\nYangi bronlar, instruktor arizalari va muhim tizim xabarnomalarini shu yerda olasiz.',
    };
    if (panelUrl) payload.reply_markup = { inline_keyboard: [[{ text: '📊 Admin panel', web_app: { url: panelUrl } }]] };
    await telegram('sendMessage', payload);
    return res.status(200).json({ ok: true, admin: true });
  } catch (error) {
    console.error('admin telegram webhook error', error);
    return res.status(200).json({ ok: false });
  }
}
