import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { supabaseRest } from './supabase.js';
import { completeSchoolReceipt, isSchoolReceiptCode } from './school-receipt.js';

/** Bronga biriktirilgan avtoshkola cheki kodi (AVS-12345) yoki null.
    Izohdan olishda `source` ham 'avtodrom12' bo'lishi shart — aks holda
    mijoz izohida tasodifan uchragan kod begona chekni yopib yuborardi. */
function schoolReceiptCodeOf(booking: any): string | null {
  const direct = String(booking?.school_receipt_code || '').trim().toUpperCase();
  if (isSchoolReceiptCode(direct)) return direct;
  if (String(booking?.source || '') !== 'avtodrom12') return null;
  const m = String(booking?.customer_note || '').toUpperCase().match(/AVS-\d{5}/);
  return m ? m[0] : null;
}

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

/* Rolni cookie'dan xavfsiz o'qiydi (xato bo'lsa null). */
async function currentStaffSafe(req: any): Promise<{ role: string; register_id?: string | null } | null> {
  try {
    const mod: any = await import('./admin-password-routes.js');
    if (mod.currentStaff) return await mod.currentStaff(req);
  } catch {}
  return null;
}

/**
 * Kassa tokenini o'qiydi VA kassirning o'z kassasi ekanini tekshiradi.
 * P1 kassiri P2 tokeni bilan kelsa — rad etiladi (panellar aralashmaydi).
 * Administrator istalgan kassani ko'ra oladi.
 * Qaytaradi: kassa ID'si; token yo'q/yaroqsiz bo'lsa null; begona kassa — 403.
 */
