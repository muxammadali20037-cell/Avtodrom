import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { supabaseRest } from './supabase.js';

/**
 * SMENA (kassa navbati)
 *
 * Ikkala kassa bitta admin hisobidan kiradi, shuning uchun kim qancha
 * pul olganini faqat SMENA ajratadi. Kassir ishni boshlashda smenani
 * ochadi, har bir chek o'sha smenaga biriktiriladi, oxirida yopadi.
 *
 * Yopishda tizim naqdni hisoblab beradi va kassir sanagani bilan
 * solishtiradi — kamomad yoki ortiqcha darhol ko'rinadi.
 */

const q = (v: string) => encodeURIComponent(v);


/* ---------------------------------------------------------------
   KASSA PIN VA TOKEN

   PIN ochiq saqlanmaydi — HMAC-SHA256 bilan xeshlanadi.
   Ochilgach kassirga imzolangan token beriladi; chek chiqarishda
   kassa ID'si o'sha TOKENdan olinadi, mijoz yuborgan qiymatdan emas.
   Shunday qilib brauzerdan boshqa kassa nomidan chek chiqarib bo'lmaydi.
   --------------------------------------------------------------- */
const SECRET = () => String(process.env.ADMIN_SESSION_SECRET || '').trim();
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;   // 12 soat — bir ish kuni

function hmac(data: string) {
  return createHmac('sha256', SECRET() || 'avtodrom-fallback').update(data).digest('hex');
}
function pinHash(registerId: string, pin: string) {
  return hmac(`pin:${registerId}:${pin}`);
}
function safeEq(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function makeRegisterToken(registerId: string) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const body = `${registerId}.${exp}`;
  return `${body}.${hmac(`reg:${body}`)}`;
}
/** Tokendan kassa ID'sini oladi. Imzo yoki muddat noto'g'ri bo'lsa null. */
export function readRegisterToken(token: string): string | null {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [id, expStr, sig] = parts;
  if (!safeEq(sig, hmac(`reg:${id}.${expStr}`))) return null;
  if (!Number(expStr) || Number(expStr) < Date.now()) return null;
  return id;
}

