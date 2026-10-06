import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { selectIn } from './rest-chunks.js';
import {
  normSchedule, scheduleJson, loadSchedules, scheduleFor, saveSchedule, offBlocksBetween,
  tashkentYmdOf, addDaysYmd, dayStartMs, hmToMin, type Schedule,
} from './instructor-schedule.js';
import { blocksFor, saveDayBlocks, tashkentAt } from './instructor-blocks.js';

/**
 * ADMIN: INSTRUKTORLAR ISH GRAFIGI
 *
 *   GET /api/admin/work-schedules                         — hamma instruktor + grafigi (ro'yxat)
 *   GET /api/admin/instructors/:id/work-schedule?days=14  — bitta instruktor: grafik, bronlar, o'zi yopgan soatlar
 *   PUT /api/admin/instructors/:id/work-schedule          — { week, dates } saqlash; javobda to'qnashgan bronlar
 *   PUT /api/admin/instructors/:id/blocks                 — { date, slots } instruktor o'zi yopgan soatlarni admin o'zgartiradi
 *
 * Faqat administrator. Operator /api/admin/* oq ro'yxatida yo'q — unga 403.
 */

const q = (v: string) => encodeURIComponent(v);
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const hmOk = (v: unknown) => /^\d{1,2}:\d{2}/.test(String(v || ''));
const hm5 = (v: unknown, d: string) => hmOk(v) ? String(v).slice(0, 5).padStart(5, '0') : d;

async function workSettings() {
  const rows = await supabaseRest<any[]>('admin_settings', { query: '?key=in.(work_start,work_end,slot_step_min)&select=key,value' }).catch(() => []);
  const sv = (k: string) => { const r = rows.find((x: any) => x.key === k); return r ? (r.value?.value ?? r.value) : null; };
  return {
    work_start: hm5(sv('work_start'), '07:00'),
    work_end: hm5(sv('work_end'), '19:00'),
    slot_step_min: Math.max(15, Number(sv('slot_step_min')) || 60),
  };
}

async function instructorRows(ids?: string[]) {
  const filter = ids?.length ? `&id=in.(${ids.map(q).join(',')})` : '&is_verified=eq.true';
  const ips = await supabaseRest<any[]>('instructor_profiles', { query: `?select=*${filter}&limit=500` });
  const users = await selectIn<any>('users', 'id', ips.map((i) => i.user_id), 'id,full_name,phone,is_active,is_blocked');
  const um = new Map(users.map((u) => [String(u.id), u]));
  return ips.map((x) => {
    const u: any = um.get(String(x.user_id)) || {};
    return {
      id: String(x.id),
      name: u.full_name || 'Instruktor',
      phone: u.phone || null,
      categories: Array.isArray(x.categories) && x.categories.length ? x.categories : ['B'],
      vehicle_plate: x.vehicle_plate || null,
      avatar_url: x.avatar_url || null,
      active: Boolean(x.is_verified && x.is_available && u.is_active !== false && !u.is_blocked),
    };
  });
}

/** Kelajakdagi faol bronlar ichida grafik bo'yicha dam vaqtga tushganlari. */
async function conflictsFor(instructorId: string, s: Schedule, days = 60) {
  const from = new Date();
  const to = new Date(from.getTime() + days * 864e5);
  const rows = await supabaseRest<any[]>('bookings', {
    query: `?instructor_id=eq.${q(instructorId)}&status=in.(pending,confirmed)` +
           `&start_at=gte.${q(from.toISOString())}&start_at=lt.${q(to.toISOString())}&select=id,start_at,end_at,status,customer_id&order=start_at.asc&limit=500`,
  });
  const off = offBlocksBetween(s, from, to);
  const hit = rows.filter((b) => {
    const a = Date.parse(b.start_at), e = Date.parse(b.end_at) || a + 3600e3;
    return off.some((x) => Date.parse(x.start_at) < e && Date.parse(x.end_at) > a);
  });
  const users = await selectIn<any>('users', 'id', hit.map((b) => b.customer_id), 'id,full_name,phone');
  const um = new Map(users.map((u) => [String(u.id), u]));
  return hit.map((b) => ({
    id: b.id, start_at: b.start_at, end_at: b.end_at, status: b.status,
    customer_name: um.get(String(b.customer_id))?.full_name || 'Mijoz',
    customer_phone: um.get(String(b.customer_id))?.phone || null,
  }));
}

