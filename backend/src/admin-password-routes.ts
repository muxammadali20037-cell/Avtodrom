import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { supabaseRest, supabaseRestPaged } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import { loadBookingDetails, bookingMessage, inAppMessage, type BookingEvent } from './notify.js';
import {
  authenticateStaff, assertRole, hashPassword,
  type StaffIdentity, type StaffRole,
} from './staff-auth.js';

const COOKIE = 'avtodrom_admin_session', TTL = 60 * 60 * 12;
const q = (v: string) => encodeURIComponent(v);

function cookie(req: any) {
  const raw = String(req.headers?.cookie || '');
  const x = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(COOKIE + '='));
  if (!x) return '';
  try { return decodeURIComponent(x.slice(COOKIE.length + 1)); } catch { return ''; }
}
function secret() { return String(process.env.ADMIN_SESSION_SECRET || process.env.ADMIN_PASSWORD || '').trim(); }

/* Sessiya tokeni endi ROLNI ham olib yuradi.
   Format (imzolangan): login|staffId|role|registerId|timestamp

   Ilgari faqat login bor edi va har kim admin hisoblanardi.
   Eski tokenlar endi yaroqsiz — bir marta qayta kirish kerak,
   bu ataylab: eski token rolsiz bo'lgani uchun ishonib bo'lmaydi. */
const SEP = '|';

function token(identity: StaffIdentity) {
  const s = secret();
  if (!s) throw Error('ADMIN_SESSION_SECRET yoki ADMIN_PASSWORD sozlanmagan');
  const parts = [
    identity.login,
    identity.id ?? '-',
    identity.role,
    identity.register_id ?? '-',
    String(Date.now()),
  ];
  const payload = parts.join(SEP);
  const sig = createHmac('sha256', s).update(payload).digest('hex');
  return Buffer.from(`${payload}${SEP}${sig}`).toString('base64url');
}

/** Tokenni ochadi va kimligini qaytaradi. Yaroqsiz bo'lsa null. */
function readToken(t: string): StaffIdentity | null {
  try {
    const s = secret();
    if (!s || !t) return null;
    const d = Buffer.from(t, 'base64url').toString('utf8');
    const parts = d.split(SEP);
    if (parts.length !== 6) return null;

    const [login, staffId, role, registerId, tsRaw, sig] = parts;
    const payload = parts.slice(0, 5).join(SEP);
    const expected = createHmac('sha256', s).update(payload).digest('hex');
    const x = Buffer.from(sig), y = Buffer.from(expected);
    if (x.length !== y.length || !timingSafeEqual(x, y)) return null;

    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || Date.now() - ts < 0 || Date.now() - ts > TTL * 1000) return null;
    if (role !== 'admin' && role !== 'cashier') return null;

    return {
      id: staffId === '-' ? null : staffId,
      login,
      role: role as StaffRole,
      register_id: registerId === '-' ? null : registerId,
      full_name: null,
      legacy: staffId === '-',
    };
  } catch { return null; }
}

/** Kirganmi — kimligini qaytaradi. Kirmagan bo'lsa 401. */
export async function currentStaff(req: any): Promise<StaffIdentity> {
  const id = readToken(cookie(req));
  if (!id) { const e: any = new Error('Admin login talab qilinadi'); e.statusCode = 401; throw e; }
  return id;
}

/** Eski nom — mavjud chaqiruvlar buzilmasin. */
export async function guard(req: any) {
  await currentStaff(req);
}