export async function registerShiftRoutes(
  app: FastifyInstance,
  requireAdmin: (request: any) => Promise<void>,
  adminUser: () => Promise<any>,
  audit: (adminId: string | null, action: string, entity: string, id: string | null, oldD: unknown, newD: unknown) => Promise<void>,
) {
  /** Kassalar va ularning hozirgi holati. */
  app.get('/api/admin/registers', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      /* Faqat kafolatlangan ustunlarni so'raymiz. `pin_set_at` alohida
         tekshiriladi — agar migratsiya hali qo'llanmagan bo'lsa, butun
         ro'yxat 400 bilan yiqilib, panel umuman ochilmasdi. */
      const regs = await supabaseRest<any[]>('cash_registers', {
        query: '?is_active=eq.true&select=id,code,name,is_active&order=code.asc',
      });

      let pinMap = new Map<string, boolean>();
      let pinReady = true;
      try {
        const withPin = await supabaseRest<any[]>('cash_registers', { query: '?select=id,pin_set_at' });
        pinMap = new Map(withPin.map((r) => [String(r.id), !!r.pin_set_at]));
      } catch {
        pinReady = false;   // ustun yo'q — PIN hali sozlanmagan
      }
      const open = await supabaseRest<any[]>('cashier_shifts', {
        query: '?closed_at=is.null&select=*',
      });
      const byReg = new Map(open.map((s) => [String(s.register_id), s]));
      return {
        ok: true,
        pin_ready: pinReady,
        registers: regs.map((r) => ({
          ...r,
          has_pin: pinMap.get(String(r.id)) ?? false,
          open_shift: byReg.get(String(r.id)) || null,
        })),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kassalar yuklanmadi' });
    }
  });

  /** Smena ochish. */
  app.post('/api/admin/shifts/open', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const registerId = String(req.body?.register_id || '').trim();
      const cashierName = String(req.body?.cashier_name || '').trim();
      const openingCash = Math.max(0, Number(req.body?.opening_cash || 0));

      if (!registerId) return reply.code(400).send({ ok: false, error: 'Kassani tanlang' });
      if (cashierName.length < 2) return reply.code(400).send({ ok: false, error: 'Kassir ismini kiriting' });

      const rows = await supabaseRest<any[]>('cashier_shifts', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          register_id: registerId, cashier_name: cashierName,
          opening_cash: openingCash, opened_by: admin.id,
        }),
      });
      const shift = rows[0];
      await audit(admin.id, 'SHIFT_OPENED', 'cashier_shifts', shift?.id ?? null, null,
        { cashier: cashierName, opening_cash: openingCash });
      return reply.code(201).send({ ok: true, shift });
    } catch (e: any) {
      const msg = String(e?.message || '');
      if (/cashier_shifts_one_open/.test(msg)) {
        return reply.code(409).send({ ok: false, error: 'Bu kassada ochiq smena bor. Avval uni yoping.' });
      }
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: msg || 'Smena ochilmadi' });
    }
  });

  /** Joriy holat: smena hisoboti (yopishdan oldin ko'rish uchun ham). */
  app.get('/api/admin/shifts/:id/summary', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const res = await supabaseRest<any>('rpc/shift_summary', {
        method: 'POST', body: JSON.stringify({ p_shift: String(req.params.id) }),
      });
      if (!res) return reply.code(404).send({ ok: false, error: 'Smena topilmadi' });
      return { ok: true, summary: res };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Hisobot yuklanmadi' });
    }
  });

  /** Smenani yopish — kassir sanagan naqd bilan solishtiriladi. */
  app.post('/api/admin/shifts/:id/close', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const counted = Number(req.body?.counted_cash);
      if (!Number.isFinite(counted) || counted < 0) {
        return reply.code(400).send({ ok: false, error: 'Sanalgan naqd summasini kiriting' });
      }

      const shift = (await supabaseRest<any[]>('cashier_shifts', { query: `?id=eq.${q(id)}&select=*&limit=1` }))[0];
      if (!shift) return reply.code(404).send({ ok: false, error: 'Smena topilmadi' });
      if (shift.closed_at) return reply.code(409).send({ ok: false, error: 'Bu smena allaqachon yopilgan' });

      const summary = await supabaseRest<any>('rpc/shift_summary', {
        method: 'POST', body: JSON.stringify({ p_shift: id }),
      });
      const expected = Number(summary?.expected_cash || 0);
      const difference = counted - expected;

      const rows = await supabaseRest<any[]>('cashier_shifts', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({
          closed_at: new Date().toISOString(), closed_by: admin.id,
          counted_cash: counted, expected_cash: expected, difference,
          note: String(req.body?.note || '').trim() || null,
        }),
      });

      await audit(admin.id, 'SHIFT_CLOSED', 'cashier_shifts', id, null,
        { counted, expected, difference, cashier: shift.cashier_name });

      const final = await supabaseRest<any>('rpc/shift_summary', {
        method: 'POST', body: JSON.stringify({ p_shift: id }),
      });
      return { ok: true, shift: rows[0], summary: final };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Smena yopilmadi' });
    }
  });

  /** Smenalar tarixi — kassa bo'yicha filtrlash mumkin. */
  app.get('/api/admin/shifts', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const reg = String(req.query?.register_id || '').trim();
      const limit = Math.min(100, Math.max(1, Number(req.query?.limit || 30)));
      const filter = reg ? `&register_id=eq.${q(reg)}` : '';
      const shifts = await supabaseRest<any[]>('cashier_shifts', {
        query: `?select=*${filter}&order=opened_at.desc&limit=${limit}`,
      });
      const regs = await supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name' });
      const rm = new Map(regs.map((r) => [String(r.id), r]));

      // Har bir smena uchun tushum — bitta so'rovda
      const ids = shifts.map((s) => String(s.id));
      const pays = ids.length
        ? await supabaseRest<any[]>('payments', {
            query: `?shift_id=in.(${ids.map(q).join(',')})&status=eq.paid&select=shift_id,amount,method,cash_amount,card_amount`,
          })
        : [];
      const agg = new Map<string, { n: number; cash: number; card: number; total: number }>();
      for (const p of pays) {
        const k = String(p.shift_id);
        const a = agg.get(k) || { n: 0, cash: 0, card: 0, total: 0 };
        const amount = Number(p.amount || 0);
        a.n += 1; a.total += amount;
        if (p.method === 'mixed') { a.cash += Number(p.cash_amount || 0); a.card += Number(p.card_amount || 0); }
        else if (p.method === 'card') a.card += amount;
        else a.cash += amount;
        agg.set(k, a);
      }
      return {
        ok: true,
        shifts: shifts.map((s) => ({
          ...s,
          register: rm.get(String(s.register_id)) || null,
          totals: agg.get(String(s.id)) || { n: 0, cash: 0, card: 0, total: 0 },
        })),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Smenalar yuklanmadi' });
    }
  });

  /**
   * KASSA HISOBOTI — P1 va P2 alohida.
   * Hisob bazada bajariladi (register_report), davr bo'yicha.
   */
  app.get('/api/admin/register-report', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { periodRange } = await import('./analytics-routes.js');
      const { from, to, label, anchor } = periodRange(String(req.query?.period || 'day'), req.query?.date);
      const rows = await supabaseRest<any>('rpc/register_report', {
        method: 'POST',
        body: JSON.stringify({ p_from: from.toISOString(), p_to: to.toISOString() }),
      });
      const list = Array.isArray(rows) ? rows : [];
      return {
        ok: true, label, anchor,
        from: from.toISOString(), to: to.toISOString(),
        registers: list,
        totals: list.reduce((a: any, r: any) => ({
          receipts: a.receipts + Number(r.receipts || 0),
          cash: a.cash + Number(r.cash || 0),
          card: a.card + Number(r.card || 0),
          total: a.total + Number(r.total || 0),
        }), { receipts: 0, cash: 0, card: 0, total: 0 }),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Kassa hisoboti yuklanmadi' });
    }
  });


  /**
   * TASHXIS — backend qaysi Supabase loyihasiga ulangan va
   * kerakli ustunlar bormi. Bazani taxmin qilmasdan aniqlash uchun.
   */
  app.get('/api/admin/db-check', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const url = String(process.env.SUPABASE_URL || '');
      const project = url.replace(/^https?:\/\//, '').split('.')[0] || '(nomaʼlum)';

      const check = async (table: string, cols: string) => {
        try { await supabaseRest<any[]>(table, { query: `?select=${cols}&limit=1` }); return true; }
        catch { return false; }
      };
      const [regTable, pinCols, payReg, insCats, insAvatar, bkDuration] = await Promise.all([
        check('cash_registers', 'id,code'),
        check('cash_registers', 'pin_hash,pin_set_at'),
        check('payments', 'register_id'),
        check('instructor_profiles', 'categories'),
        check('instructor_profiles', 'avatar_url'),
        check('bookings', 'duration_minutes'),
      ]);
      let registers: any[] = [];
      try { registers = await supabaseRest<any[]>('cash_registers', { query: '?select=code,name&order=code.asc' }); } catch {}

      return {
        ok: true,
        supabase_project: project,
        supabase_url: url.slice(0, 40) + '…',
        tables: {
          cash_registers: regTable,
          pin_columns: pinCols,
          payments_register_id: payReg,
          instructor_categories: insCats,
          instructor_avatar: insAvatar,
          booking_duration_minutes: bkDuration,
        },
        missing: [
          !regTable   && 'cash_registers jadvali',
          !pinCols    && 'cash_registers.pin_hash / pin_set_at',
          !payReg     && 'payments.register_id',
          !insCats    && 'instructor_profiles.categories  ← kategoriya saqlanmasligining sababi',
          !insAvatar  && 'instructor_profiles.avatar_url',
          !bkDuration && 'bookings.duration_minutes',
        ].filter(Boolean),
        registers: registers.map((r) => r.code),
        verdict: !regTable ? 'cash_registers jadvali yo‘q — migratsiyani ishga tushiring'
               : !pinCols  ? 'PIN ustunlari yo‘q'
               : !insCats  ? 'instructor_profiles.categories yo‘q — kategoriya shuning uchun saqlanmayapti'
               : 'hammasi joyida',
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Tekshirib bo‘lmadi' });
    }
  });


  /**
   * JARAYONDAGI DARSLAR — jonli taxta
   *
   * Instruktor chekni skanerlagach bron `in_progress` bo'ladi va shu yerga
   * tushadi. Har bir qatorda: o'quvchi, instruktor (avtomobil egasi),
   * chek raqami va urilgan vaqti, boshlangan vaqti, tugash vaqti.
   *
   * Tugashiga 10 daqiqa qolganlar tepaga chiqadi va qizaradi,
   * 20 daqiqa qolganlar sarg'ayadi — instruktor va admin ko'rib tursin.
   */
  app.get('/api/admin/in-progress', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const now = Date.now();

      /* Jarayondagilar + BUGUN yakunlanganlar.
         Admin "kim nechada boshladi, nechada yopdi" ni ko'rishi kerak,
         shuning uchun tugaganlar ham kunning oxirigacha ro'yxatda qoladi. */
      const dayStart = new Date(new Date(now).getTime() - 18 * 3600e3).toISOString();
      const [active, doneToday] = await Promise.all([
        supabaseRest<any[]>('bookings', {
          query: '?status=eq.in_progress&select=*&order=arrived_at.asc&limit=200',
        }),
        supabaseRest<any[]>('bookings', {
          query: `?status=eq.completed&departed_at=gte.${q(dayStart)}&select=*&order=departed_at.desc&limit=100`,
        }).catch(() => []),
      ]);
      const bookings = [...active, ...doneToday];
      if (!bookings.length) {
        return { ok: true, now: new Date(now).toISOString(), counts: { total: 0, red: 0, yellow: 0, stale: 0, done: 0 }, rows: [] };
      }

      const ids  = bookings.map((b) => String(b.id));
      const uids = [...new Set(bookings.map((b) => String(b.customer_id)).filter(Boolean))];
      const iids = [...new Set(bookings.map((b) => String(b.instructor_id)).filter(Boolean))];
      const cids = [...new Set(bookings.map((b) => String(b.course_id)).filter(Boolean))];

      const [ips, courses, pays, scans] = await Promise.all([
        iids.length ? supabaseRest<any[]>('instructor_profiles', { query: `?id=in.(${iids.map(q).join(',')})&select=id,user_id` }) : [],
        cids.length ? supabaseRest<any[]>('courses', { query: `?id=in.(${cids.map(q).join(',')})&select=id,name,duration_minutes` }) : [],
        ids.length  ? supabaseRest<any[]>('payments', { query: `?booking_id=in.(${ids.map(q).join(',')})&select=booking_id,receipt_code,paid_at,amount,method,register_id` }) : [],
        ids.length  ? supabaseRest<any[]>('attendance_verifications', { query: `?booking_id=in.(${ids.map(q).join(',')})&select=booking_id,created_at` }) : [],
      ]);

      const allUserIds = [...new Set([...uids, ...ips.map((i) => String(i.user_id))])].filter(Boolean);
      const [users, regs] = await Promise.all([
        allUserIds.length ? supabaseRest<any[]>('users', { query: `?id=in.(${allUserIds.map(q).join(',')})&select=id,full_name,phone` }) : [],
        supabaseRest<any[]>('cash_registers', { query: '?select=id,code,name' }).catch(() => []),
      ]);

      const um = new Map(users.map((u) => [String(u.id), u]));
      const im = new Map(ips.map((i) => [String(i.id), um.get(String(i.user_id)) || null]));
      const cm = new Map(courses.map((c) => [String(c.id), c]));
      const pm = new Map(pays.map((p) => [String(p.booking_id), p]));
      const sm = new Map(scans.map((s) => [String(s.booking_id), s]));
      const rm = new Map((regs as any[]).map((r) => [String(r.id), r]));

      const rows = bookings.map((b) => {
        const c = cm.get(String(b.course_id));
        const p = pm.get(String(b.id));
        const mins = Number(b.duration_minutes || c?.duration_minutes || 60);
        const started = b.arrived_at ? new Date(b.arrived_at) : new Date(b.start_at || b.booking_date);
        const ends = new Date(started.getTime() + mins * 60000);
        const left = Math.round((ends.getTime() - now) / 60000);
        const finished = String(b.status) === 'completed';
        return {
          id: b.id,
          status: b.status,
          finished,
          departed_at: b.departed_at || null,
          customer: um.get(String(b.customer_id)) || null,
          instructor: im.get(String(b.instructor_id)) || null,   // avtomobil egasi
          course: c || null,
          duration_minutes: mins,
          started_at: started.toISOString(),
          ends_at: ends.toISOString(),
          minutes_left: left,
          /* 10 daqiqadan kam — qizil, 20 dan kam — sariq.
             2 soatdan ko'p oshgani — unutilgan dars, alohida belgilanadi
             (instruktor «yakunlash»ni bosmagan). */
          level: finished ? 'done'
               : left < -120 ? 'stale'
               : left <= 10 ? 'red'
               : left <= 20 ? 'yellow' : 'normal',
          receipt_code: p?.receipt_code || null,
          paid_at: p?.paid_at || null,
          amount: Number(p?.amount || 0),
          method: p?.method || null,
          register: p?.register_id ? (rm.get(String(p.register_id))?.code || null) : null,
          scanned_at: sm.get(String(b.id))?.created_at || null,
        };
      });

      /* Tartib: shoshilinchlar tepada, unutilganlar esa pastda —
         ular ro'yxatni to'sib qo'ymasligi kerak. */
      /* Tartib: jarayondagilar (shoshilinchi tepada) -> unutilganlar
         -> bugun yakunlanganlar. */
      const rank = (r: any) => r.level === 'done' ? 2 : r.level === 'stale' ? 1 : 0;
      rows.sort((a, b) => {
        const d = rank(a) - rank(b);
        if (d !== 0) return d;
        if (rank(a) === 2) return new Date(b.departed_at || 0).getTime() - new Date(a.departed_at || 0).getTime();
        return a.minutes_left - b.minutes_left;
      });

      return {
        ok: true,
        now: new Date(now).toISOString(),
        counts: {
          total: rows.length,
          red: rows.filter((r) => r.level === 'red').length,
          yellow: rows.filter((r) => r.level === 'yellow').length,
          stale: rows.filter((r) => r.level === 'stale').length,
          done: rows.filter((r) => r.level === 'done').length,
          active: rows.filter((r) => !r.finished).length,
        },
        rows,
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Jarayondagilar yuklanmadi' });
    }
  });


  /**
   * KASSA DASHBOARDI — faqat o'z kassasi.
   *
   * Kassa ID'si TOKENdan olinadi, so'rovdan emas. Shunday qilib P1
   * kassiri P2 ning tushumini ko'ra olmaydi — token faqat o'z kassasiga
   * imzolangan.
   */
  app.get('/api/admin/my-dashboard', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const registerId = readRegisterToken(String(req.query?.token || ''));
      if (!registerId) {
        return reply.code(401).send({ ok: false, error: 'Kassa ochilmagan yoki muddati tugagan. PIN bilan qayta oching.' });
      }
      const reg = (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(registerId)}&select=id,code,name&limit=1`,
      }))[0];
      if (!reg) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      const { periodRange } = await import('./analytics-routes.js');
      const { from, to, label, anchor, bucket } = periodRange(String(req.query?.period || 'day'), req.query?.date);

      const span = to.getTime() - from.getTime();
      const prevFrom = new Date(from.getTime() - span);
      const call = (f: Date, t: Date) => supabaseRest<any>('rpc/register_dashboard', {
        method: 'POST',
        body: JSON.stringify({ p_register: registerId, p_from: f.toISOString(), p_to: t.toISOString() }),
      });
      const [cur, prev] = await Promise.all([call(from, to), call(prevFrom, from)]);

      const t0 = cur?.totals || {}, p0 = prev?.totals || {};
      const delta = (a: any, b: any) => {
        const x = Number(a || 0), y = Number(b || 0);
        if (!y) return x ? 100 : 0;
        return Math.round(((x - y) / y) * 100);
      };

      return {
        ok: true,
        register: reg, period: String(req.query?.period || 'day'), label, anchor, bucket,
        from: from.toISOString(), to: to.toISOString(),
        totals: t0,
        change: { total: delta(t0.total, p0.total), receipts: delta(t0.receipts, p0.receipts) },
        hours: cur?.hours || [],
        categories: cur?.categories || [],
        instructors: cur?.instructors || [],
        recent: cur?.recent || [],
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Hisobot yuklanmadi' });
    }
  });

  /* ---------------- PIN ni o'rnatish (faqat admin) ---------------- */
  app.put('/api/admin/registers/:id/pin', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const pin = String(req.body?.pin ?? '').trim();

      if (!/^\d{4,8}$/.test(pin)) {
        return reply.code(400).send({ ok: false, error: 'PIN 4 dan 8 tagacha raqamdan iborat bo‘lsin' });
      }
      const reg = (await supabaseRest<any[]>('cash_registers', { query: `?id=eq.${q(id)}&select=id,code&limit=1` }))[0];
      if (!reg) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      await supabaseRest('cash_registers', {
        method: 'PATCH', query: `?id=eq.${q(id)}`,
        body: JSON.stringify({ pin_hash: pinHash(id, pin), pin_set_at: new Date().toISOString() }),
      });
      // PIN ning o'zi hech qayerga yozilmaydi — auditda ham
      await audit(admin.id, 'REGISTER_PIN_SET', 'cash_registers', id, null, { register: reg.code });
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'PIN saqlanmadi' });
    }
  });

  /* ---------------- Kassani ochish ---------------- */
  app.post('/api/admin/registers/:id/unlock', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const id = String(req.params.id);
      const pin = String(req.body?.pin ?? '').trim();

      const reg = (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(id)}&is_active=eq.true&select=id,code,name&limit=1`,
      }))[0];
      if (!reg) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      // PIN ustuni bo'lmasa — migratsiya hali qo'llanmagan, kirishga ruxsat
      let storedHash: string | null = null;
      try {
        const r2 = (await supabaseRest<any[]>('cash_registers', {
          query: `?id=eq.${q(id)}&select=pin_hash&limit=1`,
        }))[0];
        storedHash = r2?.pin_hash ?? null;
      } catch {
        return {
          ok: true, warning: 'PIN ustunlari bazaga qo‘shilmagan. Migratsiyani ishga tushiring.',
          register: { id: reg.id, code: reg.code, name: reg.name },
          token: makeRegisterToken(reg.id),
        };
      }
      (reg as any).pin_hash = storedHash;

      // PIN hali o'rnatilmagan bo'lsa kirishga ruxsat beramiz, lekin ogohlantiramiz —
      // aks holda admin PIN qo'ymaguncha kassa umuman ishlamay qolardi.
      if (!reg.pin_hash) {
        return {
          ok: true, warning: 'Bu kassaga PIN o‘rnatilmagan. Sozlamalar bo‘limidan qo‘ying.',
          register: { id: reg.id, code: reg.code, name: reg.name },
          token: makeRegisterToken(reg.id),
        };
      }
      if (!pin) return reply.code(400).send({ ok: false, error: 'PIN kiriting' });
      if (!safeEq(reg.pin_hash, pinHash(id, pin))) {
        return reply.code(401).send({ ok: false, error: 'PIN noto‘g‘ri' });
      }
      return {
        ok: true,
        register: { id: reg.id, code: reg.code, name: reg.name },
        token: makeRegisterToken(reg.id),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Kassa ochilmadi' });
    }
  });
}
