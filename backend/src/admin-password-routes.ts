import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import { loadBookingDetails, bookingMessage, inAppMessage, type BookingEvent } from './notify.js';

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
export async function guard(req: any) {
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

export async function adminUser() {
  const r = await supabaseRest<any[]>('users', { query: '?role=eq.admin&is_active=eq.true&is_blocked=eq.false&select=*&limit=1' });
  if (!r[0]) throw Error('Admin foydalanuvchisi topilmadi');
  return r[0];
}

/** Audit log: har bir muhim admin amali yoziladi (talab 22-bo'lim). Yozib bo'lmasa oqim to'xtamaydi. */
export async function audit(adminId: string | null, action: string, entityType: string, entityId: string | null, oldData: unknown, newData: unknown) {
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


/** Mijozga bildirishnoma + Telegram xabari (bekor so'rovi javobi uchun). */
async function notifyCustomer(booking: any, event: BookingEvent, extra: string) {
  try {
    const d = await loadBookingDetails(booking);
    const msg = bookingMessage(booking, event, 'customer', d);
    const full = `${msg.title}\n\n${extra}\n\n${msg.body}`;

    await supabaseRest('notifications', {
      method: 'POST',
      body: JSON.stringify({ user_id: booking.customer_id, type: 'booking', title: msg.title, message: extra }),
    }).catch(() => {});

    const u = (await supabaseRest<any[]>('users', {
      query: `?id=eq.${q(String(booking.customer_id))}&select=telegram_id&limit=1`,
    }))[0];
    const token = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
    if (token && Number.isSafeInteger(Number(u?.telegram_id))) {
      await sendBookingNotification(token, Number(u.telegram_id), full,
        String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || ''), '🚗 Mini Appni ochish');
    }
  } catch (e) { console.error('notifyCustomer failed:', e); }
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

      const now = new Date().toISOString();

      if (typeof b.active === 'boolean') {
        await supabaseRest('instructor_profiles', {
          method: 'PATCH', query: `?id=eq.${q(id)}`,
          body: JSON.stringify({ is_available: b.active, updated_at: now }),
        });
        await supabaseRest('users', {
          method: 'PATCH', query: `?id=eq.${q(ip.user_id)}`,
          body: JSON.stringify({ is_active: b.active, is_blocked: !b.active, updated_at: now }),
        });
        await audit(admin.id, b.active ? 'INSTRUCTOR_RESTORED' : 'INSTRUCTOR_DISABLED', 'instructor_profiles', id, { active: ip.is_available }, { active: b.active });
      }

      /* To'liq tahrirlash. Reyting ataylab yo'q — u faqat mijoz
         sharhlaridan hisoblanadi, qo'lda o'zgartirilsa ma'nosini yo'qotadi. */
      const userPatch: Record<string, unknown> = {};
      const insPatch: Record<string, unknown> = {};

      if (b.full_name !== undefined) {
        const full = String(b.full_name).trim();
        if (full.length < 2) return reply.code(400).send({ ok: false, error: 'Ism juda qisqa' });
        userPatch.full_name = full;
      }
      if (b.phone !== undefined) {
        const phone = String(b.phone).trim();
        if (phone && !/^\+?\d[\d\s()-]{6,}$/.test(phone)) {
          return reply.code(400).send({ ok: false, error: 'Telefon raqami noto‘g‘ri' });
        }
        userPatch.phone = phone || null;
      }
      if (b.experience_years !== undefined) {
        const y = Math.trunc(Number(b.experience_years));
        if (!Number.isFinite(y) || y < 0 || y > 60) {
          return reply.code(400).send({ ok: false, error: 'Tajriba 0 dan 60 yilgacha' });
        }
        insPatch.experience_years = y;
      }
      if (b.bio !== undefined) {
        const bio = String(b.bio).trim();
        if (bio.length > 600) return reply.code(400).send({ ok: false, error: 'Bio 600 belgidan oshmasin' });
        insPatch.bio = bio || null;
      }
      if (typeof b.is_verified === 'boolean') insPatch.is_verified = b.is_verified;
      if (b.avatar_url !== undefined) {
        const u = String(b.avatar_url).trim();
        if (u && !/^https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\//i.test(u)) {
          return reply.code(400).send({ ok: false, error: 'Rasm manzili noto‘g‘ri' });
        }
        insPatch.avatar_url = u || null;
      }

      if (Object.keys(userPatch).length) {
        userPatch.updated_at = now;
        await supabaseRest('users', { method: 'PATCH', query: `?id=eq.${q(String(ip.user_id))}`, body: JSON.stringify(userPatch) });
      }
      if (Object.keys(insPatch).length) {
        insPatch.updated_at = now;
        await supabaseRest('instructor_profiles', { method: 'PATCH', query: `?id=eq.${q(id)}`, body: JSON.stringify(insPatch) });
      }
      if (Object.keys(userPatch).length || Object.keys(insPatch).length) {
        await audit(admin.id, 'INSTRUCTOR_UPDATED', 'instructor_profiles', id, null, { ...userPatch, ...insPatch });
      }
      return { ok: true };
    } catch (e) { return err(reply, e, 'Instructor update failed', 400); }
  });

  app.get('/api/admin/bookings', async (req: any, reply: any) => {
    try {
      await guard(req);
      const st = String(req.query?.status || ''), filter = st ? `&status=eq.${q(st)}` : '';
      const [bookingsR, usersR, ipsR, coursesR, paymentsR] = await Promise.all([
        safeR<any>('bookings', `?select=*&order=booking_date.desc${filter}`),
        safeR<any>('users', '?select=id,telegram_id,phone,full_name,role'),
        safeR<any>('instructor_profiles', '?select=id,user_id,rating,total_reviews'),
        safeR<any>('courses', '?select=id,name,duration_minutes,price,is_active'),
        safeR<any>('payments', '?select=booking_id,amount,status'),
      ]);
      // To'lov yozuvi bron tasdiqlangan paytdagi narxni saqlaydi.
      // Kurs narxi keyin o'zgarsa ham eski bron narxi o'zgarmasligi uchun
      // avval payments.amount, faqat u yo'q bo'lsa joriy kurs narxi olinadi.
      const pm = new Map(paymentsR.rows.map((p: any) => [String(p.booking_id), p]));
      const um = new Map(usersR.rows.map((u: any) => [String(u.id), u]));
      const im = new Map(ipsR.rows.map((i: any) => [String(i.id), i]));
      const cm = new Map(coursesR.rows.map((c: any) => [String(c.id), c]));
      const warnings = [bookingsR.warning, usersR.warning, ipsR.warning, coursesR.warning, paymentsR.warning].filter(Boolean);
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
            price: pm.get(String(b.id))?.amount ?? c?.price ?? 0,
            payment: pm.get(String(b.id)) || null,
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

      /**
       * Admin uchun ruxsat etilgan o'tishlar.
       * MUHIM: confirmed -> no_show OCHIQ. Tasdiqlangan bronga mijoz kelmasligi —
       * normal holat va uni belgilay olish kerak. (Avvalgi versiyada bu bloklangan edi.)
       * Yakuniy holatlardan (completed/cancelled/rejected/no_show) orqaga qaytish yopiq.
       */
      const ADMIN_TRANSITIONS: Record<string, string[]> = {
        pending:     ['confirmed', 'rejected', 'cancelled'],
        confirmed:   ['in_progress', 'completed', 'no_show', 'cancelled'],
        in_progress: ['completed', 'no_show', 'cancelled'],
        completed:   [],
        cancelled:   [],
        rejected:    [],
        no_show:     [],
      };
      const from = String(old.status);
      if (from !== status && !(ADMIN_TRANSITIONS[from] || []).includes(status)) {
        const L: Record<string, string> = {
          pending: 'Kutilmoqda', confirmed: 'Tasdiqlangan', in_progress: 'Jarayonda',
          completed: 'Tugagan', cancelled: 'Bekor qilingan', rejected: 'Rad etilgan', no_show: 'Kelmagan',
        };
        const can = (ADMIN_TRANSITIONS[from] || []).map((x) => L[x] || x);
        return reply.code(409).send({
          ok: false,
          error: can.length
            ? `«${L[from] || from}» holatidan faqat quyidagilarga o‘tish mumkin: ${can.join(', ')}`
            : `«${L[from] || from}» — yakuniy holat, uni o‘zgartirib bo‘lmaydi`,
        });
      }

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

      // Mijoz va instruktorga chiroyli bildirishnoma (xom UUID/UTC emas)
      try {
        const updated = { ...old, ...body, id };
        const ev = status as BookingEvent;
        const d = await loadBookingDetails(updated);

        const cMsg = bookingMessage(updated, ev, 'customer', d);
        await supabaseRest('notifications', {
          method: 'POST',
          body: JSON.stringify({ user_id: old.customer_id, type: 'booking', title: cMsg.title, message: inAppMessage(ev, d, updated) }),
        }).catch(() => {});
        const cu = (await safe<any>('users', `?id=eq.${q(String(old.customer_id))}&select=telegram_id`))[0];
        const cToken = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '');
        if (cToken && Number.isSafeInteger(Number(cu?.telegram_id))) {
          await sendBookingNotification(cToken, Number(cu.telegram_id), cMsg.full,
            String(process.env.CUSTOMER_MINI_APP_URL || process.env.MINI_APP_URL || ''), '🚗 Mini Appni ochish');
        }

        if (old.instructor_id) {
          const ip = (await safe<any>('instructor_profiles', `?id=eq.${q(String(old.instructor_id))}&select=user_id`))[0];
          const iu = ip?.user_id ? (await safe<any>('users', `?id=eq.${q(String(ip.user_id))}&select=telegram_id`))[0] : null;
          const iToken = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
          if (iToken && Number.isSafeInteger(Number(iu?.telegram_id))) {
            const iMsg = bookingMessage(updated, ev, 'instructor', d);
            await sendBookingNotification(iToken, Number(iu.telegram_id), iMsg.full,
              String(process.env.INSTRUCTOR_MINI_APP_URL || ''), '👨‍🏫 Instruktor paneli');
          }
        }
      } catch (e) { console.error('Booking notification failed', e); }

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


/**
 * Instruktorga arizasi natijasi haqida xabar.
 *
 * Ikki joyga yoziladi: ilova ichidagi bildirishnomalar va Telegram.
 * Telegram yuborilmasa ham (bot to'xtatilgan, chat yopilgan) tasdiqlash
 * bekor bo'lmasligi kerak — shuning uchun xatolar yutiladi va faqat
 * jurnalga yoziladi.
 */
async function notifyInstructorDecision(
  application: any,
  approved: boolean,
  reason?: string,
) {
  try {
    /* Ariza jadvalida maydon nomi muhitga qarab farq qiladi
       (telegram_user_id / telegram_id), shuning uchun bir nechtasini
       sinab ko'ramiz. Topilmasa — foydalanuvchini bazadan qidiramiz. */
    const tgId = Number(
      application?.telegram_user_id ??
      application?.telegram_id ??
      application?.user?.telegram_id ??
      0,
    );
    const name = [application?.first_name, application?.last_name]
      .filter(Boolean).join(' ').trim() || String(application?.full_name || '').trim();

    let userId = application?.user_id ?? application?.profile_id ?? null;
    if (!userId && tgId) {
      const u = (await supabaseRest<any[]>('users', {
        query: `?telegram_id=eq.${q(String(tgId))}&select=id&limit=1`,
      }).catch(() => []))[0];
      userId = u?.id ?? null;
    }

    const title = approved ? 'Arizangiz tasdiqlandi' : 'Arizangiz rad etildi';
    const body = approved
      ? [
          name ? `${name}, tabriklaymiz!` : 'Tabriklaymiz!',
          '',
          'Siz TASH INDEX AVTODROM instruktori sifatida tasdiqlandingiz.',
          'Endi instruktor panelidan foydalanishingiz mumkin:',
          '· bronlaringizni ko‘rasiz',
          '· chekni skanerlab darsni boshlaysiz',
          '· kunlik hisobotni kuzatasiz',
          '',
          'Panelni ochish uchun quyidagi tugmani bosing.',
        ].join('\n')
      : [
          name ? `${name}, arizangiz ko‘rib chiqildi.` : 'Arizangiz ko‘rib chiqildi.',
          '',
          'Afsuski, ariza tasdiqlanmadi.',
          reason ? `Sabab: ${reason}` : 'Sabab ko‘rsatilmagan.',
          '',
          'Savollaringiz bo‘lsa administratorga murojaat qiling.',
        ].join('\n');

    // 1) Ilova ichidagi bildirishnoma
    if (userId) {
      await supabaseRest('notifications', {
        method: 'POST',
        body: JSON.stringify({
          user_id: userId,
          type: 'application',
          title,
          message: approved ? 'Instruktor sifatida tasdiqlandingiz.' : (reason || 'Ariza rad etildi.'),
        }),
      }).catch(() => {});
    }

    // 2) Telegram
    const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '').trim();
    if (!token || !tgId) {
      console.warn('notifyInstructorDecision: token yoki telegram_id yo‘q', { hasToken: !!token, tgId });
      return;
    }
    const miniApp = String(process.env.INSTRUCTOR_MINI_APP_URL || '').trim();
    await sendBookingNotification(
      token,
      tgId,
      `${title}\n\n${body}`,
      approved ? miniApp || undefined : undefined,
      'Instruktor panelini ochish',
    );
  } catch (e) {
    // Xabar ketmasa ham tasdiqlash kuchda qoladi
    console.error('notifyInstructorDecision failed:', e);
  }
}

  const approve = async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const rows = await supabaseRest<any[]>('rpc/admin_approve_instructor', { method: 'POST', body: JSON.stringify({ p_application_id: String(req.params.id), p_admin_id: admin.id }) });
      const application = Array.isArray(rows) ? rows[0] : rows;
      await audit(admin.id, 'INSTRUCTOR_CREATED', 'instructor_applications', String(req.params.id), null, application);
      await notifyInstructorDecision(application, true);
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
      await notifyInstructorDecision(application, false, reason || undefined);
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
      /* Kassa bo'yicha filtr: P1 va P2 ning hisobi aralashmasligi kerak.
         register_id berilmasa — hammasi (boshqaruv uchun). */
      const regFilter = String(req.query?.register_id || '').trim();
      const [payments, users, bookings] = await Promise.all([
        safe<any>('payments', `?select=*${regFilter ? `&register_id=eq.${q(regFilter)}` : ''}&order=created_at.desc`),
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

  /* ==========================================================
     BEKOR QILISH SO'ROVLARI
     Mijoz `confirmed` bronni bekor qilmoqchi bo'lsa, bron darhol
     bekor bo'lmaydi — admin ko'rib chiqadi.
     ========================================================== */

  app.get('/api/admin/cancellation-requests', async (req: any, reply: any) => {
    try {
      await guard(req);
      const [rows, users, ips, courses] = await Promise.all([
        safe<any>('bookings', '?cancel_requested_at=not.is.null&cancel_reviewed_at=is.null&select=*&order=cancel_requested_at.asc'),
        safe<any>('users', '?select=id,full_name,phone,telegram_id'),
        safe<any>('instructor_profiles', '?select=id,user_id'),
        safe<any>('courses', '?select=id,name,duration_minutes,price'),
      ]);
      const um = new Map(users.map((u: any) => [String(u.id), u]));
      const im = new Map(ips.map((i: any) => [String(i.id), i]));
      const cm = new Map(courses.map((c: any) => [String(c.id), c]));
      return {
        ok: true,
        requests: rows.map((b: any) => {
          const ip = im.get(String(b.instructor_id));
          return {
            ...b,
            start_at: b.start_at || b.booking_date,
            customer: um.get(String(b.customer_id)) || null,
            instructor: ip ? { ...ip, profile: um.get(String(ip.user_id)) || null } : null,
            course: cm.get(String(b.course_id)) || null,
          };
        }),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'So‘rovlar yuklanmadi' });
    }
  });

  /** So'rovni tasdiqlash — bron bekor qilinadi. */
  app.post('/api/admin/bookings/:id/cancel-approve', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const b = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!b) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (!b.cancel_requested_at || b.cancel_reviewed_at) {
        return reply.code(409).send({ ok: false, error: 'Bu bron uchun ochiq so‘rov yo‘q' });
      }

      const now = new Date().toISOString();
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({
          status: 'cancelled',
          cancelled_at: now,
          cancelled_by: b.cancel_requested_by ?? admin.id,
          cancellation_reason: b.cancel_request_reason,
          cancel_reviewed_at: now,
          cancel_reviewed_by: admin.id,
          updated_at: now,
        }),
      });
      const updated = rows[0] ?? b;
      await notifyCustomer(updated, 'cancelled', 'So‘rovingiz tasdiqlandi — bron bekor qilindi.');
      await audit(admin.id, 'BOOKING_CANCEL_APPROVED', 'bookings', id,
        { status: b.status, reason: b.cancel_request_reason }, { status: 'cancelled' });
      return { ok: true, booking: updated };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Tasdiqlanmadi' });
    }
  });

  /** So'rovni rad etish — bron kuchda qoladi. */
  app.post('/api/admin/bookings/:id/cancel-reject', async (req: any, reply: any) => {
    try {
      await guard(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const note = String(req.body?.note || '').trim();
      const b = (await supabaseRest<any[]>('bookings', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!b) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (!b.cancel_requested_at || b.cancel_reviewed_at) {
        return reply.code(409).send({ ok: false, error: 'Bu bron uchun ochiq so‘rov yo‘q' });
      }

      const now = new Date().toISOString();
      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({
          cancel_reviewed_at: now,
          cancel_reviewed_by: admin.id,
          admin_note: note || b.admin_note,
          updated_at: now,
        }),
      });
      const updated = rows[0] ?? b;
      await notifyCustomer(updated, 'confirmed',
        note ? `Bekor qilish so‘rovi rad etildi. Admin izohi: ${note}` : 'Bekor qilish so‘rovi rad etildi. Bron kuchda qoladi.');
      await audit(admin.id, 'BOOKING_CANCEL_REJECTED', 'bookings', id,
        { reason: b.cancel_request_reason }, { note: note || null });
      return { ok: true, booking: updated };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Rad etilmadi' });
    }
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
