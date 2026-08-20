import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

export function registerCatalogRoutes(app: FastifyInstance, authenticate: (request: any) => Promise<TelegramWebAppUser>) {
  app.get('/api/catalog/instructors', async (_request, reply) => {
    try {
      const rows = await supabaseRest<any[]>('instructors', { query: '?approval_status=eq.approved&active=eq.true&select=id,profile_id,experience_years,rating,bio,profile:profile_id(id,first_name,last_name,username)&order=rating.desc' });
      return { ok: true, instructors: rows };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load instructors' }); }
  });

  app.get('/api/catalog/cars', async (_request, reply) => {
    try {
      const rows = await supabaseRest<any[]>('cars', { query: '?active=eq.true&status=eq.available&select=id,brand,model,plate_number,status&order=model.asc' });
      return { ok: true, cars: rows };
    } catch (e) { return reply.code(400).send({ ok: false, error: e instanceof Error ? e.message : 'Failed to load cars' }); }
  });

  app.get('/api/catalog/availability', async (request, reply) => {
    try {
      await authenticate(request);
      const qv = request.query as { start_at?: string; end_at?: string };
      if (!qv.start_at || !qv.end_at) return reply.code(400).send({ ok: false, error: 'start_at and end_at are required' });
      const conflicts = await supabaseRest<any[]>('bookings', { query: `?start_at=lt.${encodeURIComponent(qv.end_at)}&end_at=gt.${encodeURIComponent(qv.start_at)}&status=in.(pending,confirmed,in_progress)&select=instructor_id,car_id` });
      return { ok: true, busyInstructorIds: conflicts.map(x => x.instructor_id).filter(Boolean), busyCarIds: conflicts.map(x => x.car_id).filter(Boolean) };
    } catch { return reply.code(401).send({ ok: false, error: 'Unauthorized' }); }
  });
}
