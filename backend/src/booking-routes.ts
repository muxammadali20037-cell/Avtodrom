import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';
function q(value: string) { return encodeURIComponent(value); }
async function profileForTelegram(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('profiles', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ telegram_id: user.id, first_name: user.first_name, last_name: user.last_name, username: user.username }) });
  return created[0];
}
export async function registerBookingRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/me', async (request, reply) => { try { return { ok: true, profile: await profileForTelegram(await authenticate(request)) }; } catch { return reply.code(401).send({ ok: false, error: 'Unauthorized' }); } });
  app.get('/api/bookings', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request)); const query = request.query as { from?: string; to?: string; status?: string };
      const parts = ['select=*,customer:customer_id(id,first_name,last_name,username),instructor:instructor_id(id,profile_id,active),car:car_id(id,plate_number,model,active)', 'order=start_at.asc'];
      if (query.from) parts.push(`start_at=gte.${q(query.from)}`); if (query.to) parts.push(`start_at=lt.${q(query.to)}`); if (query.status) parts.push(`status=eq.${q(query.status)}`);
      if (profile.role === 'customer') parts.push(`customer_id=eq.${q(profile.id)}`);
      if (profile.role === 'instructor') { const ins = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&select=id` }); if (!ins[0]) return { ok: true, bookings: [] }; parts.push(`instructor_id=eq.${q(ins[0].id)}`); }
      return { ok: true, bookings: await supabaseRest<any[]>('bookings', { query: `?${parts.join('&')}` }) };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load bookings' }); }
  });
  app.post('/api/bookings', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request)); const body = request.body as { instructor_id?: string; car_id?: string; start_at: string; end_at: string; customer_note?: string };
      if (!body.start_at || !body.end_at) return reply.code(400).send({ ok: false, error: 'start_at and end_at are required' });
      const start = new Date(body.start_at), end = new Date(body.end_at); if (!(start < end) || start < new Date()) return reply.code(400).send({ ok: false, error: 'Invalid booking time' });
      const conflicts = await supabaseRest<any[]>('bookings', { query: `?start_at=lt.${q(body.end_at)}&end_at=gt.${q(body.start_at)}&status=in.(pending,confirmed,in_progress)&select=id,customer_id,instructor_id,car_id` });
      if (conflicts.some(x => x.customer_id === profile.id)) return reply.code(409).send({ ok: false, error: 'You already have a booking at this time' });
      if (body.instructor_id && conflicts.some(x => x.instructor_id === body.instructor_id)) return reply.code(409).send({ ok: false, error: 'Instructor is busy at this time' });
      if (body.car_id && conflicts.some(x => x.car_id === body.car_id)) return reply.code(409).send({ ok: false, error: 'Car is busy at this time' });
      const rows = await supabaseRest<any[]>('bookings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ customer_id: profile.id, instructor_id: body.instructor_id || null, car_id: body.car_id || null, start_at: body.start_at, end_at: body.end_at, customer_note: body.customer_note || null, status: 'pending' }) });
      const booking = rows[0]; if (booking) await supabaseRest('notifications', { method: 'POST', body: JSON.stringify({ profile_id: profile.id, booking_id: booking.id, title: 'Bron yaratildi', body: 'Mashg‘ulot broni yaratildi va tasdiqlash uchun yuborildi.', channel: 'in_app' }) });
      return reply.code(201).send({ ok: true, booking });
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Booking failed' }); }
  });
  app.patch('/api/bookings/:id/status', async (request, reply) => {
    try {
      const profile = await profileForTelegram(await authenticate(request)); if (!['admin','instructor'].includes(profile.role)) return reply.code(403).send({ ok: false, error: 'Forbidden' });
      const id = (request.params as any).id as string; const body = request.body as { status: string; reason?: string };
      if (!['confirmed','cancelled','in_progress','completed','no_show'].includes(body.status)) return reply.code(400).send({ ok: false, error: 'Invalid status' });
      const current = await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*` }); if (!current[0]) return reply.code(404).send({ ok: false, error: 'Booking not found' });
      if (profile.role === 'instructor') { const ins = await supabaseRest<any[]>('instructors', { query: `?profile_id=eq.${q(profile.id)}&select=id` }); if (!ins[0] || current[0].instructor_id !== ins[0].id) return reply.code(403).send({ ok: false, error: 'Booking is not assigned to this instructor' }); }
      const rows = await supabaseRest<any[]>('bookings', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`, body: JSON.stringify({ status: body.status, cancelled_reason: body.reason || null, updated_at: new Date().toISOString() }) });
      const booking = rows[0]; await supabaseRest('notifications', { method: 'POST', body: JSON.stringify({ profile_id: booking.customer_id, booking_id: booking.id, title: 'Bron holati o‘zgardi', body: `Bron holati: ${body.status}`, channel: 'in_app' }) }); return { ok: true, booking };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Status update failed' }); }
  });
  app.get('/api/notifications', async (request, reply) => { try { const profile = await profileForTelegram(await authenticate(request)); return { ok: true, notifications: await supabaseRest<any[]>('notifications', { query: `?profile_id=eq.${q(profile.id)}&select=*&order=created_at.desc&limit=100` }) }; } catch { return reply.code(401).send({ ok: false, error: 'Unauthorized' }); } });
}