export async function registerScheduleRoutes(
  app: FastifyInstance,
  guardAdmin: (req: any) => Promise<void>,
  adminUser: () => Promise<any>,
  audit: (adminId: string | null, action: string, entityType: string, entityId: string | null, oldData: unknown, newData: unknown) => Promise<void>,
) {
  app.get('/api/admin/work-schedules', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const [list, ws] = await Promise.all([instructorRows(), workSettings()]);
      const sm = await loadSchedules(list.map((i) => i.id));
      const instructors = list
        .map((i) => ({ ...i, schedule: sm.has(i.id) ? scheduleJson(sm.get(i.id)!) : null }))
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'uz'));
      return { ok: true, today: tashkentYmdOf(Date.now()), ...ws, instructors };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Grafiklar yuklanmadi' });
    }
  });

  app.get('/api/admin/instructors/:id/work-schedule', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const id = String(req.params.id);
      const [ins] = await instructorRows([id]);
      if (!ins) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      const days = Math.max(1, Math.min(31, Number(req.query?.days) || 14));
      const today = tashkentYmdOf(Date.now());
      const from = new Date(dayStartMs(today)), to = new Date(dayStartMs(addDaysYmd(today, days)));
      const [ws, sched, own, rows] = await Promise.all([
        workSettings(),
        scheduleFor(id),
        blocksFor(id),
        supabaseRest<any[]>('bookings', {
          query: `?instructor_id=eq.${q(id)}&status=in.(pending,confirmed,in_progress,completed)` +
                 `&start_at=lt.${q(to.toISOString())}&end_at=gt.${q(from.toISOString())}` +
                 '&select=id,start_at,end_at,status,customer_id,duration_minutes&order=start_at.asc&limit=1000',
        }),
      ]);
      const users = await selectIn<any>('users', 'id', rows.map((b) => b.customer_id), 'id,full_name');
      const um = new Map(users.map((u) => [String(u.id), u]));
      return {
        ok: true, today, days, ...ws,
        instructor: ins,
        schedule: scheduleJson(sched),
        bookings: rows.map((b) => {
          const s = Date.parse(b.start_at);
          const e = Date.parse(b.end_at) || s + (Number(b.duration_minutes) || 60) * 60000;
          return { id: b.id, start_at: new Date(s).toISOString(), end_at: new Date(e).toISOString(), status: b.status,
            customer_name: um.get(String(b.customer_id))?.full_name || 'Mijoz' };
        }),
        blocks: own.filter((b) => Date.parse(b.end_at) > from.getTime() && Date.parse(b.start_at) < to.getTime()),
      };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 500).send({ ok: false, error: e?.message || 'Grafik yuklanmadi' });
    }
  });

  app.put('/api/admin/instructors/:id/work-schedule', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const [ins] = await instructorRows([id]);
      if (!ins) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      const body = req.body || {};
      if (body.week !== undefined && (typeof body.week !== 'object' || Array.isArray(body.week))) {
        return reply.code(400).send({ ok: false, error: 'Haftalik grafik noto‘g‘ri' });
      }
      const today = tashkentYmdOf(Date.now());
      const maxDay = addDaysYmd(today, 120);
      const old = await scheduleFor(id);
      const next = normSchedule({ week: body.week ?? scheduleJson(old).week, dates: body.dates ?? scheduleJson(old).dates });
      /* Sana bo'yicha qoidalar: o'tgan kunlar va 120 kundan uzoqlari olinmaydi */
      for (const k of Object.keys(next.dates)) if (k < today || k > maxDay) delete next.dates[k];
      const saved = await saveSchedule(id, next);
      await audit(admin?.id ?? null, 'INSTRUCTOR_SCHEDULE_UPDATED', 'instructor_profiles', id, scheduleJson(old), scheduleJson(saved));
      const conflicts = await conflictsFor(id, saved).catch(() => []);
      return { ok: true, schedule: scheduleJson(saved), conflicts };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Grafik saqlanmadi' });
    }
  });

  /* Instruktor o'zi yopgan soatlarni admin ochishi (yoki yopishi) mumkin. */
  app.put('/api/admin/instructors/:id/blocks', async (req: any, reply: any) => {
    try {
      await guardAdmin(req);
      const admin = await adminUser();
      const id = String(req.params.id);
      const [ins] = await instructorRows([id]);
      if (!ins) return reply.code(404).send({ ok: false, error: 'Instruktor topilmadi' });
      const b = req.body || {};
      const day = String(b.date || '');
      if (!YMD.test(day)) return reply.code(400).send({ ok: false, error: 'Sana noto‘g‘ri' });
      const today = tashkentYmdOf(Date.now());
      if (day < today) return reply.code(400).send({ ok: false, error: 'O‘tgan kunni o‘zgartirib bo‘lmaydi' });
      if (day > addDaysYmd(today, 60)) return reply.code(400).send({ ok: false, error: 'Faqat 60 kun oldinga' });
      const raw = Array.isArray(b.slots) ? b.slots : [];
      if (raw.length > 96) return reply.code(400).send({ ok: false, error: 'Juda ko‘p soat' });
      const slots: { start_at: string; end_at: string }[] = [];
      for (const x of raw) {
        const a = hmToMin(x?.from), z = hmToMin(x?.to);
        if (a === null || z === null || a >= z || z > 1440) return reply.code(400).send({ ok: false, error: 'Soat noto‘g‘ri' });
        slots.push({ start_at: new Date(dayStartMs(day) + a * 60000).toISOString(), end_at: new Date(dayStartMs(day) + z * 60000).toISOString() });
      }
      const ds = tashkentAt(day, '00:00').getTime();
      const inDay = (x: { start_at: string }) => Date.parse(x.start_at) >= ds && Date.parse(x.start_at) < ds + 864e5;
      const before = (await blocksFor(id)).filter(inDay);
      const all = await saveDayBlocks(id, day, slots);
      await audit(admin?.id ?? null, 'INSTRUCTOR_BLOCKS_UPDATED', 'instructor_profiles', id, { date: day, blocks: before }, { date: day, slots: raw });
      return { ok: true, blocks: all.filter(inDay) };
    } catch (e: any) {
      return reply.code(e?.statusCode ?? 400).send({ ok: false, error: e?.message || 'Saqlanmadi' });
    }
  });
}

