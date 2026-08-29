import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from '../../../../backend/src/supabase.js';
import { sendBookingNotification } from '../../../../backend/src/telegram.js';

const COOKIE = 'avtodrom_admin_session';
const TTL = 60 * 60 * 12;

function getCookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const part = raw.split(';').map((x: string) => x.trim()).find((x: string) => x.startsWith(COOKIE + '='));
  if (!part) return '';
  try { return decodeURIComponent(part.slice(COOKIE.length + 1)); } catch { return ''; }
}

function sessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim();
}

function validSession(value: string) {
  try {
    const secret = sessionSecret();
    const expectedLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const decoded = Buffer.from(value || '', 'base64url').toString('utf8');
    const a = decoded.indexOf(':');
    const b = decoded.indexOf(':', a + 1);
    if (!secret || !expectedLogin || a <= 0 || b <= a) return false;

    const login = decoded.slice(0, a);
    const ts = Number(decoded.slice(a + 1, b));
    const sig = decoded.slice(b + 1);
    if (login !== expectedLogin || !Number.isFinite(ts)) return false;
    if (Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return false;

    const expected = createHmac('sha256', secret).update(`${login}:${ts}`).digest('hex');
    const x = Buffer.from(sig);
    const y = Buffer.from(expected);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}

function errorResponse(res: any, status: number, message: string) {
  return res.status(status).json({ ok: false, error: message });
}

const transitions: Record<string, string[]> = {
  pending: ['confirmed', 'cancelled', 'rejected'],
  confirmed: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'no_show'],
  completed: [],
  no_show: [],
  cancelled: [],
  rejected: [],
};

export default async function handler(req: any, res: any) {
  try {
    if (req.method !== 'PATCH') return errorResponse(res, 405, 'Faqat PATCH so‘rovi qabul qilinadi');
    if (!validSession(getCookie(req))) return errorResponse(res, 401, 'Admin login talab qilinadi');

    const id = String(req.query?.id || '').trim();
    const status = String(req.body?.status || '').trim().toLowerCase();
    const reason = String(req.body?.reason || '').trim() || null;

    const allowed = ['pending', 'confirmed', 'cancelled', 'rejected', 'in_progress', 'completed', 'no_show'];
    if (!id) return errorResponse(res, 400, 'Bron ID topilmadi');
    if (!allowed.includes(status)) return errorResponse(res, 400, 'Noto‘g‘ri bron holati');

    const adminLogin = String(process.env.ADMIN_LOGIN || '').trim();
    const admins = await supabaseRest<any[]>('users', {
      query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=id,full_name&limit=1',
    });
    const adminId = admins[0]?.id || null;

    const oldRows = await supabaseRest<any[]>('bookings', { query: `?id=eq.${encodeURIComponent(id)}&select=*` });
    const old = oldRows[0];
    if (!old) return errorResponse(res, 404, 'Bron topilmadi');

    const current = String(old.status || 'pending').toLowerCase();
    if (current === status) return res.status(200).json({ ok: true, booking: old, message: 'Bron allaqachon shu holatda' });
    if (!transitions[current]?.includes(status)) {
      return errorResponse(res, 409, `Bron holatini ${current} dan ${status} ga o‘zgartirish mumkin emas`);
    }

    const now = new Date().toISOString();
    const patch: any = { status, updated_at: now };

    if (status === 'confirmed') {
      patch.confirmed_at = now;
      if (adminId) patch.confirmed_by = adminId;
    }
    if (status === 'cancelled' || status === 'rejected') {
      patch.cancelled_at = now;
      if (adminId) patch.cancelled_by = adminId;
      patch.cancellation_reason = reason;
    }
    if (status === 'in_progress') patch.started_at = now;
    if (status === 'completed') patch.completed_at = now;

    const updatedRows = await supabaseRest<any[]>('bookings', {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      query: `?id=eq.${encodeURIComponent(id)}`,
      body: JSON.stringify(patch),
    });
    const updated = updatedRows[0] || { ...old, ...patch };

    try {
      await supabaseRest('admin_audit_logs', {
        method: 'POST',
        body: JSON.stringify({
          admin_id: adminId,
          action: 'BOOKING_STATUS_UPDATED',
          entity_type: 'bookings',
          entity_id: id,
          old_data: { status: current },
          new_data: { status, reason },
        }),
      });
    } catch (e) {
      console.error('Booking audit log failed:', e);
    }

    const customerId = old.customer_id ? String(old.customer_id) : '';
    const instructorId = old.instructor_id ? String(old.instructor_id) : '';
    const userIds = [customerId, instructorId].filter(Boolean);
    if (userIds.length) {
      try {
        const users = await supabaseRest<any[]>('users', {
          query: `?id=in.(${userIds.map(encodeURIComponent).join(',')})&select=id,telegram_id,full_name`,
        });
        const byId = new Map(users.map((u: any) => [String(u.id), u]));
        const customer = byId.get(customerId);
        const instructor = byId.get(instructorId);
        const date = old.booking_date || old.start_at || '';
        const text = `📋 AVTODROM INDEX\n\nBron #${id}\nHolati: ${status}\n${date ? `Sana: ${date}\n` : ''}${reason ? `Izoh: ${reason}` : ''}`;

        const customerToken = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
        const instructorToken = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
        if (customerToken && customer?.telegram_id) {
          await sendBookingNotification(customerToken, Number(customer.telegram_id), text, String(process.env.CUSTOMER_MINI_APP_URL || 'https://avtodrom.vercel.app/'), '🚗 Mini Appni ochish');
        }
        if (instructorToken && instructor?.telegram_id) {
          await sendBookingNotification(instructorToken, Number(instructor.telegram_id), text, String(process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor'), '👨‍🏫 Instruktor paneli');
        }
      } catch (e) {
        console.error('Booking notification failed:', e);
      }
    }

    return res.status(200).json({ ok: true, booking: updated, message: `Bron ${status} holatiga o‘tkazildi`, admin: adminLogin });
  } catch (e: any) {
    console.error('Admin booking status failed:', e);
    return errorResponse(res, 500, e?.message || 'Bron holatini saqlashda server xatosi');
  }
}
