import type { VercelRequest, VercelResponse } from '@vercel/node';
import { validateTelegramInitData } from '../../backend/src/telegram.js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const INSTRUCTOR_BOT_TOKEN = process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '';

function send(res: VercelResponse, status: number, body: unknown) {
  return res.status(status).setHeader('Content-Type', 'application/json').json(body);
}

function getInitData(req: VercelRequest): string {
  const header = req.headers['x-telegram-init-data'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('tma ')) return auth.slice(4).trim();
  const query = req.query?.initData;
  return typeof query === 'string' ? query.trim() : '';
}

async function authenticate(req: VercelRequest) {
  if (!INSTRUCTOR_BOT_TOKEN) throw new Error('Instructor bot token is not configured');
  const initData = getInitData(req);
  if (!initData) throw new Error('Telegram initData topilmadi. Mini Appni Telegram bot ichidan oching.');
  return validateTelegramInitData(initData, INSTRUCTOR_BOT_TOKEN);
}

async function rpc(fn: string, args: Record<string, unknown>) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error('Supabase server credentials are missing');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(data?.message || data?.hint || data?.details || data?.error || `Supabase HTTP ${response.status}`);
  return data;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'GET' && req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      return send(res, 405, { ok: false, error: 'Method not allowed' });
    }

    const user = await authenticate(req);

    if (req.method === 'GET') {
      const rows = await rpc('get_instructor_registration_status', {
        p_telegram_user_id: user.id,
      });
      return send(res, 200, {
        ok: true,
        registration: Array.isArray(rows) && rows[0]
          ? rows[0]
          : {
              status: 'NOT_REGISTERED',
              first_name: user.first_name || '',
              last_name: user.last_name || '',
              rejection_reason: null,
            },
      });
    }

    let body: any = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { return send(res, 400, { ok: false, error: 'JSON ma’lumot noto‘g‘ri' }); }
    }

    const firstName = String(body.firstName || '').trim();
    const lastName = String(body.lastName || '').trim();
    const phone = String(body.phone || '').trim();
    const rawExperience = body.experienceYears;
    const experienceYears = rawExperience === '' || rawExperience == null
      ? null
      : Math.max(0, Math.min(60, Number(rawExperience) || 0));
    const message = String(body.message || '').trim() || null;

    if (!firstName || !lastName || !phone) {
      return send(res, 400, { ok: false, error: 'Ism, familiya va telefon raqami majburiy' });
    }

    const registration = await rpc('submit_instructor_application', {
      p_telegram_user_id: user.id,
      p_first_name: firstName,
      p_last_name: lastName,
      p_phone: phone,
      p_experience_years: experienceYears,
      p_message: message,
    });

    return send(res, 200, { ok: true, registration });
  } catch (error: any) {
    console.error('Instructor registration API failed:', error);
    const message = String(error?.message || 'Ariza yuborilmadi');
    const status = /initData|token|credentials|authentication/i.test(message) ? 401 : 400;
    return send(res, status, { ok: false, error: message });
  }
}
