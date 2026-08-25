import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET = 'customer-media';

function q(value: string) { return encodeURIComponent(value); }

function getCookie(request: any): string {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}

function validSession(token: string): boolean {
  try {
    const fallback = String(process.env.ADMIN_PASSWORD || '').trim();
    const secret = String(process.env.ADMIN_SESSION_SECRET || fallback).trim();
    const login = String(process.env.ADMIN_LOGIN || '').trim();
    if (!secret || !login || !token) return false;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const first = decoded.indexOf(':'), second = decoded.indexOf(':', first + 1);
    if (first <= 0 || second <= first) return false;
    const actual = decoded.slice(0, first);
    const timestamp = Number(decoded.slice(first + 1, second));
    const signature = decoded.slice(second + 1);
    if (actual !== login || !Number.isFinite(timestamp) || !signature) return false;
    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch { return false; }
}

async function requireAdmin(request: any) {
  if (!validSession(getCookie(request))) throw new Error('Unauthorized');
}

async function safeRows<T = any>(table: string, query: string, options: any = {}): Promise<T[]> {
  try { return await supabaseRest<T[]>(table, { query, ...options }); }
  catch (error) { console.error(`Admin dashboard read failed: ${table}`, error); return []; }
}

function publicUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

async function getState(): Promise<any> {
  const rows = await safeRows<any>('app_state', '?id=eq.main&select=data,updated_at');
  return rows[0] || { data: {}, updated_at: null };
}

async function saveState(data: any) {
  const body = JSON.stringify({ id: 'main', data, updated_at: new Date().toISOString() });
  const rows = await supabaseRest<any[]>('app_state', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    query: '?id=eq.main',
    body,
  });
  if (rows[0]) return rows[0];
  const created = await supabaseRest<any[]>('app_state', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body,
  });
  return created[0];
}

async function approveApplication(applicationId: string) {
  const applications = await supabaseRest<any[]>('instructor_applications', {
    query: `?id=eq.${q(applicationId)}&select=*`
  });
  const application = applications[0];
  if (!application) throw new Error('Ariza topilmadi');

  const now = new Date().toISOString();
  const updatedApplications = await supabaseRest<any[]>('instructor_applications', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    query: `?id=eq.${q(applicationId)}`,
    body: JSON.stringify({ status: 'APPROVED', reviewed_at: now, rejection_reason: null, updated_at: now }),
  });

  const existingUsers = await supabaseRest<any[]>('users', {
    query: `?telegram_id=eq.${q(String(application.telegram_user_id))}&select=*&limit=1`
  });
  let user = existingUsers[0];
  const fullName = `${application.first_name || ''} ${application.last_name || ''}`.trim();

  if (user) {
    const rows = await supabaseRest<any[]>('users', {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      query: `?id=eq.${q(String(user.id))}`,
      body: JSON.stringify({
        phone: application.phone,
        full_name: fullName,
        role: 'instructor',
        is_active: true,
        is_blocked: false,
        updated_at: now,
      }),
    });
    user = rows[0] || user;
  } else {
    const rows = await supabaseRest<any[]>('users', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        telegram_id: application.telegram_user_id,
        phone: application.phone,
        full_name: fullName,
        role: 'instructor',
        is_active: true,
        is_blocked: false,
      }),
    });
    user = rows[0];
  }

  if (!user?.id) throw new Error('Instruktor foydalanuvchisi yaratilmadi');

  const existingProfiles = await supabaseRest<any[]>('instructor_profiles', {
    query: `?user_id=eq.${q(String(user.id))}&select=*&limit=1`
  });
  const profileBody = JSON.stringify({
    experience_years: Number(application.experience_years || 0),
    bio: application.message || null,
    is_verified: true,
    is_available: true,
    updated_at: now,
  });

  if (existingProfiles[0]) {
    await supabaseRest('instructor_profiles', {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      query: `?id=eq.${q(String(existingProfiles[0].id))}`,
      body: profileBody,
    });
  } else {
    await supabaseRest('instructor_profiles', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: user.id,
        experience_years: Number(application.experience_years || 0),
        bio: application.message || null,
        is_verified: true,
        is_available: true,
      }),
    });
  }

  try {
    const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
    const miniAppUrl = String(process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor');
    if (token && application.telegram_user_id) {
      await sendBookingNotification(
        token,
        Number(application.telegram_user_id),
        '✅ Arizangiz tasdiqlandi!\n\nEndi AVTODROM Instruktor Mini Appiga kirib, bronlaringizni ko‘rishingiz va mijozlarni qabul qilishingiz mumkin.',
        miniAppUrl,
        '👨‍🏫 Instruktor panelini ochish'
      );
    }
  } catch (error) {
    console.error('Instructor approval notification failed:', error);
  }

  return updatedApplications[0] || application;
}

