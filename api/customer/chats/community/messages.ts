import { authenticateCustomer } from '../../../../backend/src/app.js';
import { supabaseRest } from '../../../../backend/src/supabase.js';
import { userForTelegram } from '../../../../backend/src/identity.js';

async function notifyAdmins(text: string) {
  const token = String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '');
  if (!token) return;
  try {
    const admins = await supabaseRest<any[]>('users', { query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=telegram_id&limit=20' });
    await Promise.all(admins.filter(a => Number.isSafeInteger(Number(a.telegram_id))).map(a => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(a.telegram_id), text: `💬 AVTODROM CHAT\n\nYangi mijoz xabari:\n${text}`, reply_markup: { inline_keyboard: [[{ text: '👨‍💼 Admin panel', web_app: { url: String(process.env.ADMIN_MINI_APP_URL || 'https://avtodrom.vercel.app/admin') } }]] } }),
    }).catch(() => null)));
  } catch (error) { console.error('Chat admin notification failed:', error); }
}

export default async function handler(request: any, response: any) {
  try {
    const tg = await authenticateCustomer({ headers: request.headers || {}, query: request.query || {} });
    const user = await userForTelegram(tg);

    if (request.method === 'GET') {
      const rows = await supabaseRest<any[]>('community_messages', { query: '?select=id,sender_user_id,sender_role,message,created_at&order=created_at.asc&limit=200' });
      response.statusCode = 200; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, messages: rows.map(row => ({ id: row.id, sender_id: row.sender_user_id, sender_role: row.sender_role, sender_name: String(row.sender_user_id) === String(user.id) ? 'Siz' : row.sender_role === 'admin' ? 'AVTODROM Admin' : 'AVTODROM', text: row.message, created_at: row.created_at, mine: String(row.sender_user_id) === String(user.id) })) }));
      return;
    }

    if (request.method === 'POST') {
      const body = typeof request.body === 'string' ? JSON.parse(request.body || '{}') : (request.body || {});
      const text = String(body.message ?? body.text ?? '').trim();
      if (!text) { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: false, error: 'Xabar bo‘sh bo‘lishi mumkin emas' })); return; }
      if (text.length > 4000) { response.statusCode = 400; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: false, error: 'Xabar 4000 belgidan oshmasin' })); return; }
      const rows = await supabaseRest<any[]>('community_messages', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ sender_user_id: user.id, sender_role: user.role, message: text }) });
      const row = rows[0];
      await notifyAdmins(text);
      response.statusCode = 201; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, message: row ? { id: row.id, sender_id: row.sender_user_id, sender_role: row.sender_role, sender_name: 'Siz', text: row.message, created_at: row.created_at, mine: true } : null }));
      return;
    }

    response.statusCode = 405; response.setHeader('allow', 'GET, POST'); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
  } catch (error) {
    const status = error instanceof Error && /Telegram|Unauthorized|initData/i.test(error.message) ? 401 : 400;
    response.statusCode = status; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Chat server xatosi' }));
  }
}
