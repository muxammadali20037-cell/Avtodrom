import app from '../backend/src/app.js';
import { supabaseRest } from '../backend/src/supabase.js';

async function notifyAdminsOnBooking(body: any) {
  const token = String(process.env.ADMIN_BOT_TOKEN || process.env.TELEGRAM_ADMIN_BOT_TOKEN || '');
  if (!token || !body?.booking?.id) return;
  try {
    const admins = await supabaseRest<any[]>('users', { query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=telegram_id&limit=20' });
    const id = String(body.booking.id).slice(0, 8);
    await Promise.all(admins.filter(a => Number.isSafeInteger(Number(a.telegram_id))).map(a => fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(a.telegram_id), text: `📋 AVTODROM\n\nYangi bron #${id}\nAdmin panelda tekshirib tasdiqlang.`, reply_markup: { inline_keyboard: [[{ text: '👨‍💼 Admin panel', web_app: { url: String(process.env.ADMIN_MINI_APP_URL || 'https://avtodrom.vercel.app/admin') } }]] } }),
    }).catch(() => null)));
  } catch (error) { console.error('Booking admin notification failed:', error); }
}

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const rawUrl = String(request.url || '/api');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    let pathname = parsed.pathname || '/api';
    if (!pathname.startsWith('/api')) pathname = `/api${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    const url = `${pathname}${parsed.search}`;

    const result = await app.inject({
      method: request.method || 'GET',
      url,
      headers,
      payload: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body === undefined ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body),
    });

    let body = result.body;
    const contentType = String(result.headers['content-type'] || '');

    if (pathname === '/api/me' && result.statusCode >= 200 && result.statusCode < 300 && contentType.includes('application/json')) {
      try {
        const parsedBody = JSON.parse(body || '{}');
        if (parsedBody?.profile && !parsedBody.user) {
          body = JSON.stringify({ ...parsedBody, user: parsedBody.profile });
          result.headers['content-length'] = String(Buffer.byteLength(body));
        }
      } catch {}
    }

    if (pathname === '/api/bookings' && request.method === 'POST' && result.statusCode === 201 && contentType.includes('application/json')) {
      try { await notifyAdminsOnBooking(JSON.parse(body || '{}')); } catch {}
    }

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(body);
  } catch (error) {
    console.error('Vercel API catch-all failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}