import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendEventNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }
const BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';

async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('profiles', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ telegram_id: user.id, first_name: user.first_name || null, last_name: user.last_name || null, username: user.username || null, role: 'customer' }) });
  return created[0];
}

export async function registerInstructorRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/instructor/me', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      if (profile.role !== 'instructor') return reply.code(403).send({ ok: false, error: 'Instructor access is not approved', profile });
      const instructors = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&select=*` });
      return { ok: true, profile, instructor: instructors[0] || null };
    } catch (e) { return reply.code(401).send({ ok: false, error: e instanceof Error ? e.message : 'Unauthorized' }); }
  });

  app.post('/api/instructor/register', async (request, reply) => {
    try {
      const user = await authenticate(request);
      const body = (request.body || {}) as { phone?: string; first_name?: string; last_name?: string };
      const phone = String(body.phone || '').trim();
      const firstName = String(body.first_name || user.first_name || '').trim();
      const lastName = String(body.last_name || user.last_name || '').trim();
      if (phone.length < 7) return reply.code(400).send({ ok: false, error: 'Telefon raqami noto‘g‘ri' });
      if (firstName.length < 2) return reply.code(400).send({ ok: false, error: 'Ism kiritilishi kerak' });

      const profile = await profileForTelegram(user);
      if (profile.role !== 'instructor') {
        return reply.code(403).send({ ok: false, error: 'Instructor access must be approved by an admin before registration' });
      }
      const profileRows = await supabaseRest<any[]>('profiles', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(profile.id)}`, body: JSON.stringify({ first_name: firstName, last_name: lastName || null, phone, updated_at: new Date().toISOString() }) });
      const updatedProfile = profileRows[0] || profile;
      const existing = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&select=*` });
      let instructor = existing[0];
      if (!instructor) {
        const created = await supabaseRest<any[]>('instructors', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ profile_id: profile.id, active: true }) });
        instructor = created[0];
      }
      return reply.code(201).send({ ok: true, profile: updatedProfile, instructor });
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Registration failed' }); }
  });

  app.get('/api/instructor/bookings', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      if (profile.role !== 'instructor') return reply.code(403).send({ ok: false, error: 'Forbidden' });
      const instructors = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&select=id,active` });
      if (!instructors[0]) return { ok: true, bookings: [] };
      const query = request.query as { from?: string; to?: string };
      const parts = [`select=*,customer:customer_id(id,first_name,last_name,username,phone),car:car_id(id,plate_number,model,active)`, `instructor_id=eq.${q(instructors[0].id)}`, 'order=start_at.asc'];
      if (query.from) parts.push(`start_at=gte.${q(query.from)}`);
      if (query.to) parts.push(`start_at=lt.${q(query.to)}`);
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructor bookings' }); }
  });

  app.post('/api/instructor/notify-test', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request));
      if (profile.role !== 'instructor') return reply.code(403).send({ ok: false, error: 'Forbidden' });
      if (!BOT_TOKEN) return reply.code(503).send({ ok: false, error: 'Telegram bot is not configured' });
      const ok = await sendEventNotification(BOT_TOKEN, profile.telegram_id, '🔔 Avtodrom test', 'Telegram xabarnoma kanali muvaffaqiyatli ulangan.', MINI_APP_URL);
      return { ok };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Notification test failed' }); }
  });
}
