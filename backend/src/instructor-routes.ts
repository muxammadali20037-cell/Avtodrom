import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendEventNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }
const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const ADMIN_BOT_TOKEN = process.env.ADMIN_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';

function adminChatIds(): number[] {
  return String(process.env.ADMIN_TELEGRAM_CHAT_IDS || '').split(',').map(v => Number(v.trim())).filter(v => Number.isSafeInteger(v) && v > 0);
}

async function userForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('users', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  return rows[0] || null;
}

async function instructorForUser(userId: string) {
  const rows = await supabaseRest<any[]>('instructor_profiles', { query: `?user_id=eq.${q(userId)}&select=*` });
  return rows[0] || null;
}

async function notifyAdmins(title: string, body: string) {
  if (!ADMIN_BOT_TOKEN) return;
  await Promise.allSettled(adminChatIds().map(chatId => sendEventNotification(ADMIN_BOT_TOKEN, chatId, title, body, MINI_APP_URL)));
}

export async function registerInstructorRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      if (!user) return reply.code(404).send({ ok: false, error: 'Foydalanuvchi topilmadi' });
      const instructor = await instructorForUser(user.id);
      if (user.role !== 'instructor' || !instructor) return reply.code(403).send({ ok: false, error: 'Siz instruktor sifatida ro‘yxatdan o‘tmagansiz', pending: false });
      const approved = Boolean(user.is_active && !user.is_blocked && instructor.is_verified);
      if (!approved) return reply.code(403).send({ ok: false, error: 'Arizangiz admin tomonidan tasdiqlanishini kutmoqda', pending: true, profile: user, instructor });
      return { ok: true, profile: user, instructor };
    } catch (e) { return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' }); }
  });

  app.post('/api/instructor/register', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const body = (request.body || {}) as { phone?: string; first_name?: string; last_name?: string; bio?: string; experience_years?: number };
      const phone = String(body.phone || '').trim();
      const firstName = String(body.first_name || tg.first_name || '').trim();
      const lastName = String(body.last_name || tg.last_name || '').trim();
      const bio = String(body.bio || '').trim();
      const experience = Math.max(0, Number(body.experience_years || 0));
      if (phone.length < 7) return reply.code(400).send({ ok: false, error: 'Telefon raqami noto‘g‘ri' });
      if (firstName.length < 2) return reply.code(400).send({ ok: false, error: 'Ism kiritilishi kerak' });
      if (!Number.isFinite(experience) || experience > 80) return reply.code(400).send({ ok: false, error: 'Tajriba yili noto‘g‘ri' });

      let user = await userForTelegram(tg);
      if (user?.role === 'admin') return reply.code(403).send({ ok: false, error: 'Admin hisobidan instruktor arizasi berib bo‘lmaydi' });
      const fullName = [firstName, lastName].filter(Boolean).join(' ');
      if (!user) {
        const created = await supabaseRest<any[]>('users', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ telegram_id: tg.id, phone, full_name: fullName, role: 'instructor', is_active: false, is_blocked: false }) });
        user = created[0];
      } else {
        const updated = await supabaseRest<any[]>('users', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(user.id)}`, body: JSON.stringify({ phone, full_name: fullName, role: 'instructor', is_active: false, is_blocked: false, updated_at: new Date().toISOString() }) });
        user = updated[0] || user;
      }

      let instructor = await instructorForUser(user.id);
      if (!instructor) {
        const created = await supabaseRest<any[]>('instructor_profiles', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ user_id: user.id, bio: bio || null, experience_years: experience, is_verified: false, is_available: false }) });
        instructor = created[0];
      } else {
        const updated = await supabaseRest<any[]>('instructor_profiles', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(instructor.id)}`, body: JSON.stringify({ bio: bio || null, experience_years: experience, is_verified: false, is_available: false, updated_at: new Date().toISOString() }) });
        instructor = updated[0] || instructor;
      }

      await supabaseRest('notifications', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: user.id, type: 'INSTRUCTOR_APPLICATION', title: 'Yangi instruktor arizasi', message: `${fullName} instruktor bo‘lish uchun ariza yubordi. Admin tasdig‘i kutilmoqda.`, telegram_sent: false, is_read: false }) });
      await notifyAdmins('👨‍🏫 Yangi instruktor arizasi', `${fullName} instruktor bo‘lish uchun ariza yubordi. Admin panel → Instruktorlar bo‘limidan tekshiring va tasdiqlang.`);
      return reply.code(201).send({ ok: true, pending: true, message: 'Ariza qabul qilindi. Admin tasdiqlashini kuting.', profile: user, instructor });
    } catch (e) { console.error('Instructor registration failed:', e); return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Registration failed' }); }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      if (!user || user.role !== 'instructor' || !user.is_active || user.is_blocked) return reply.code(403).send({ ok: false, error: 'Instructor access is not approved' });
      const instructor = await instructorForUser(user.id);
      if (!instructor?.is_verified) return reply.code(403).send({ ok: false, error: 'Instructor approval is pending' });
      const query = request.query as { from?: string; to?: string };
      const parts = ['select=*,customer:customer_id(id,full_name,phone,telegram_id),course:course_id(id,name,duration_minutes,price)', `instructor_id=eq.${q(instructor.id)}`, 'order=booking_date.asc'];
      if (query.from) parts.push(`booking_date=gte.${q(query.from)}`);
      if (query.to) parts.push(`booking_date=lt.${q(query.to)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' }); }
  });

  app.post('/api/instructor/notify-test', async (request, reply) => {
    try {
      const tg = await authenticate(request);
      const user = await userForTelegram(tg);
      const instructor = user ? await instructorForUser(user.id) : null;
      if (!user || user.role !== 'instructor' || !user.is_active || user.is_blocked || !instructor?.is_verified) return reply.code(403).send({ ok: false, error: 'Instructor approval is pending' });
      if (!BOT_TOKEN) return reply.code(503).send({ ok: false, error: 'Telegram bot is not configured' });
      const ok = await sendEventNotification(BOT_TOKEN, tg.id, '🔔 Avtodrom test', 'Telegram xabarnoma kanali muvaffaqiyatli ulangan.', MINI_APP_URL);
      return { ok };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Notification test failed' }); }
  });
}