async function rejectApplication(applicationId: string, reason: string | null) {
  const applications = await supabaseRest<any[]>('instructor_applications', {
    query: `?id=eq.${q(applicationId)}&select=*`
  });
  const application = applications[0];
  if (!application) throw new Error('Ariza topilmadi');

  const rows = await supabaseRest<any[]>('instructor_applications', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    query: `?id=eq.${q(applicationId)}`,
    body: JSON.stringify({
      status: 'REJECTED',
      reviewed_at: new Date().toISOString(),
      rejection_reason: reason,
      updated_at: new Date().toISOString(),
    }),
  });

  try {
    const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
    const miniAppUrl = String(process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor');
    if (token && application.telegram_user_id) {
      await sendBookingNotification(
        token,
        Number(application.telegram_user_id),
        `❌ Arizangiz rad etildi.${reason ? `\n\nSabab: ${reason}` : ''}`,
        miniAppUrl,
        '📝 Qayta ariza yuborish'
      );
    }
  } catch (error) {
    console.error('Instructor rejection notification failed:', error);
  }

  return rows[0] || application;
}

/**
 * Legacy dashboard endpoints live here only when they do not overlap the
 * canonical admin-routes.ts endpoints. Keeping one owner per URL prevents
 * Fastify FST_ERR_DUPLICATED_ROUTE during cold start on Vercel.
 */