/** Faqat administrator uchun. Kassir 403 oladi. */
export async function guardAdmin(req: any) {
  assertRole(await currentStaff(req), 'admin');
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
/* PostgREST bir so'rovda ko'pi bilan 1000 qator qaytaradi va bu haqda
   XATO BERMAYDI — shunchaki kam ma'lumot keladi. Pagination qo'shilgunicha
   hech bo'lmasa buni SEZAMIZ: aynan 1000 qator kelsa, demak kesilgan
   bo'lishi mumkin va admin ogohlantiriladi.

   Busiz hisobotlar jimgina noto'g'ri chiqa boshlardi. */
const PGRST_MAX_ROWS = 1000;


/* Sahifalash parametrlari so'rovdan olinadi.
   Standart 50 — admin ekraniga sig'adigan miqdor. */
function pageParams(req: any) {
  const page = Math.max(1, Math.trunc(Number(req.query?.page)) || 1);
  const perPage = Math.max(1, Math.min(200, Math.trunc(Number(req.query?.per_page)) || 50));
  return { page, perPage };
}

/** Sahifalangan ro'yxat — xato bo'lsa bo'sh qaytaradi, yiqilmaydi. */
async function safePaged<T = any>(table: string, query: string, page: number, perPage: number) {
  try {
    return { ...(await supabaseRestPaged<T>(table, query, page, perPage)), warning: null as string | null };
  } catch (e) {
    console.error('Admin paged read failed', table, e);
    return {
      rows: [] as T[], total: 0, page, per_page: perPage, has_more: false,
      warning: `"${table}" o‘qilmadi: ${e instanceof Error ? e.message : 'noma’lum xato'}`,
    };
  }
}

async function safeR<T = any>(table: string, query: string): Promise<{ rows: T[]; warning: string | null }> {
  try {
    const rows = await supabaseRest<T[]>(table, { query });
    const truncated = Array.isArray(rows) && rows.length >= PGRST_MAX_ROWS && !/limit=/.test(query);
    return {
      rows,
      warning: truncated
        ? `"${table}": ${rows.length} qator keldi — ro‘yxat KESILGAN bo‘lishi mumkin. ` +
          'Hisobotlar to‘liq emas. Sahifalash qo‘shilishi kerak.'
        : null,
    };
  } catch (e) {
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
  /* Login uchun ALOHIDA cheklov. Global limit 120/min — bu parol
     tanlash uchun juda ko'p. 15 daqiqada 5 urinish yetarli.

     Sozlanadigan: testlarda va ko'p xodimli muhitda chegara boshqacha
     bo'lishi kerak. LOGIN_RATE_MAX orqali o'zgartiriladi. */
  const loginMax = Math.max(1, Number(process.env.LOGIN_RATE_MAX) || 5);
  app.post('/api/admin/login', {
    config: { rateLimit: { max: loginMax, timeWindow: '15 minutes' } },
  }, async (req: any, reply: any) => {
    try {
      const login = String(req.body?.login || '').trim(), password = String(req.body?.password || '');
      if (!login || !password) return reply.code(400).send({ ok: false, error: 'Login va parolni kiriting' });

      /* Avval xodim jadvalidan, topilmasa eski ADMIN_LOGIN dan.
         Ikkinchisi ataylab qoldirilgan — xodimlarni qo'shishdan oldin
         paneldan qulflanib qolmaslik uchun. */
      const identity = await authenticateStaff(login, password);
      if (!identity) return reply.code(401).send({ ok: false, error: 'Login yoki parol noto‘g‘ri' });

      setCookie(reply, token(identity));
      try {
        const admin = await adminUser();
        await audit(admin.id, 'LOGIN', 'staff', identity.id ?? 'env', null,
          { login: identity.login, role: identity.role, legacy: identity.legacy });
      } catch { /* audit ixtiyoriy */ }

      /* Kassir bo'lsa — kassa tokenини DARHOL beramiz. Shunda kirгач
         PIN so'ralmaydi, to'g'ridan o'z kassasiga tushadi.
         Kassa ma'lumoti ham qo'shiladi (kod, nom). */
      let register = null, register_token = null;
      if (identity.role === 'cashier' && identity.register_id) {
        const { makeRegisterToken } = await import('./shift-routes.js');
        register_token = makeRegisterToken(identity.register_id);
        register = (await supabaseRest<any[]>('cash_registers', {
          query: `?id=eq.${q(String(identity.register_id))}&select=id,code,name&limit=1`,
        }).catch(() => []))[0] || null;
      }

      return {
        ok: true,
        login: identity.login,
        role: identity.role,
        register_id: identity.register_id,
        full_name: identity.full_name,
        legacy: identity.legacy,
        register,
        register_token,
      };
    } catch (e) { return err(reply, e, 'Admin login failed'); }
  });


  /* =====================================================================
     XODIMLAR — faqat administrator boshqaradi
     ===================================================================== */

  app.get('/api/admin/staff', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const rows = await supabaseRest<any[]>('staff', {
        query: '?select=id,login,full_name,role,register_id,is_active,last_login_at,created_at&order=role.asc,login.asc',
      }).catch(() => []);
      const regs = await supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name' }).catch(() => []);
      const rm = new Map(regs.map((r: any) => [String(r.id), r]));
      return {
        ok: true,
        staff: rows.map((x: any) => ({ ...x, register: x.register_id ? rm.get(String(x.register_id)) ?? null : null })),
        registers: regs,
        // Eski env admin hali ishlayotganini bildiramiz
        legacy_admin: String(process.env.ADMIN_LOGIN || '').trim() || null,
      };
    } catch (e) { return err(reply, e, 'Xodimlar yuklanmadi'); }
  });

  app.post('/api/admin/staff', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const b = req.body || {};
      const login = String(b.login || '').trim();
      const password = String(b.password || '');
      const role = String(b.role || '').trim();
      const registerId = b.register_id ? String(b.register_id) : null;

      if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(login)) {
        return reply.code(400).send({ ok: false, error: 'Login 3–32 belgi: harf, raqam, _ . - ' });
      }
      if (password.length < 8) {
        return reply.code(400).send({ ok: false, error: 'Parol kamida 8 belgi bo‘lsin' });
      }
      if (role !== 'admin' && role !== 'cashier') {
        return reply.code(400).send({ ok: false, error: 'Rol: admin yoki cashier' });
      }
      if (role === 'cashier' && !registerId) {
        return reply.code(400).send({ ok: false, error: 'Kassirga kassa biriktirilishi shart' });
      }

      try {
        const rows = await supabaseRest<any[]>('staff', {
          method: 'POST', headers: { Prefer: 'return=representation' },
          body: JSON.stringify({
            login, password_hash: hashPassword(password), role,
            register_id: role === 'cashier' ? registerId : null,
            full_name: String(b.full_name || '').trim() || null,
            // Aniq yozamiz — baza standartiga tayanmaymiz
            is_active: true,
          }),
        });
        /* Audit YOZUVI IXTIYORIY: u yiqilsa ham xodim yaratilgan bo'ladi.
           Ilgari adminUser() yuqorida chaqirilardi va u yiqilsa
           validatsiya xatolari ham 500 bo'lib ko'rinardi. */
        try {
          const admin = await adminUser();
          await audit(admin.id, 'STAFF_CREATED', 'staff', rows[0]?.id ?? null, null, { login, role });
        } catch (auditErr) { console.warn('STAFF_CREATED audit yozilmadi:', auditErr); }
        const { password_hash, ...safe } = rows[0] ?? {};
        return reply.code(201).send({ ok: true, staff: safe });
      } catch (e: any) {
        if (/staff_login_key/i.test(String(e?.message))) {
          return reply.code(409).send({ ok: false, error: 'Bu login band' });
        }
        throw e;
      }
    } catch (e) { return err(reply, e, 'Xodim qo‘shilmadi'); }
  });

  app.patch('/api/admin/staff/:id', async (req: any, reply: any) => {
    try {
      const me = await currentStaff(req);
      assertRole(me, 'admin');
      const id = String(req.params.id);
      const b = req.body || {};

      const cur = (await supabaseRest<any[]>('staff', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!cur) return reply.code(404).send({ ok: false, error: 'Xodim topilmadi' });

      const patch: Record<string, unknown> = {};
      if (b.full_name !== undefined) patch.full_name = String(b.full_name).trim() || null;
      if (b.role !== undefined) {
        const role = String(b.role);
        if (role !== 'admin' && role !== 'cashier') return reply.code(400).send({ ok: false, error: 'Noto‘g‘ri rol' });
        patch.role = role;
        if (role === 'admin') patch.register_id = null;
      }
      if (b.register_id !== undefined) patch.register_id = b.register_id ? String(b.register_id) : null;
      if (b.password !== undefined) {
        const p = String(b.password);
        if (p.length < 8) return reply.code(400).send({ ok: false, error: 'Parol kamida 8 belgi' });
        patch.password_hash = hashPassword(p);
      }
      if (typeof b.is_active === 'boolean') {
        /* O'zini o'chirib qo'yishdan himoya — aks holda admin
           paneldan chiqib ketib, qayta kira olmay qoladi. */
        if (!b.is_active && me.id && String(me.id) === id) {
          return reply.code(409).send({ ok: false, error: 'O‘z hisobingizni o‘chira olmaysiz' });
        }
        patch.is_active = b.is_active;
      }

      const finalRole = (patch.role ?? cur.role) as string;
      const finalReg = patch.register_id !== undefined ? patch.register_id : cur.register_id;
      if (finalRole === 'cashier' && !finalReg) {
        return reply.code(400).send({ ok: false, error: 'Kassirga kassa biriktirilishi shart' });
      }

      /* Oxirgi faol adminni yo'qotmaslik: rolni o'zgartirish yoki
         o'chirish natijasida admin qolmasa — rad etamiz. */
      const losingAdmin = (cur.role === 'admin')
        && ((patch.role && patch.role !== 'admin') || patch.is_active === false);
      if (losingAdmin) {
        const admins = await supabaseRest<any[]>('staff', {
          query: `?role=eq.admin&is_active=eq.true&select=id`,
        }).catch(() => []);
        if (admins.length <= 1) {
          return reply.code(409).send({ ok: false, error: 'Oxirgi administratorni o‘chirib bo‘lmaydi' });
        }
      }

      if (!Object.keys(patch).length) return { ok: true, unchanged: true };
      patch.updated_at = new Date().toISOString();
      await supabaseRest('staff', { method: 'PATCH', query: `?id=eq.${q(id)}`, body: JSON.stringify(patch) });
      try {
        const admin = await adminUser();
        await audit(admin.id, 'STAFF_UPDATED', 'staff', id, { role: cur.role, is_active: cur.is_active },
          { ...patch, password_hash: patch.password_hash ? '***' : undefined });
      } catch (auditErr) { console.warn('STAFF_UPDATED audit yozilmadi:', auditErr); }
      return { ok: true };
    } catch (e) { return err(reply, e, 'Xodim saqlanmadi'); }
  });

  app.delete('/api/admin/staff/:id', async (req: any, reply: any) => {
    try {
      const me = await currentStaff(req);
      assertRole(me, 'admin');
      const id = String(req.params.id);
      if (me.id && String(me.id) === id) {
        return reply.code(409).send({ ok: false, error: 'O‘z hisobingizni o‘chira olmaysiz' });
      }
      const cur = (await supabaseRest<any[]>('staff', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!cur) return reply.code(404).send({ ok: false, error: 'Xodim topilmadi' });

      if (cur.role === 'admin') {
        const admins = await supabaseRest<any[]>('staff', {
          query: `?role=eq.admin&is_active=eq.true&select=id`,
        }).catch(() => []);
        if (admins.length <= 1) {
          return reply.code(409).send({ ok: false, error: 'Oxirgi administratorni o‘chirib bo‘lmaydi' });
        }
      }
      await supabaseRest('staff', { method: 'DELETE', query: `?id=eq.${q(id)}` });
      try {
        const admin = await adminUser();
        await audit(admin.id, 'STAFF_DELETED', 'staff', id, { login: cur.login, role: cur.role }, null);
      } catch (auditErr) { console.warn('STAFF_DELETED audit yozilmadi:', auditErr); }
      return { ok: true };
    } catch (e) { return err(reply, e, 'Xodim o‘chirilmadi'); }
  });


  /* =====================================================================
     LOKATSIYA — avtodrom manzili va koordinatalari
     Ilgari `api/admin/settings/location/` da alohida auth bilan edi;
     u eski token formatini ishlatardi va rol modelidan keyin
     butunlay ishlamay qolardi.
     ===================================================================== */

  app.get('/api/admin/settings/location', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const rows = await supabaseRest<any[]>('admin_settings', {
        query: '?key=eq.location&select=key,value,updated_at&limit=1',
      });
      return { ok: true, setting: rows[0] || null };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Lokatsiya o‘qilmadi' });
    }
  });

  const saveLocation = async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const body = (req.body || {}) as any;
      const raw = body.value !== undefined ? body.value : body;
      const v = raw && typeof raw === 'object' ? raw : {};

      const name = String(v.name || '').trim();
      const address = String(v.address || '').trim();
      const latitude = Number(v.latitude ?? v.lat);
      const longitude = Number(v.longitude ?? v.lng);

      if (!name) return reply.code(400).send({ ok: false, error: 'Lokatsiya nomi majburiy' });
      if (!address) return reply.code(400).send({ ok: false, error: 'Manzilni kiriting' });
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        return reply.code(400).send({ ok: false, error: 'Latitude noto‘g‘ri (-90 dan 90 gacha)' });
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        return reply.code(400).send({ ok: false, error: 'Longitude noto‘g‘ri (-180 dan 180 gacha)' });
      }

      const value = {
        name, address, latitude, longitude,
        google_url: String(v.google_url || v.google || '').trim(),
        yandex_url: String(v.yandex_url || v.yandex || '').trim(),
        two_gis_url: String(v.two_gis_url || v['2gis'] || '').trim(),
      };

      const old = await supabaseRest<any[]>('admin_settings', { query: '?key=eq.location&select=*&limit=1' });
      const updated_at = new Date().toISOString();
      const rows = old[0]
        ? await supabaseRest<any[]>('admin_settings', {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            query: '?key=eq.location', body: JSON.stringify({ value, updated_at }),
          })
        : await supabaseRest<any[]>('admin_settings', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ key: 'location', value, updated_at }),
          });

      try {
        const admin = await adminUser();
        await audit(admin.id, 'SETTINGS_UPDATED', 'admin_settings', 'location', old[0]?.value ?? null, value);
      } catch { /* audit ixtiyoriy */ }

      return { ok: true, setting: rows[0] ?? null };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Lokatsiya saqlanmadi' });
    }
  };
  app.put('/api/admin/settings/location', saveLocation);
  app.patch('/api/admin/settings/location', saveLocation);


  /* =====================================================================
     TO'LOVNI BEKOR QILISH (refund)
     Xato chek chiqarilsa yoki mijoz pulini qaytarsa. To'lov yozuvi
     O'CHIRILMAYDI — holati o'zgaradi. Aks holda kassa hisoboti
     buzilardi va nima bo'lganini bilib bo'lmasdi.
     ===================================================================== */
  app.post('/api/admin/payments/:id/refund', async (req: any, reply: any) => {
    try {
      const me = await currentStaff(req);
      const id = String(req.params.id);
      const reason = String((req.body as any)?.reason || '').trim();

      if (reason.length < 3) {
        return reply.code(400).send({ ok: false, error: 'Bekor qilish sababini yozing' });
      }

      const pay = (await supabaseRest<any[]>('payments', {
        query: `?id=eq.${q(id)}&select=*&limit=1`,
      }))[0];
      if (!pay) return reply.code(404).send({ ok: false, error: 'To‘lov topilmadi' });

      if (String(pay.status) === 'refunded') {
        return reply.code(409).send({ ok: false, error: 'Bu to‘lov allaqachon bekor qilingan' });
      }
      if (String(pay.status) !== 'paid') {
        return reply.code(409).send({ ok: false, error: `To‘lov holati "${pay.status}" — bekor qilib bo‘lmaydi` });
      }

      /* Kassir FAQAT o'z kassasining va FAQAT bugungi to'lovini
         bekor qila oladi. Eskisini bekor qilish — admin ishi,
         chunki smena yopilgan bo'lishi mumkin. */
      if (me.role !== 'admin') {
        if (!pay.register_id || String(pay.register_id) !== String(me.register_id)) {
          return reply.code(403).send({ ok: false, error: 'Bu to‘lov sizning kassangizga tegishli emas' });
        }
        const paidAt = new Date(pay.paid_at || pay.created_at || 0).getTime();
        if (Date.now() - paidAt > 12 * 3600e3) {
          return reply.code(403).send({
            ok: false,
            error: 'Eski to‘lovni faqat administrator bekor qila oladi',
          });
        }
      }

      const now = new Date().toISOString();
      const rows = await supabaseRest<any[]>('payments', {
        method: 'PATCH', headers: { Prefer: 'return=representation' },
        query: `?id=eq.${q(id)}&status=eq.paid`,
        body: JSON.stringify({
          status: 'refunded',
          refunded_at: now,
          refund_reason: reason,
          refunded_by: me.login,
          updated_at: now,
        }),
      });
      if (!rows.length) {
        // status=eq.paid sharti tushmadi — kimdir bir vaqtda bekor qilgan
        return reply.code(409).send({ ok: false, error: 'To‘lov holati o‘zgargan, sahifani yangilang' });
      }

      /* Bron ham qaytariladi: to'lovi bekor qilingan dars
         "to'langan" bo'lib qolmasin. */
      if (pay.booking_id) {
        await supabaseRest('bookings', {
          method: 'PATCH', query: `?id=eq.${q(String(pay.booking_id))}&status=in.(confirmed,in_progress)`,
          body: JSON.stringify({ status: 'cancelled', updated_at: now }),
        }).catch(() => {});
      }

      try {
        const admin = await adminUser();
        await audit(admin.id, 'PAYMENT_REFUNDED', 'payments', id,
          { status: pay.status, amount: pay.amount },
          { status: 'refunded', reason, by: me.login });
      } catch { /* audit ixtiyoriy */ }

      return { ok: true, payment: rows[0] };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Bekor qilinmadi' });
    }
  });

  app.post('/api/admin/logout', async (_req: any, reply: any) => { clearCookie(reply); return { ok: true }; });

  app.get('/api/admin/me', async (req: any, reply: any) => {
    try {
      const me = await currentStaff(req);
      let register = null, register_token = null;
      if (me.role === 'cashier' && me.register_id) {
        const { makeRegisterToken } = await import('./shift-routes.js');
        register_token = makeRegisterToken(String(me.register_id));
        register = (await supabaseRest<any[]>('cash_registers', {
          query: `?id=eq.${q(String(me.register_id))}&select=id,code,name&limit=1`,
        }).catch(() => []))[0] || null;
      }
      return {
        ok: true, login: me.login, role: me.role,
        register_id: me.register_id, full_name: me.full_name, legacy: me.legacy,
        register, register_token,
      };
    }
    catch (e) { return err(reply, e, 'Unauthorized', 401); }
  });

  app.get('/api/admin/stats', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
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
      await guardAdmin(req);
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


  /**
   * INSTRUKTORNI O'CHIRISH
   *
   * Bronlari bo'lsa o'chirilmaydi — tarix buzilib ketardi va
   * hisobotlarda bo'sh joylar paydo bo'lardi. Bunday holda
   * bloklash taklif qilinadi.
   */
  app.delete('/api/admin/instructors/:id', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);

      const ip = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(id)}&select=*&limit=1`,
      }))[0];
      if (!ip) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });

      const bookings = await supabaseRest<any[]>('bookings', {
        query: `?instructor_id=eq.${q(id)}&select=id&limit=1000`,
      });

      /* Bronlari bo'lsa ikki yo'l bor:
         · odatiy o'chirish — rad etiladi, admin bloklashni tanlaydi
         · force=1 — bronlar SAQLANADI, faqat instruktor o'chiriladi.
           Ismi bronga nusxalanadi, shuning uchun to'lov tarixi va
           hisobotlar buzilmaydi: "kim o'tkazgan" ko'rinib turadi. */
      const force = String((req.query as any)?.force || '') === '1';

      if (bookings.length && !force) {
        return reply.code(409).send({
          ok: false,
          error: `Bu instruktorda ${bookings.length} ta bron bor.`,
          bookings: bookings.length,
          can_force: true,
        });
      }

      if (bookings.length) {
        // 1) Ismni bronlarga yozib qo'yamiz — tarix o'qilishi kerak
        const uname = (await supabaseRest<any[]>('users', {
          query: `?id=eq.${q(String(ip.user_id))}&select=full_name&limit=1`,
        }).catch(() => []))[0]?.full_name || 'O‘chirilgan instruktor';

        await supabaseRest('bookings', {
          method: 'PATCH', query: `?instructor_id=eq.${q(id)}`,
          body: JSON.stringify({ instructor_name: uname, updated_at: new Date().toISOString() }),
        });
        // 2) Bog'lanishni uzamiz — bron qoladi, instruktor o'chadi
        await supabaseRest('bookings', {
          method: 'PATCH', query: `?instructor_id=eq.${q(id)}`,
          body: JSON.stringify({ instructor_id: null }),
        });
      }

      await supabaseRest('instructor_profiles', { method: 'DELETE', query: `?id=eq.${q(id)}` });
      await supabaseRest('users', {
        method: 'PATCH', query: `?id=eq.${q(String(ip.user_id))}`,
        body: JSON.stringify({ is_active: false, is_blocked: true, updated_at: new Date().toISOString() }),
      });
      await audit(admin.id, 'INSTRUCTOR_DELETED', 'instructor_profiles', id, ip,
        { forced: force, detached_bookings: bookings.length });
      return { ok: true, detached_bookings: bookings.length };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'O‘chirilmadi' });
    }
  });

  /**
   * INSTRUKTOR RASMI — data URL orqali yuklash.
   * Kichik rasmlar uchun qulay: alohida imzo olish shart emas.
   */
  app.post('/api/admin/instructors/:id/photo', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const dataUrl = String((req.body as any)?.photo_data_url || '');

      const m = dataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
      if (!m) return reply.code(400).send({ ok: false, error: 'Rasm formati noto‘g‘ri (JPG, PNG yoki WEBP)' });
      if (dataUrl.length > 7 * 1024 * 1024) return reply.code(413).send({ ok: false, error: 'Rasm juda katta' });

      const ip = (await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(id)}&select=id&limit=1`,
      }))[0];
      if (!ip) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });

      const contentType = m[1];
      const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
      const bytes = Buffer.from(m[2], 'base64');
      const path = `avatars/${id}-${Date.now()}.${ext}`;
      const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
      const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
      const BUCKET = 'customer-media';

      const up = await fetch(`${base}/storage/v1/object/${BUCKET}/${path}`, {
        method: 'POST',
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': contentType },
        body: bytes,
      });
      if (!up.ok) {
        const t = await up.text().catch(() => '');
        return reply.code(502).send({ ok: false, error: `Rasm yuklanmadi (${up.status}) ${t.slice(0, 120)}` });
      }

      const publicUrl = `${base}/storage/v1/object/public/${BUCKET}/${path}`;
      await supabaseRest('instructor_profiles', {
        method: 'PATCH', query: `?id=eq.${q(id)}`,
        body: JSON.stringify({ avatar_url: publicUrl, avatar_path: path, updated_at: new Date().toISOString() }),
      });
      await audit(admin.id, 'INSTRUCTOR_PHOTO_SET', 'instructor_profiles', id, null, { path });
      return { ok: true, avatar_url: publicUrl };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Rasm saqlanmadi' });
    }
  });

  app.post('/api/admin/instructors', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
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
      await guardAdmin(req);
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
        // Instruktorlar tavsifni batafsil yozadi (xizmatlar ro'yxati bilan),
        // shuning uchun chegara keng: 2000 belgi.
        if (bio.length > 2000) {
          return reply.code(400).send({ ok: false, error: `Bio juda uzun: ${bio.length} belgi. Eng ko'pi 2000.` });
        }
        insPatch.bio = bio || null;
      }
      if (typeof b.is_verified === 'boolean') insPatch.is_verified = b.is_verified;
      if (b.categories !== undefined) {
        const list = (Array.isArray(b.categories) ? b.categories : [])
          .map((c: any) => String(c).trim().toUpperCase())
          .filter((c: string) => ['A', 'B', 'C'].includes(c));
        const uniq = [...new Set(list)];
        if (!uniq.length) return reply.code(400).send({ ok: false, error: 'Kamida bitta kategoriya tanlang' });
        insPatch.categories = uniq;
      }
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

      /* Saqlangandan keyin yozuvni QAYTA O'QIYMIZ va qaytaramiz.
         Sabab: agar ustun bazada bo'lmasa yoki qiymat yozilmasa,
         so'rov "muvaffaqiyatli" tugab, panel eski holatni ko'rsatardi —
         foydalanuvchi nima bo'lganini bilmasdi. Endi haqiqiy holat
         qaytadi va panel farqni sezadi. */
      const [fresh] = await supabaseRest<any[]>('instructor_profiles', {
        query: `?id=eq.${q(id)}&select=*&limit=1`,
      });
      const [freshUser] = await supabaseRest<any[]>('users', {
        query: `?id=eq.${q(String(ip.user_id))}&select=id,full_name,phone&limit=1`,
      });

      // Nima so'ralgan-u nima saqlangan — mos kelmasa panel ogohlantiradi
      const notSaved: string[] = [];
      for (const key of Object.keys(insPatch)) {
        if (key === 'updated_at') continue;
        const want = (insPatch as any)[key];
        const got = fresh ? (fresh as any)[key] : undefined;
        if (got === undefined) { notSaved.push(key); continue; }
        if (JSON.stringify(want) !== JSON.stringify(got)) notSaved.push(key);
      }

      return {
        ok: true,
        instructor: fresh ? { ...fresh, profile: freshUser ?? null } : null,
        not_saved: notSaved,
      };
    } catch (e) { return err(reply, e, 'Instructor update failed', 400); }
  });

  app.get('/api/admin/bookings', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const st = String(req.query?.status || ''), filter = st ? `&status=eq.${q(st)}` : '';
      const { page, perPage } = pageParams(req);

      /* Bronlar SAHIFALANADI. Ilgari butun jadval so'ralardi va PostgREST
         1000 qatorda jimgina kesardi — hisobotlar noto'g'ri chiqardi. */
      const bookingsR = await safePaged<any>('bookings', `?select=*&order=booking_date.desc${filter}`, page, perPage);

      /* Yordamchi jadvallar faqat SHU SAHIFADAGI ID'lar bo'yicha olinadi.
         Ilgari har safar butun users/courses jadvali yuklanardi. */
      const bIds = bookingsR.rows;
      const cuIds = [...new Set(bIds.map((b: any) => b.customer_id).filter(Boolean).map(String))];
      const inIds = [...new Set(bIds.map((b: any) => b.instructor_id).filter(Boolean).map(String))];
      const coIds = [...new Set(bIds.map((b: any) => b.course_id).filter(Boolean).map(String))];
      const bkIds = bIds.map((b: any) => String(b.id));

      const ipsR = inIds.length
        ? await safeR<any>('instructor_profiles', `?id=in.(${inIds.map(q).join(',')})&select=id,user_id,rating,total_reviews`)
        : { rows: [] as any[], warning: null };
      const insUserIds = [...new Set(ipsR.rows.map((i: any) => i.user_id).filter(Boolean).map(String))];
      const allUserIds = [...new Set([...cuIds, ...insUserIds])];

      const [usersR, coursesR, paymentsR, remindersR] = await Promise.all([
        allUserIds.length
          ? safeR<any>('users', `?id=in.(${allUserIds.map(q).join(',')})&select=id,telegram_id,phone,full_name,role`)
          : Promise.resolve({ rows: [] as any[], warning: null }),
        coIds.length
          ? safeR<any>('courses', `?id=in.(${coIds.map(q).join(',')})&select=id,name,duration_minutes,price,is_active`)
          : Promise.resolve({ rows: [] as any[], warning: null }),
        bkIds.length
          ? safeR<any>('payments', `?booking_id=in.(${bkIds.map(q).join(',')})&select=booking_id,amount,status`)
          : Promise.resolve({ rows: [] as any[], warning: null }),
        /* Yuborilган eslatmalar — admin qaysi bronга xabar ketganini
           ko'rishi kerak (60/30/10 daqiqa oldin). */
        bkIds.length
          ? safeR<any>('booking_reminders', `?booking_id=in.(${bkIds.map(q).join(',')})&select=booking_id,kind`)
          : Promise.resolve({ rows: [] as any[], warning: null }),
      ]);
      // To'lov yozuvi bron tasdiqlangan paytdagi narxni saqlaydi.
      // Kurs narxi keyin o'zgarsa ham eski bron narxi o'zgarmasligi uchun
      // avval payments.amount, faqat u yo'q bo'lsa joriy kurs narxi olinadi.
      const pm = new Map(paymentsR.rows.map((p: any) => [String(p.booking_id), p]));
      // Bron -> yuborilган eslatma turlari (masalan ['60','30'])
      const rem = new Map<string, string[]>();
      for (const r of (remindersR?.rows || [])) {
        const k = String(r.booking_id);
        if (!rem.has(k)) rem.set(k, []);
        rem.get(k)!.push(String(r.kind));
      }
      const um = new Map(usersR.rows.map((u: any) => [String(u.id), u]));
      const im = new Map(ipsR.rows.map((i: any) => [String(i.id), i]));
      const cm = new Map(coursesR.rows.map((c: any) => [String(c.id), c]));
      const warnings = [bookingsR.warning, usersR.warning, ipsR.warning, coursesR.warning, paymentsR.warning].filter(Boolean);
      return {
        ok: true,
        warnings,
        total: bookingsR.total,
        page: bookingsR.page,
        per_page: bookingsR.per_page,
        has_more: bookingsR.has_more,
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
            // Yuborilган eslatmalar (60/30/10) — admin ko'radi
            reminders: rem.get(String(b.id)) || [],
          };
        }),
      };
    } catch (e) { return err(reply, e, 'Failed to load bookings'); }
  });

  app.patch('/api/admin/bookings/:id/status', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
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
      await guardAdmin(req);
      return { ok: true, customers: await safe<any>('users', '?role=eq.customer&select=id,telegram_id,full_name,phone,role,is_active,is_blocked,created_at&order=created_at.desc') };
    } catch (e) { return err(reply, e, 'Failed to load customers'); }
  });

  app.patch('/api/admin/customers/:id', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
    try { await guardAdmin(req); return { ok: true, applications: await supabaseRest<any[]>('instructor_applications', { query: '?select=*&order=created_at.desc' }) }; }
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id), b = req.body || {};
      const old = (await safe<any>('courses', `?id=eq.${q(id)}&select=*&limit=1`))[0];
      if (!old) return reply.code(404).send({ ok: false, error: 'Mashg‘ulot topilmadi' });

      const patch: any = {};
      if (b.name !== undefined) patch.name = String(b.name).trim();
      if (b.description !== undefined) patch.description = String(b.description || '').trim() || null;
      if (b.duration_minutes !== undefined) patch.duration_minutes = Number(b.duration_minutes);
      if (b.price !== undefined) patch.price = Number(b.price);
      if (b.category !== undefined) {
        const cat = String(b.category).trim().toUpperCase();
        if (!['A', 'B', 'C'].includes(cat)) return reply.code(400).send({ ok: false, error: 'Kategoriya A, B yoki C bo‘lsin' });
        patch.category = cat;
      }
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
      await guardAdmin(req);
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
