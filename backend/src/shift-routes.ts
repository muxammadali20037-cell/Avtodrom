import type { FastifyInstance } from 'fastify';
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
      const regs = await supabaseRest<any[]>('cash_registers', {
        query: '?is_active=eq.true&select=*&order=code.asc',
      });
      const open = await supabaseRest<any[]>('cashier_shifts', {
        query: '?closed_at=is.null&select=*',
      });
      const byReg = new Map(open.map((s) => [String(s.register_id), s]));
      return {
        ok: true,
        registers: regs.map((r) => ({ ...r, open_shift: byReg.get(String(r.id)) || null })),
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
}