export function registerAdminDashboardRoutes(app: FastifyInstance) {
  app.get('/api/admin/dashboard', async (request, reply) => {
    try {
      await requireAdmin(request);
      const [users, instructors, bookings, media] = await Promise.all([
        safeRows('users', '?role=eq.customer&select=id'),
        safeRows('instructor_profiles', '?select=id,is_available'),
        safeRows('bookings', '?select=id,status,booking_date,price,payment_status,created_at&order=created_at.desc'),
        safeRows('admin_media', '?select=id&order=created_at.desc'),
      ]);
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      const todayBookings = bookings.filter((row: any) => {
        const value = row.booking_date || row.created_at;
        const date = new Date(value);
        return date >= start && date < end;
      });
      const revenue = todayBookings.reduce((sum: number, row: any) => sum + Number(row.price || 0), 0);
      return {
        ok: true,
        dashboard: {
          users: users.length,
          activeInstructors: instructors.filter((x: any) => x.is_available !== false).length,
          instructors: instructors.length,
          pendingBookings: bookings.filter((x: any) => x.status === 'pending').length,
          todayBookings: todayBookings.length,
          todayRevenue: revenue,
          revenue,
          media: media.length,
        },
      };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Dashboard failed' });
    }
  });

  // Instructor applications: this is the single admin-panel approval flow.
  app.get('/api/admin/applications', async (request, reply) => {
    try {
      await requireAdmin(request);
      const applications = await supabaseRest<any[]>('instructor_applications', {
        query: '?select=*&order=created_at.desc'
      });
      return { ok: true, applications };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Arizalar yuklanmadi' });
    }
  });

  app.post('/api/admin/applications/:id/approve', async (request, reply) => {
    try {
      await requireAdmin(request);
      const application = await approveApplication(String((request.params as any).id));
      return { ok: true, application };
    } catch (error: any) {
      console.error('Admin application approval failed:', error);
      return reply.code(400).send({ ok: false, error: error?.message || 'Tasdiqlash amalga oshmadi' });
    }
  });

  app.post('/api/admin/applications/:id/reject', async (request, reply) => {
    try {
      await requireAdmin(request);
      const reason = String((request.body as any)?.reason || '').trim() || null;
      const application = await rejectApplication(String((request.params as any).id), reason);
      return { ok: true, application };
    } catch (error: any) {
      console.error('Admin application rejection failed:', error);
      return reply.code(400).send({ ok: false, error: error?.message || 'Rad etish amalga oshmadi' });
    }
  });

  // Legacy report endpoints kept under their old names; they do not conflict
  // with the canonical /api/admin/stats endpoint in admin-routes.ts.
  app.get('/api/admin/results', async (request, reply) => {
    try {
      await requireAdmin(request);
      const rows = await safeRows<any>('bookings', '?select=*&order=created_at.desc');
      const revenue = rows.reduce((sum: number, row: any) => sum + Number(row.price || 0), 0);
      return {
        ok: true,
        results: rows,
        summary: {
          total: rows.length,
          completed: rows.filter((row: any) => row.status === 'completed').length,
          revenue,
        },
      };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Natijalar yuklanmadi' });
    }
  });

  app.get('/api/admin/prices', async (request, reply) => {
    try {
      await requireAdmin(request);
      const state = await getState();
      const prices = Array.isArray(state.data?.prices) ? state.data.prices : [];
      return { ok: true, prices };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Narxlar yuklanmadi' });
    }
  });

  app.get('/api/admin/tariffs', async (request, reply) => {
    try {
      await requireAdmin(request);
      const state = await getState();
      return { ok: true, tariffs: Array.isArray(state.data?.prices) ? state.data.prices : [] };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Tariflar yuklanmadi' });
    }
  });

  app.post('/api/admin/prices', async (request, reply) => {
    try {
      await requireAdmin(request);
      const state = await getState();
      const prices = Array.isArray(state.data?.prices) ? state.data.prices : [];
      const item = { id: `price-${Date.now()}`, ...((request.body || {}) as any), status: 'active' };
      prices.push(item);
      await saveState({ ...state.data, prices });
      return { ok: true, price: item };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Narx saqlanmadi' });
    }
  });

  app.patch('/api/admin/prices/:id', async (request, reply) => {
    try {
      await requireAdmin(request);
      const state = await getState();
      const prices = Array.isArray(state.data?.prices) ? state.data.prices : [];
      const index = prices.findIndex((row: any) => String(row.id) === String((request.params as any).id));
      if (index < 0) return reply.code(404).send({ ok: false, error: 'Narx topilmadi' });
      prices[index] = { ...prices[index], ...((request.body || {}) as any) };
      await saveState({ ...state.data, prices });
      return { ok: true, price: prices[index] };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Narx yangilanmadi' });
    }
  });

  app.patch('/api/admin/settings', async (request, reply) => {
    try {
      await requireAdmin(request);
      const state = await getState();
      const settings = { ...(state.data?.settings || {}), ...((request.body || {}) as any) };
      await saveState({ ...state.data, settings });
      return { ok: true, settings };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Sozlamalar saqlanmadi' });
    }
  });

  // Media endpoints are unique to this legacy dashboard module.
  app.get('/api/admin/media', async (request, reply) => {
    try {
      await requireAdmin(request);
      const rows = await safeRows<any>('admin_media', '?select=*&order=created_at.desc');
      return {
        ok: true,
        media: rows.map((row: any) => ({
          ...row,
          id: String(row.id),
          type: row.media_type,
          url: row.public_url || publicUrl(row.storage_path || ''),
          active: row.is_active !== false,
        })),
      };
    } catch (error: any) {
      return reply.code(500).send({ ok: false, error: error?.message || 'Media yuklanmadi' });
    }
  });

  app.post('/api/admin/media', async (request, reply) => {
    try {
      await requireAdmin(request);
      const body = (request.body || {}) as any;
      const rows = await supabaseRest<any[]>('admin_media', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          key: `admin_${Date.now()}`,
          title: String(body.title || 'Media'),
          media_type: String(body.type || body.media_type || 'video'),
          storage_path: String(body.storage_path || ''),
          public_url: String(body.url || body.public_url || ''),
          is_active: true,
          sort_order: 0,
        }),
      });
      return { ok: true, media: rows[0] };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error?.message || 'Media saqlanmadi' });
    }
  });

  app.delete('/api/admin/media/:id', async (request, reply) => {
    try {
      await requireAdmin(request);
      await supabaseRest<any[]>('admin_media', {
        method: 'DELETE',
        headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(String((request.params as any).id))}`,
      });
      return { ok: true };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error?.message || 'Media o‘chirilmadi' });
    }
  });

  app.post('/api/admin/media/sign', async (request, reply) => {
    try {
      await requireAdmin(request);
      if (!SUPABASE_URL || !SERVICE_KEY) {
        return reply.code(500).send({ ok: false, error: 'Supabase server credentials are missing' });
      }
      const body = (request.body || {}) as any;
      const name = String(body.file_name || body.filename || 'video.mp4').replace(/[^a-zA-Z0-9._-]/g, '_');
      const type = String(body.content_type || body.contentType || 'video/mp4').toLowerCase();
      if (!type.startsWith('video/')) return reply.code(400).send({ ok: false, error: 'Faqat video fayl yuklang' });
      const path = `customer/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${name}`;
      const client = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const { data, error } = await client.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data?.token) throw new Error(error?.message || 'Signed upload URL yaratilmadi');
      return {
        ok: true,
        path,
        storage_path: path,
        token: data.token,
        upload_url: `${SUPABASE_URL}/storage/v1/object/upload/sign/${BUCKET}/${encodeURIComponent(path)}?token=${encodeURIComponent(data.token)}`,
        public_url: publicUrl(path),
      };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error?.message || 'Upload tayyorlashda xato' });
    }
  });

  app.post('/api/admin/media/commit', async (request, reply) => {
    try {
      await requireAdmin(request);
      const body = (request.body || {}) as any;
      const rows = await supabaseRest<any[]>('admin_media', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          key: `admin_${Date.now()}`,
          title: String(body.title || 'Video'),
          media_type: 'video',
          storage_path: String(body.storage_path || body.path || ''),
          public_url: String(body.public_url || ''),
          is_active: true,
          sort_order: 0,
        }),
      });
      return { ok: true, media: rows[0] };
    } catch (error: any) {
      return reply.code(400).send({ ok: false, error: error?.message || 'Video ma’lumotini saqlashda xato' });
    }
  });
}