export async function ownRegisterFromToken(req: any, token: string): Promise<string | null> {
  const registerId = readRegisterToken(token);
  if (!registerId) return null;
  const me: any = await currentStaffSafe(req);
  if (me && me.role === 'cashier' && String(me.register_id || '') !== String(registerId)) {
    const e: any = new Error('Bu kassa sizga tegishli emas');
    e.statusCode = 403;
    throw e;
  }
  if (me && me.role === 'operator') {
    const e: any = new Error('Operator kassaga kira olmaydi');
    e.statusCode = 403;
    throw e;
  }
  return registerId;
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

/** Faqat administrator. Kassir 403 oladi. */
async function requireStaffAdmin(req: any) {
  const { guardAdmin } = await import('./admin-password-routes.js');
  await guardAdmin(req);
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
      const { rangeFromQuery } = await import('./analytics-routes.js');
      const { from, to, label, anchor } = rangeFromQuery(req.query);
      const rows = await supabaseRest<any>('rpc/register_report', {
        method: 'POST',
        body: JSON.stringify({ p_from: from.toISOString(), p_to: to.toISOString() }),
      });
      let list = Array.isArray(rows) ? rows : [];
      /* Kassir faqat o'z kassasining hisobini ko'radi */
      const me: any = await currentStaffSafe(req);
      if (me && me.role === 'cashier') {
        const own = (await supabaseRest<any[]>('cash_registers', {
          query: `?id=eq.${q(String(me.register_id || ''))}&select=id,code&limit=1`,
        }).catch(() => []))[0];
        list = list.filter((r: any) => own && (String(r.register_id || r.id || '') === String(own.id) || String(r.code || '') === String(own.code)));
      }
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
      const uids = [...new Set(bookings.map((b) => b.customer_id).filter(Boolean).map(String))];
      const iids = [...new Set(bookings.map((b) => b.instructor_id).filter(Boolean).map(String))];
      const cids = [...new Set(bookings.map((b) => b.course_id).filter(Boolean).map(String))];

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
          /* Instruktor o'chirilgan bo'lsa bronda saqlangan ismdan
             foydalanamiz — hisobot "—" bo'lib qolmasin. */
          instructor: im.get(String(b.instructor_id))
            || (b.instructor_name ? { full_name: b.instructor_name, deleted: true } : null),
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
          /* «Jarayonda» — faqat haqiqatan ketayotgan darslar.
             Unutilganlar (stale) alohida sanaladi, aks holda tabda
             2 ko'rinib, ro'yxat bo'sh chiqardi. */
          active: rows.filter((r) => r.level !== 'done' && r.level !== 'stale').length,
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
      const registerId = await ownRegisterFromToken(req, String(req.query?.token || ''));
      if (!registerId) {
        return reply.code(401).send({ ok: false, error: 'Kassa ochilmagan yoki muddati tugagan. PIN bilan qayta oching.' });
      }
      const reg = (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(registerId)}&select=id,code,name&limit=1`,
      }))[0];
      if (!reg) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });

      const { rangeFromQuery } = await import('./analytics-routes.js');
      const { from, to, label, anchor, bucket, period } = rangeFromQuery(req.query);

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
        register: reg, period, label, anchor, bucket,
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


  /**
   * Darsni qo'lda yakunlash.
   *
   * IKKI HOLAT UCHUN:
   *  · Instruktor "yakunlash" tugmasini bosmay qolgan — dars kunlar
   *    davomida "jarayonda" turadi va yangi darsni to'sib qo'yadi.
   *  · Kassir jarayondagi darsni joyida to'xtatmoqchi (o'quvchi erta
   *    ketdi, instruktor telefonidan yopa olmayapti va h.k.).
   *
   * `at` berilsa — tugash vaqti aynan o'sha payt (kassir qo'lda
   * belgilaydi). Berilmasa — eski xatti-harakat: rejadagi oxiri,
   * u ham o'tib ketgan bo'lsa hozir.
   *
   * Kim yopgani va qaysi vaqt bilan yopgani auditga yoziladi —
   * bu instruktor o'rniga qilingan amal.
   */
  app.post('/api/admin/bookings/:id/force-finish', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);

      const b = (await supabaseRest<any[]>('bookings', {
        query: `?id=eq.${q(id)}&select=*&limit=1`,
      }))[0];
      if (!b) return reply.code(404).send({ ok: false, error: 'Bron topilmadi' });
      if (String(b.status) !== 'in_progress') {
        return reply.code(409).send({ ok: false, error: `Bron holati "${b.status}" — yopish shart emas` });
      }

      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();

      let departed: string;
      const raw = String((req.body as any)?.at || '').trim();
      if (raw) {
        const want = new Date(raw);
        if (Number.isNaN(want.getTime())) {
          return reply.code(400).send({ ok: false, error: 'Tugash vaqti noto‘g‘ri' });
        }
        /* Dars boshlanmasdan tugay olmaydi. */
        const startMs = new Date(b.started_at || b.start_at || 0).getTime();
        if (startMs && want.getTime() < startMs) {
          return reply.code(400).send({
            ok: false,
            error: 'Tugash vaqti dars boshlangan vaqtdan oldin bo‘lolmaydi',
          });
        }
        /* Kelajakka yozilmasin — soatlar biroz farq qilishi mumkin,
           shuning uchun 2 daqiqa toqat qilamiz va hozirga qisqartiramiz. */
        departed = new Date(Math.min(want.getTime(), nowMs + 120000, nowMs)).toISOString();
      } else {
        const planned = b.end_at ? new Date(b.end_at) : null;
        departed = planned && planned.getTime() < nowMs ? planned.toISOString() : now;
      }

      const rows = await supabaseRest<any[]>('bookings', {
        method: 'PATCH', headers: { Prefer: 'return=representation' }, query: `?id=eq.${q(id)}`,
        body: JSON.stringify({ status: 'completed', departed_at: b.departed_at || departed, updated_at: now }),
      });
      await audit(admin.id, 'BOOKING_FORCE_FINISHED', 'bookings', id,
        { status: b.status, departed_at: b.departed_at || null },
        { status: 'completed', departed_at: b.departed_at || departed, manual: !!raw });

      /* Avtoshkola darsi bo'lsa avtodrom12 dagi sessiyani ham yopamiz —
         aks holda o'sha avtomobil u yerda "Jarayonda" bo'lib qolar va
         keyingi darsni to'sardi. Instruktor "Yakunlash" bosganda ham
         xuddi shunday qilinadi.
         Kutmaymiz: avtodrom12 sekin javob bersa kassir tugmasi osilib
         qolmasin — dars baribir yakunlangan. */
      const schoolCode = schoolReceiptCodeOf(rows[0] || b);
      if (schoolCode) {
        const startedAt = b.arrived_at || b.started_at || b.start_at;
        const endMs = new Date(b.departed_at || departed).getTime();
        const seconds = startedAt
          ? Math.max(0, Math.round((endMs - new Date(startedAt).getTime()) / 1000))
          : undefined;
        void completeSchoolReceipt(schoolCode, seconds);
      }

      return { ok: true, booking: rows[0] ?? null, departed_at: b.departed_at || departed };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Yopilmadi' });
    }
  });


  /* =====================================================================
     ESLATMA TIZIMI TASHXISI
     Admin bir tugma bosib, eslatma botga ketadimi yo'qmi — bilib oladi.
     Barcha shartlarni tekshiradi: bot tokeni, kutilayotgan bronlar,
     yaqin darslar. Hech nima o'zgartirmaydi — faqat ko'rsatadi.
     ===================================================================== */
  app.get('/api/admin/reminder-check', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const checks: any[] = [];

      // 1) Bot tokeni bormi
      const botToken = String(process.env.CUSTOMER_BOT_TOKEN || process.env.TELEGRAM_CUSTOMER_BOT_TOKEN || '').trim();
      checks.push({
        name: 'Mijoz bot tokeni',
        ok: !!botToken,
        detail: botToken ? 'sozlangan' : 'CUSTOMER_BOT_TOKEN Vercelda yo\u2018q',
      });

      // 2) CRON_SECRET
      const cronSecret = String(process.env.CRON_SECRET || '').trim();
      checks.push({
        name: 'CRON_SECRET',
        ok: !!cronSecret,
        detail: cronSecret ? 'sozlangan' : 'yo\u2018q \u2014 cron endpoint himoyasiz yoki ishlamaydi',
      });

      // 3) booking_reminders jadvali kerakli ustunlar bilan bormi
      let tableOk = true, tableDetail = 'joyida';
      try {
        await supabaseRest<any[]>('booking_reminders', { query: '?select=booking_id,kind,created_at&limit=1' });
      } catch (e: any) {
        tableOk = false;
        tableDetail = `${e?.message || 'xato'} — «Eslatmalar» kartasidagi SQL'ni Supabase'da ishga tushiring`;
      }
      checks.push({ name: 'Eslatmalar jadvali', ok: tableOk, detail: tableDetail });

      // 4) Yaqin 90 daqiqadagi HAR BIR faol bron (pending + confirmed)
      const now = Date.now();
      const soon = new Date(now + 90 * 60000).toISOString();
      const nowIso = new Date(now).toISOString();
      const upcoming = await supabaseRest<any[]>('bookings', {
        query: `?status=in.(pending,confirmed)&start_at=gte.${q(nowIso)}&start_at=lte.${q(soon)}&select=id,start_at&limit=50`,
      }).catch(() => []);
      checks.push({
        name: 'Yaqin darslar (90 daq)',
        ok: true,
        detail: `${upcoming.length} ta bron eslatma kutmoqda`,
      });

      // 5) Bugun yuborilgan eslatmalar
      const dayStart = new Date(now - 18 * 3600e3).toISOString();
      const sentToday = tableOk ? await supabaseRest<any[]>('booking_reminders', {
        query: `?created_at=gte.${q(dayStart)}&select=kind&limit=500`,
      }).catch(() => []) : [];
      const byKind: Record<string, number> = {};
      sentToday.forEach((r: any) => { byKind[r.kind] = (byKind[r.kind] || 0) + 1; });
      checks.push({
        name: 'Bugun yuborilgan eslatmalar',
        ok: true,
        detail: sentToday.length
          ? Object.entries(byKind).map(([k, n]) => `${k} daq: ${n}`).join(', ')
          : 'hali yo\u2018q (yaqin dars bo\u2018lmasa normal)',
      });

      // 6) Oxirgi avtomatik tekshiruv qachon bo'ldi
      const { LAST_RUN_KEY } = await import('./reminders.js');
      const lr = (await supabaseRest<any[]>('admin_settings', {
        query: `?key=eq.${LAST_RUN_KEY}&select=value&limit=1`,
      }).catch(() => []))[0]?.value || null;
      const ageMin = lr?.at ? Math.round((now - new Date(lr.at).getTime()) / 60000) : null;
      checks.push({
        name: 'Oxirgi tekshiruv',
        ok: ageMin !== null && ageMin <= 10,
        detail: ageMin === null
          ? 'hali bo\u2018lmagan \u2014 cron sozlanmagan'
          : `${ageMin} daqiqa oldin (${lr.source || '?'})${ageMin > 10 ? ' \u2014 cron ishlamayapti, panel ochiq bo\u2018lganda ishlaydi' : ''}`,
      });

      const ready = !!botToken && tableOk;
      return {
        ok: true,
        ready,
        summary: !botToken
          ? 'Bot tokeni yo\u2018q \u2014 eslatma yuborilmaydi.'
          : !tableOk
            ? 'Eslatmalar jadvali mos emas \u2014 SQL\u2019ni ishga tushiring.'
            : 'Eslatma tizimi tayyor: har bir bron egasiga 60, 30 va 10 daqiqa qolganda xabar ketadi.',
        checks,
        last_run: lr,
        note: 'Admin yoki kassa paneli ochiq turganda eslatmalar har 2 daqiqada tekshiriladi. Panel yopiq bo\u2018lganda ham ishlashi uchun Supabase pg_cron SQL\u2019ni bir marta ishga tushiring.',
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Tekshiruv xatosi' });
    }
  });

  /* Admin «Hozir yuborish» — muddati kelgan eslatmalarni darhol yuboradi. */
  app.post('/api/admin/reminder-test', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { runRemindersNow } = await import('./reminders.js');
      const result = await runRemindersNow('admin');
      return { ok: true, result };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Sinov xatosi' });
    }
  });

  /* Ochiq turgan admin/kassa paneli har 2 daqiqada chaqiradi.
     Daqiqasiga bir martadan ko'p ishlamaydi, takror xabar ketmaydi. */
  app.post('/api/admin/reminders/tick', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const { tickReminders } = await import('./reminders.js');
      return { ok: true, ...(await tickReminders('panel')) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Eslatma tekshiruvi xatosi' });
    }
  });

  /* ---------------- PIN ni o'rnatish (faqat admin) ---------------- */

  /* =====================================================================
     BOSHQARUV PIN — kassa PIN kabi, lekin butun BOSHQARUV bo'limi uchun.
     Admin login qiladi (1-qatlam), keyin BOSHQARUV ochilganda PIN
     so'raladi (2-qatlam). PIN admin_settings da xeshlanган holda.
     ===================================================================== */
  const MGMT_KEY = 'mgmt_pin';   // admin_settings.key

  function mgmtPinHash(pin: string) { return hmac(`mgmt:${pin}`); }
  function makeMgmtToken() {
    const exp = Date.now() + TOKEN_TTL_MS;
    return `mgmt.${exp}.${hmac(`mgmt-tok:${exp}`)}`;
  }
  function readMgmtToken(token: string): boolean {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'mgmt') return false;
    const [, expStr, sig] = parts;
    if (!safeEq(sig, hmac(`mgmt-tok:${expStr}`))) return false;
    if (!Number(expStr) || Number(expStr) < Date.now()) return false;
    return true;
  }

  /** PIN o'rnatilganmi (holat). */
  app.get('/api/admin/mgmt-pin', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const rows = await supabaseRest<any[]>('admin_settings', {
        query: `?key=eq.${MGMT_KEY}&select=value&limit=1`,
      }).catch(() => []);
      const val = rows[0]?.value;
      const hash = val?.hash || val;
      return { ok: true, is_set: !!(hash && String(hash).length > 10) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Holatni o‘qib bo‘lmadi' });
    }
  });

  /** PIN o'rnatish / o'zgartirish. */
  app.put('/api/admin/mgmt-pin', async (req: any, reply: any) => {
    try {
      /* BOSHQARUV PIN ini faqat administrator o'zgartira oladi — ilgari
         har qanday kirgan xodim (kassir ham) uni qayta yozib qo'yardi. */
      await requireStaffAdmin(req);
      const pin = String(req.body?.pin ?? '').trim();
      if (!/^\d{4,8}$/.test(pin)) {
        return reply.code(400).send({ ok: false, error: 'PIN 4 dan 8 tagacha raqam bo‘lsin' });
      }

      const exists = (await supabaseRest<any[]>('admin_settings', {
        query: `?key=eq.${MGMT_KEY}&select=key&limit=1`,
      }).catch(() => []))[0];
      const value = { hash: mgmtPinHash(pin), set_at: new Date().toISOString() };

      if (exists) {
        await supabaseRest('admin_settings', {
          method: 'PATCH', query: `?key=eq.${MGMT_KEY}`,
          body: JSON.stringify({ value, updated_at: new Date().toISOString() }),
        });
      } else {
        await supabaseRest('admin_settings', {
          method: 'POST',
          body: JSON.stringify({ key: MGMT_KEY, value, updated_at: new Date().toISOString() }),
        });
      }
      try { const admin = await adminUser(); await audit(admin.id, 'MGMT_PIN_SET', 'admin_settings', MGMT_KEY, null, null); }
      catch (e) { console.warn('MGMT_PIN_SET audit:', e); }
      return { ok: true };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'PIN saqlanmadi' });
    }
  });

  /** BOSHQARUV ni ochish — PIN tekshiriladi, token beriladi. */
  app.post('/api/admin/mgmt-unlock', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const pin = String(req.body?.pin ?? '').trim();

      const rows = await supabaseRest<any[]>('admin_settings', {
        query: `?key=eq.${MGMT_KEY}&select=value&limit=1`,
      }).catch(() => []);
      const stored = rows[0]?.value?.hash || rows[0]?.value;

      // PIN hali o'rnatilmagan bo'lsa — birinchi kirishда o'rnatishga yo'l qo'yamiz
      if (!stored || String(stored).length < 10) {
        return reply.code(409).send({ ok: false, error: 'PIN o‘rnatilmagan', needs_setup: true });
      }
      if (!safeEq(String(stored), mgmtPinHash(pin))) {
        return reply.code(401).send({ ok: false, error: 'PIN noto‘g‘ri' });
      }
      return { ok: true, token: makeMgmtToken() };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Ochib bo‘lmadi' });
    }
  });

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
  /* Admin uchun PINsiz kassa tokeni. Faqat administrator chaqira oladi
     (guardAdmin). Kassir bunga muhtoj emas — tokeni login'да bor. */
  app.post('/api/admin/registers/:id/token', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const me = await currentStaffSafe(req);
      if (me && me.role === 'cashier') {
        return reply.code(403).send({ ok: false, error: 'Faqat administrator' });
      }
      const id = String(req.params.id);
      const reg = (await supabaseRest<any[]>('cash_registers', {
        query: `?id=eq.${q(id)}&select=id,code,name&limit=1`,
      }))[0];
      if (!reg) return reply.code(404).send({ ok: false, error: 'Kassa topilmadi' });
      return { ok: true, token: makeRegisterToken(reg.id), register: reg };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Token berilmadi' });
    }
  });

  app.post('/api/admin/registers/:id/unlock', async (req: any, reply: any) => {
    try {
      await requireAdmin(req);
      const id = String(req.params.id);
      /* Kassir faqat O'Z kassasini ochadi. Ilgari P1 kassiri P2 ni
         (PIN o'rnatilmagan bo'lsa PINsiz) ochib, uning nomidan chek
         chiqara olardi. */
      const me: any = await currentStaffSafe(req);
      if (me && me.role === 'cashier' && String(me.register_id || '') !== id) {
        return reply.code(403).send({ ok: false, error: 'Bu kassaga ruxsatingiz yo‘q' });
      }
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
