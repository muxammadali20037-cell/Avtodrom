import type { VercelRequest, VercelResponse } from '@vercel/node';

const token = process.env.ADMIN_BOT_TOKEN;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const miniAppUrl = process.env.MINI_APP_URL;

async function tg(method: string, body: Record<string, unknown>) {
  if (!token) throw new Error('ADMIN_BOT_TOKEN is not configured');
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

async function db(path: string, init: RequestInit = {}) {
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase environment is not configured');
  const r = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', ...(init.headers || {}) }
  });
  return r.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(200).json({ ok: true, service: 'admin-telegram-webhook' });
  try {
    const update = req.body || {};
    const message = update.message;
    const callback = update.callback_query;
    const chatId = message?.chat?.id ?? callback?.message?.chat?.id;
    if (!chatId) return res.status(200).json({ ok: true });

    if (message?.text === '/start') {
      await tg('sendMessage', { chat_id: chatId, text: '🛡️ Avtodrom Admin\n\nAdmin panelni oching yoki yangi arizalar haqida xabardor bo‘ling.', reply_markup: { inline_keyboard: [[{ text: '🖥 Admin Panel', web_app: { url: miniAppUrl || 'https://avtodrom12-five.vercel.app' } }]] } });
      return res.status(200).json({ ok: true });
    }

    if (callback?.data?.startsWith('instructor:approve:') || callback?.data?.startsWith('instructor:reject:')) {
      const [kind, action, id] = callback.data.split(':');
      const approved = action === 'approve';
      const profiles = await db(`instructor_profiles?id=eq.${encodeURIComponent(id)}&select=user_id`);
      const userId = profiles?.[0]?.user_id;
      if (!userId) throw new Error('Instructor profile not found');
      await db(`instructor_profiles?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ is_verified: approved, is_available: approved }) });
      await db(`users?id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ is_active: approved, role: 'instructor' }) });
      await tg('answerCallbackQuery', { callback_query_id: callback.id, text: approved ? 'Instruktor tasdiqlandi' : 'Instruktor rad etildi' });
      await tg('editMessageText', { chat_id: chatId, message_id: callback.message.message_id, text: `${approved ? '✅' : '❌'} Instruktor arizasi ${approved ? 'tasdiqlandi' : 'rad etildi'}.` });
      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e instanceof Error ? e.message : 'unknown error' });
  }
}
