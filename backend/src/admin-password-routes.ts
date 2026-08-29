import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';

const COOKIE = 'avtodrom_admin_session', TTL = 60 * 60 * 12;
const q = (v: string) => encodeURIComponent(v);

function cookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const x = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE + '='));
  if (!x) return '';
  try { return decodeURIComponent(x.slice(COOKIE.length + 1)); } catch { return ''; }
}
function secret() { return String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim(); }
function token(login: string) {
  const s = secret();
  if (!s) throw Error('ADMIN_SESSION_SECRET yoki ADMIN_PASSWORD sozlanmagan');
  const ts = Date.now(), p = `${login}:${ts}`, sig = createHmac('sha256', s).update(p).digest('hex');
  return Buffer.from(`${p}:${sig}`).toString('base64url');
}
function valid(t: string) {
  try {
    const s = secret(), loginExpected = String(process.env.ADMIN_LOGIN || '').trim();
    const d = Buffer.from(t || '', 'base64url').toString('utf8');
    const a = d.indexOf(':'), b = d.indexOf(':', a + 1);
    if (!s || !loginExpected || a <= 0 || b <= a) return false;
    const login = d.slice(0, a), ts = Number(d.slice(a + 1, b)), sig = d.slice(b + 1);
    if (login !== loginExpected || !Number.isFinite(ts) || Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return false;
    const e = createHmac('sha256', s).update(`${login}:${ts}`).digest('hex');
    const x = Buffer.from(sig), y = Buffer.from(e);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}
async function guard(req: any) {
  if (!valid(cookie(req))) { const e: any = new Error('Admin login talab qilinadi'); e.statusCode = 401; throw e; }
}
function setCookie(reply: any, t: string) {
  reply.header('Set-Cookie', `${COOKIE}=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${TTL}`);
}
function clearCookie(reply: any) {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}
function err(reply: any, e: any, msg: string, status = 500) {
  return reply.code(e?.statusCode ?? status).send({ ok: false, error: e?.message || msg });
}

/**
 * `safe()` endi xatoni yutib yubormaydi — chaqiruvchi natijani va (bo'lsa)
 * ogohlantirishni birga oladi. Buzuq jadval "bo'sh ro'yxat" bo'lib
 * ko'rinmasin, degan audit talabi shu yerda bajarilgan.
 */
async function safeR<T = any>(table: string, query: string): Promise<{ rows: T[]; warning: string | null }> {
  try { return { rows: await supabaseRest<T[]>(table, { query }), warning: null }; }
  catch (e) {
    console.error('Admin read failed', table, e);
    return { rows: [], warning: `"${table}" o‘qilmadi: ${e instanceof Error ? e.message : 'noma’lum xato'}` };
  }
}
/** Eski, oddiy shakl — warning kerak bo'lmagan joylarda. */
async function safe<T = any>(table: string, query: string): Promise<T[]> {
  return (await safeR<T>(table, query)).rows;
}

async function adminUser() {
  const r = await supabaseRest<any[]>('users', { query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=*&limit=1' });
  if (!r[0]) throw Error('Admin foydalanuvchisi topilmadi');
  return r[0];
}

/** Audit log: har bir muhim admin amali yoziladi (talab 22-bo'lim). Yozib bo'lmasa oqim to'xtamaydi. */
async function audit(adminId: string | null, action: string, entityType: string, entityId: string | null, oldData: unknown, newData: unknown) {
  try {
    await supabaseRest('admin_audit_logs', {
      method: 'POST',
      body: JSON.stringify({
        admin_id: adminId, action, entity_type: entityType, entity_id: entityId,
        old_data: oldData ?? null, new_data: newData ?? null,
      }),
    });
  } catch (e) { console.error('Audit log yozilmadi:', action, e); }
}

/**
 * Instructor reytingi faqat shu yerda, faqat approved review'lardan hisoblanadi.
 * Instructor buni o'zi o'zgartira olmaydi — chunki bu funksiyaga faqat admin
 * review moderation orqali murojaat qilinadi.
 */
async function recalcInstructorRating(instructorId: string) {
  const rows = await supabaseRest<any[]>('reviews', {
    query: `?instructor_id=eq.${q(instructorId)}&status=eq.approved&select=rating`,
  });
  const ratings = rows.map((r) => Number(r.rating)).filter((n) => Number.isFinite(n));
  const avg = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : 0;
  await supabaseRest('instructor_profiles', {
    method: 'PATCH',
    query: `?id=eq.${q(instructorId)}`,
    body: JSON.stringify({ rating: avg, total_reviews: ratings.length, updated_at: new Date().toISOString() }),
  });
  return { rating: avg, total_reviews: ratings.length };
}

export async function registerAdminPasswordRoutes(app: FastifyInstance) {
  app.post('/api/admin/login', async (req: any, reply: any) => {
    try {
      const login = String(req.body?.login || '').trim(), password = String(req.body?.password || '');
      const el = String(process.env.ADMIN_LOGIN || '').trim(), ep = String(process.env.ADMIN_PASSWORD || '');
      if (!el || !ep) return err(reply, null, 'ADMIN_LOGIN yoki ADMIN_PASSWORD Vercelda sozlanmagan', 500);
      if (login !== el || password !== ep) return reply.code(401).send({ ok: false, error: 'Login yoki parol noto‘g‘ri' });
      setCookie(reply, token(login));
      try { const admin = await adminUser(); await audit(admin.id, 'LOGIN', 'admin', admin.id, null, null); } catch { /* audit ixtiyoriy */ }
      return { ok: true, login };
    } catch (e) { return err(reply, e, 'Admin login failed'); }
  });

  app.post('/api/admin/logout', async (_req: any, reply: any) => { clearCookie(reply); return { ok: true }; });

  app.get('/api/admin/me', async (req: any, reply: any) => {
    try { await guard(req); return { ok: true, login: String(process.env.ADMIN_LOGIN || 'admin') }; }
    catch (e) { return err(reply, e, 'Unauthorized', 401); }
  });

  app.get('/api/admin/stats', async (req: any, reply: any) => {
    try {
      await guard(req);
      const [users, ips, bookings, reviews, payments] = await Promise.all([
        safe<any>('users', '?role=eq.customer&select=id'),
        safe<any>('instructor_profiles', '?select=id,user_id,is_available,rating,total_reviews,is_verified'),
        safe<any>('bookings', '?select=id,status,booking_date,created_at'),
        safe<any>('reviews', '?select=id,status,rating'),
        safe<any>('payments', '?select=id,amount,status,paid_at,created_at'),
      ]);
      const s = new Date(); s.setHours(0, 0, 0, 0);
      const e = new Date(s); e.setDate(e.getDate() + 1);
      const today = bookings.filter((b: any) => { const d = new Date(b.booking_date || b.created_at); return d >= s && d < e; });
      const paid = payments.filter((p: any) => String(p.status || '').toLowerCase() === 'paid')
        .filter((p: any) => { const d = new Date(p.paid_at || p.created_at); return d >= s && d < e; })
        .reduce((a: number, p: any) => a + Number(p.amount || 0), 0);
      const rr = reviews.filter((r: any) => String(r.status || '').toLowerCase() === 'approved')
        .map((r: any) => Number(r.rating || 0)).filter(Number.isFinite);
      return {
        ok: true,
        stats: {
          customers: users.length,
          instructors: ips.filter((i: any) => i.is_available && i.is_verified !== false).length,
          pendingBookings: bookings.filter((b: any) => b.status === 'pending').length,
          todayBookings: today.length,
          completedBookings: bookings.filter((b: any) => b.status === 'completed').length,
          averageRating: rr.length ? Number((rr.reduce((a: number, b: number) => a + b, 0) / rr.length).toFixed(2)) : 0,
          paidToday: paid,
        },
      };
    } catch (e) { return err(reply, e, 'Stats failed'); }
  });

  app.get('/api/admin/instructors', async (req: any, reply: any) => {
    try {
      await guard(req);
      const [ipsR, usersR] = await Promise.all([
        safeR<any>('instructor_profiles', '?select=*&order=created_at.desc'),
        safeR<any>('users', '?select=id,telegram_id,phone,full_name,role,is_active,is_blocked,created_at'),
      ]);
      const um = new Map(usersR.rows.map((u: any) => [String(u.id), u]));
      const warnings = [ipsR.warning, usersR.warning].filter(Boolean);
      return {
        ok: true,
        warnings,
        instructors: ipsR.rows.map((x: any) => ({
          ...x, id: x.id,
          active: Boolean(x.is_available && x.is_verified && um.get(String(x.user_id))?.is_active && !um.get(String(x.user_id))?.is_blocked),
          profile: um.get(String(x.user_id)) || null,
        })),
      };
    } catch (e) { return err(reply, e, 'Failed to load instructors'); }
  });

  app.post('/api/admin/instructors', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const b = req.body || {};
      const first = String(b.first_name || '').trim(), last = String(b.last_name || '').trim();
      const phone = String(b.phone || '').trim(), tg = b.telegram_id ? Number(b.telegram_id) : null;
      if (first.length < 2) return reply.code(400).send({ ok: false, error: 'Ism majburiy' });

      let u: any = tg ? (await safe<any>('users', `?telegram_id=eq.${q(String(tg))}&select=*&limit=1`))[0] : null;
      const full = [first, last].filter(Boolean).join(' ');
      try {
        if (u) {
          u = (await supabaseRest<any[]>('users', {
            method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(u.id)}`,
            body: JSON.stringify({ phone: phone || null, full_name: full, role: 'instructor', is_active: true, is_blocked: false, updated_at: new Date().toISOString() }),
          }))[0] || u;
        } else {
          u = (await supabaseRest<any[]>('users', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ telegram_id: tg, phone: phone || null, full_name: full, role: 'instructor', is_active: true, is_blocked: false }),
          }))[0];
        }
      } catch (e: any) {
        if (/duplicate key.*phone/i.test(String(e?.message))) {
          return reply.code(409).send({ ok: false, error: 'Bu telefon raqami boshqa foydalanuvchida ro‘yxatdan o‘tgan' });
        }
        throw e;
      }
      if (!u) throw Error('Instruktor foydalanuvchisi yaratilmadi');

      const ip = (await supabaseRest<any[]>('instructor_profiles', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ user_id: u.id, experience_years: Number(b.experience_years || 0), bio: String(b.bio || '').trim() || null, rating: 0, total_reviews: 0, is_verified: true, is_available: true }),
      }))[0];

      await audit(admin.id, 'INSTRUCTOR_CREATED', 'instructor_profiles', ip?.id ?? null, null, { user: u, instructor_profile: ip });
      return reply.code(201).send({ ok: true, instructor: { ...ip, profile: u, active: true } });
    } catch (e) { return err(reply, e, 'Instructor creation failed', 400); }
  });

  app.patch('/api/admin/instructors/:id', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id), b = req.body || {};
      const ip = (await supabaseRest<any[]>('instructor_profiles', { query: `?id=eq.${q(id)}&select=*` }))[0];
      if (!ip) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });

      if (typeof b.active === 'boolean') {
        await supabaseRest('instructor_profiles', {
          method: 'PATCH', query: `?id=eq.${q(id)}`,
          body: JSON.stringify({ is_available: b.active, updated_at: new Date().toISOString() }),
        });
        await supabaseRest('users', {
          method: 'PATCH', query: `?id=eq.${q(ip.user_id)}`,
          body: JSON.stringify({ is_active: b.active, is_blocked: !b.active, updated_at: new Date().toISOString() }),
        });
        await audit(admin.id, b.active ? 'INSTRUCTOR_RESTORED' : 'INSTRUCTOR_DISABLED', 'instructor_profiles', id, { active: ip.is_available }, { active: b.active });
      }
      return { ok: true };
    } catch (e) { return err(reply, e, 'Instructor update failed', 400); }
  });

  app.get('/api/admin/bookings', async (req: any, reply: any) => {
    try {
      await guard(req);
      const st = String(req.query?.status || ''), filter = st ? `&status=eq.${q(st)}` : '';
      const [bookingsR, usersR, ipsR, coursesR] = await Promise.all([
        safeR<any>('bookings', `?select=*&order=booking_date.desc${filter}`),
        safeR<any>('users', '?select=id,telegram_id,phone,full_name,role'),
        safeR<any>('instructor_profiles', '?select=id,user_id,rating,total_reviews'),
        safeR<any>('courses', '?select=id,name,duration_minutes,price,is_active'),
      ]);
      const um = new Map(usersR.rows.map((u: any) => [String(u.id), u]));
      const im = new Map(ipsR.rows.map((i: any) => [String(i.id), i]));
      const cm = new Map(coursesR.rows.map((c: any) => [String(c.id), c]));
      const warnings = [bookingsR.warning, usersR.warning, ipsR.warning, coursesR.warning].filter(Boolean);
      return {
        ok: true,
        warnings,
        bookings: bookingsR.rows.map((b: any) => {
          const i = im.get(String(b.instructor_id)), c = cm.get(String(b.course_id));
          const u = i ? um.get(String(i.user_id)) : null;
          return {
            ...b,
            start_at: b.start_at || b.booking_date,
            end_at: b.end_at || ((b.booking_date && c?.duration_minutes) ? new Date(new Date(b.booking_date).getTime() + Number(c.duration_minutes) * 60000).toISOString() : null),
            price: c?.price ?? 0,
            customer: um.get(String(b.customer_id)) || null,
            instructor: i ? { ...i, profile: u || null } : null,
            course: c || null,
          };
        }),
      };
    } catch (e) { return err(reply, e, 'Failed to load bookings'); }
  });

  app.patch('/api/admin/bookings/:id/status', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id), status = String(req.body?.status || '');
      const allowed = ['pending', 'confirmed', 'cancelled', 'rejected', 'in_progress', 'completed', 'no_show'];
      if (!allowed.includes(status)) return reply.code(400).send({ ok: false, error: 'Noto‘g‘ri bron holati' });

      const old = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*` }))[0];
      if (!old) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });

      const body: any = { status, updated_at: new Date().toISOString() };
      if (status === 'confirmed') { body.confirmed_at = new Date().toISOString(); body.confirmed_by = admin.id; }
      if (['cancelled', 'rejected'].includes(status)) {
        body.cancelled_at = new Date().toISOString();
        body.cancelled_by = admin.id;
        body.cancellation_reason = String(req.body?.reason || '').trim() || null;
      }
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`, body: JSON.stringify(body),
      });

      if (status === 'confirmed' && old.course_id) {
        try {
          const existingPay = await safe<any>('payments', `?booking_id=eq.${q(id)}&select=id&limit=1`);
          if (!existingPay[0]) {
            const course = (await safe<any>('courses', `?id=eq.${q(String(old.course_id))}&select=price&limit=1`))[0];
            if (course) {
              await supabaseRest('payments', {
                method: 'POST',
                body: JSON.stringify({ booking_id: id, customer_id: old.customer_id, amount: course.price, currency: 'UZS', status: 'pending' }),
              });
            }
          }
        } catch (e) { console.error('Auto-payment creation failed:', e); }
      }

      try {
        const ip = old.instructor_id ? (await safe<any>('instructor_profiles', `?id=eq.${q(String(old.instructor_id))}&select=user_id`))[0] : null;
        const u = ip?.user_id ? (await safe<any>('users', `?id=eq.${q(String(ip.user_id))}&select=telegram_id`))[0] : null;
        const t = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
        if (t && u?.telegram_id) await sendBookingNotification(t, Number(u.telegram_id), `📋 AVTODROM\n\nBron #${id}\nHolati: ${status}`, String(process.env.INSTRUCTOR_MINI_APP_URL || ''), '👨‍🏫 Instruktor paneli');
      } catch (e) { console.error('Instructor notification failed', e); }

      await audit(admin.id, 'BOOKING_STATUS_CHANGED', 'bookings', id, { status: old.status }, { status });
      return { ok: true, booking: rows[0] };
    } catch (e) { return err(reply, e, 'Booking update failed', 400); }
  });

  app.get('/api/admin/customers', async (req: any, reply: any) => {
    try {
      await guard(req);
      return { ok: true, customers: await safe<any>('users', '?role=eq.customer&select=id,telegram_id,full_name,phone,role,is_active,is_blocked,created_at&order=created_at.desc') };
    } catch (e) { return err(reply, e, 'Failed to load customers'); }
  });

  app.patch('/api/admin/customers/:id', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id), b = req.body || {};
      const old = (await safe<any>('users', `?id=eq.${q(id)}&role=eq.customer&select=id,is_active,is_blocked&limit=1`))[0];
      const patch: any = { updated_at: new Date().toISOString() };
      if (typeof b.active === 'boolean') { patch.is_active = b.active; patch.is_blocked = !b.active; }
      if (b.full_name !== undefined) patch.full_name = String(b.full_name || '').trim();
      if (b.phone !== undefined) patch.phone = String(b.phone || '').trim() || null;

      const rows = await supabaseRest<any[]>('users', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}&role=eq.customer`, body: JSON.stringify(patch),
      });
      if (typeof b.active === 'boolean') {
        await audit(admin.id, b.active ? 'CUSTOMER_UNBLOCKED' : 'CUSTOMER_BLOCKED', 'users', id, old, { active: b.active });
      }
      return { ok: true, customer: rows[0] };
    } catch (e: any) {
      if (/duplicate key.*phone/i.test(String(e?.message))) {
        return reply.code(409).send({ ok: false, error: 'Bu telefon raqami boshqa foydalanuvchida ro‘yxatdan o‘tgan' });
      }
      return err(reply, e, 'Customer update failed', 400);
    }
  });

  app.get('/api/admin/reviews', async (req: any, reply: any) => {
    try {
      await guard(req);
      const [rows, users, ips] = await Promise.all([
        safe<any>('reviews', '?select=*&order=created_at.desc'),
        safe<any>('users', '?select=id,full_name,phone'),
        safe<any>('instructor_profiles', '?select=id,user_id'),
      ]);
      const um = new Map(users.map((u: any) => [String(u.id), u]));
      const im = new Map(ips.map((i: any) => [String(i.id), i]));
      return {
        ok: true,
        reviews: rows.map((r: any) => {
          const ip = im.get(String(r.instructor_id));
          return { ...r, customer: um.get(String(r.customer_id)) || null, instructor: ip ? { ...ip, profile: um.get(String(ip.user_id)) || null } : null };
        }),
      };
    } catch (e) { return err(reply, e, 'Failed to load reviews'); }
  });

  app.patch('/api/admin/reviews/:id', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const s = String(req.body?.status || '');
      if (!['pending', 'approved', 'rejected'].includes(s)) return reply.code(400).send({ ok: false, error: 'Sharh holati noto‘g‘ri' });

      const id = String(req.params.id);
      const old = (await supabaseRest<any[]>('reviews', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!old) return reply.code(404).send({ ok: false, error: 'Sharh topilmadi' });

      const rows = await supabaseRest<any[]>('reviews', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({ status: s, admin_note: req.body?.admin_note?.trim() || null, moderated_by: admin.id, moderated_at: new Date().toISOString() }),
      });

      let ratingResult: { rating: number; total_reviews: number } | null = null;
      if (old.instructor_id && (s === 'approved' || old.status === 'approved')) {
        ratingResult = await recalcInstructorRating(String(old.instructor_id));
      }
      await audit(admin.id, 'REVIEW_MODERATED', 'reviews', id, { status: old.status }, { status: s });
      return { ok: true, review: rows[0], instructor_rating: ratingResult };
    } catch (e) { return err(reply, e, 'Review update failed', 400); }
  });

  const applications = async (req: any, reply: any) => {
    try { await guard(req); return { ok: true, applications: await supabaseRest<any[]>('instructor_applications', { query: '?select=*&order=created_at.desc' }) }; }
    catch (e) { return err(reply, e, 'Failed to load applications'); }
  };
  app.get('/api/admin/applications', applications);
  app.get('/api/admin/instructor-applications', applications);

  const approve = async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const rows = await supabaseRest<any[]>('rpc/admin_approve_instructor', { method: 'POST', body: JSON.stringify({ p_application_id: String(req.params.id), p_admin_id: admin.id }) });
      const application = Array.isArray(rows) ? rows[0] : rows;
      await audit(admin.id, 'INSTRUCTOR_CREATED', 'instructor_applications', String(req.params.id), null, application);
      return { ok: true, application };
    } catch (e) { return err(reply, e, 'Tasdiqlash amalga oshmadi', 400); }
  };
  const reject = async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const reason = String(req.body?.reason || '').trim() || null;
      const rows = await supabaseRest<any[]>('rpc/admin_reject_instructor', { method: 'POST', body: JSON.stringify({ p_application_id: String(req.params.id), p_admin_id: admin.id, p_reason: reason }) });
      const application = Array.isArray(rows) ? rows[0] : rows;
      await audit(admin.id, 'INSTRUCTOR_DISABLED', 'instructor_applications', String(req.params.id), null, { rejected: true, reason });
      return { ok: true, application };
    } catch (e) { return err(reply, e, 'Rad etish amalga oshmadi', 400); }
  };
  app.post('/api/admin/applications/:id/approve', approve);
  app.post('/api/admin/applications/:id/reject', reject);
  app.post('/api/admin/instructor-applications/:id/approve', approve);
  app.post('/api/admin/instructor-applications/:id/reject', reject);

  app.get('/api/admin/settings', async (req: any, reply: any) => {
    try { await guard(req); return { ok: true, settings: await safe<any>('admin_settings', '?select=key,value,updated_at&order=key.asc') }; }
    catch (e) { return err(reply, e, 'Failed to load settings'); }
  });
  app.put('/api/admin/settings/:key', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const key = String(req.params.key), value = req.body?.value !== undefined ? req.body.value : req.body;
      const old = await safe<any>('admin_settings', `?key=eq.${q(key)}&select=*`);
      const rows = old[0]
        ? await supabaseRest<any[]>('admin_settings', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?key=eq.${q(key)}`, body: JSON.stringify({ value, updated_at: new Date().toISOString() }) })
        : await supabaseRest<any[]>('admin_settings', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });
      await audit(admin.id, 'SETTING_UPDATED', 'admin_settings', key, old[0]?.value ?? null, value);
      return { ok: true, setting: rows[0] };
    } catch (e) { return err(reply, e, 'Setting save failed', 400); }
  });

  app.get('/api/admin/courses', async (req: any, reply: any) => {
    try { await guard(req); return { ok: true, courses: await safe<any>('courses', '?select=*&order=created_at.desc') }; }
    catch (e) { return err(reply, e, 'Failed to load courses'); }
  });
  app.post('/api/admin/courses', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const b = req.body || {};
      const name = String(b.name || '').trim();
      if (!name) return reply.code(400).send({ ok: false, error: 'Nomi majburiy' });
      const price = Number(b.price); const duration = Number(b.duration_minutes);
      if (!Number.isFinite(price) || price < 0) return reply.code(400).send({ ok: false, error: 'Narx noto‘g‘ri' });
      if (!Number.isInteger(duration) || duration <= 0) return reply.code(400).send({ ok: false, error: 'Davomiylik noto‘g‘ri' });

      const rows = await supabaseRest<any[]>('courses', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ name, description: String(b.description || '').trim() || null, duration_minutes: duration, price, is_active: b.is_active !== false }),
      });
      await audit(admin.id, 'COURSE_CREATED', 'courses', rows[0]?.id ?? null, null, rows[0]);
      return reply.code(201).send({ ok: true, course: rows[0] });
    } catch (e) { return err(reply, e, 'Course creation failed', 400); }
  });
  app.patch('/api/admin/courses/:id', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id), b = req.body || {};
      const old = (await safe<any>('courses', `?id=eq.${q(id)}&select=*&limit=1`))[0];
      if (!old) return reply.code(404).send({ ok: false, error: 'Mashg‘ulot topilmadi' });

      const patch: any = {};
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.description !== undefined) patch.description = String(b.description || '').trim() || null;
      if (b.duration_minutes !== undefined) patch.duration_minutes = Number(b.duration_minutes);
      if (b.price !== undefined) patch.price = Number(b.price);
      if (b.is_active !== undefined) patch.is_active = Boolean(b.is_active);

      const rows = await supabaseRest<any[]>('courses', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`, body: JSON.stringify(patch) });
      await audit(admin.id, 'COURSE_UPDATED', 'courses', id, old, rows[0]);
      return { ok: true, course: rows[0] };
    } catch (e) { return err(reply, e, 'Course update failed', 400); }
  });

  app.get('/api/admin/payments', async (req: any, reply: any) => {
    try {
      await guard(req);
      const [payments, users, bookings] = await Promise.all([
        safe<any>('payments', '?select=*&order=created_at.desc'),
        safe<any>('users', '?select=id,full_name,phone'),
        safe<any>('bookings', '?select=id,booking_date,course_id'),
      ]);
      const um = new Map(users.map((u: any) => [String(u.id), u]));
      const bm = new Map(bookings.map((b: any) => [String(b.id), b]));
      return { ok: true, payments: payments.map((p: any) => ({ ...p, customer: um.get(String(p.customer_id)) || null, booking: bm.get(String(p.booking_id)) || null })) };
    } catch (e) { return err(reply, e, 'Failed to load payments'); }
  });
  app.patch('/api/admin/payments/:id', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const status = String(req.body?.status || '');
      if (!['pending', 'paid', 'failed', 'refunded', 'cancelled'].includes(status)) {
        return reply.code(400).send({ ok: false, error: 'To‘lov holati noto‘g‘ri' });
      }
      const id = String(req.params.id);
      const old = (await safe<any>('payments', `?id=eq.${q(id)}&select=*&limit=1`))[0];
      if (!old) return reply.code(404).send({ ok: false, error: 'To‘lov topilmadi' });

      const patch: any = { status };
      if (status === 'paid') patch.paid_at = new Date().toISOString();
      const rows = await supabaseRest<any[]>('payments', { method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`, body: JSON.stringify(patch) });
      await audit(admin.id, 'PAYMENT_UPDATED', 'payments', id, { status: old.status }, { status });
      return { ok: true, payment: rows[0] };
    } catch (e) { return err(reply, e, 'Payment update failed', 400); }
  });

  app.get('/api/admin/audit-logs', async (req: any, reply: any) => {
    try {
      await guard(req);
      const limit = Math.min(500, Number(req.query?.limit) || 200);
      const [logs, users] = await Promise.all([
        safe<any>('admin_audit_logs', `?select=*&order=created_at.desc&limit=${limit}`),
        safe<any>('users', '?select=id,full_name'),
      ]);
      const um = new Map(users.map((u: any) => [String(u.id), u]));
      return { ok: true, logs: logs.map((l: any) => ({ ...l, admin: um.get(String(l.admin_id)) || null })) };
    } catch (e) { return err(reply, e, 'Failed to load audit logs'); }
  });
}
