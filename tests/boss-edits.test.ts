/**
 * BOSHLIQ ILOVASI → «TAHRIRLANGANLAR» (/api/boss-edits)
 *
 * Tekshiriladi: kim qilgani so'rov kontekstidan audit va bazaga
 * (x-avt-actor) yetib borishi; kundalik ish chiqmasligi; ilova amali va
 * bazadagi «eski → yangi» bitta qatorga qo'shilishi; nomlar (sozlama,
 * xodim, mijoz, instruktor); avtodrom12 bilan birga sahifalash
 * (takrorsiz); manba filtri; avtodrom12 ishlamasa ham Avtodrom qismi.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';
import { usIso, auditIsEdit } from '../backend/src/boss-edits.js';

let h: Harness;
let admin = '';
let baseFetch: any;
let ipSeq = 0;
const KEY = 'shared-key-0123456789abcdef0123';
const A12 = 'https://a12.test';
const D = '2026-10-10';
const at = (hh: string) => new Date(`${D}T${hh}+05:00`).toISOString();
const actorHeaders: Array<{ method: string; table: string; actor: string | null }> = [];
let a12Items: any[] = [];
let a12Fail = false;
const bridgeUrls: string[] = [];

beforeAll(async () => { h = await makeHarness(); baseFetch = globalThis.fetch; });

beforeEach(async () => {
  h.reset();
  process.env.AVTODROM12_URL = A12;
  process.env.RECEIPT_SHARED_KEY = KEY;
  actorHeaders.length = 0; bridgeUrls.length = 0; a12Fail = false;
  a12Items = [
    { id: 'db:000000000003', at: `${D}T06:30:00.000005Z`, kind: 'db', table: 'sessions', op: 'update', title: '01A111AA', actor: 'Platniylar',
      fields: [{ col: 'cash_amount', old: 100000, new: 50000 }] },
    { id: 'log:9', at: `${D}T05:10:00.000000Z`, kind: 'log', table: 'expenses', op: 'update', entity: 'expense', action: 'expense_edit', title: 'Benzin',
      fields: [{ col: 'amount', old: 200000, new: 150000 }], reason: 'Xarajat tahrirlandi', actor: 'Platniylar' },
    { id: 'db:000000000001', at: `${D}T04:00:00.000000Z`, kind: 'db', table: 'students', op: 'delete', title: 'Shahzod', actor: null, fields: [] },
  ];
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, o: any = {}) => {
    const url = String(u);
    if (url.startsWith(`${A12}/api/bridge/edits`)) {
      bridgeUrls.push(url);
      expect((o.headers || {})['X-Receipt-Key']).toBe(KEY);
      if (a12Fail) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) } as any;
      const sp = new URL(url).searchParams;
      const lim = Number(sp.get('limit'));
      const b = sp.get('before');
      const [bAt, bId] = b ? [b.slice(0, b.indexOf('|')), b.slice(b.indexOf('|') + 1)] : [null, null];
      const rest = a12Items.filter((x) => !bAt || x.at < bAt || (x.at === bAt && x.id < String(bId)));
      const page = rest.slice(0, lim);
      const last = page[page.length - 1];
      return { ok: true, status: 200, json: async () => ({
        ok: true, source: 'avtodrom12', total: a12Items.length, deleted: 1,
        days: [{ day: D, n: a12Items.length, deleted: 1 }], items: page,
        next_before: rest.length > lim && last ? `${last.at}|${last.id}` : null, warnings: [],
      }) } as any;
    }
    if (url.includes('/rest/v1/') && o?.headers?.get && ['PATCH', 'POST', 'DELETE'].includes(String(o.method || '').toUpperCase())) {
      const table = /\/rest\/v1\/([a-z_/]+)/.exec(url)?.[1] || '';
      actorHeaders.push({ method: String(o.method).toUpperCase(), table, actor: o.headers.get('x-avt-actor') });
    }
    return harnessFetch(u, o);
  }) as any;

  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('parol1234'), role: 'admin', register_id: null, full_name: 'Bosh Admin', is_active: true });
  h.db.staff.push({ id: 'st-k1', login: 'kassa1', password_hash: hashPassword('parol1234'), role: 'cashier', register_id: 'reg-p1', full_name: 'Nodira Kassir', is_active: true });
  h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa', is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'AVTODROM Administrator', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-ali', full_name: 'Ali Valiyev', role: 'customer', is_active: true, is_blocked: false, telegram_id: 777 });
  h.db.users.push({ id: 'u-ins', full_name: 'Aziz Karimov', role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-ins', is_verified: true, is_available: true, categories: ['B'] });
  h.db.bookings.push({ id: 'bk-1', customer_id: 'u-ali', instructor_id: 'ip-1', start_at: at('09:00:00'), booking_date: at('09:00:00'), status: 'completed', price: 250000 });
  h.db.payments.push({ id: 'py-1', booking_id: 'bk-1', customer_id: 'u-ali', amount: 150000, receipt_code: 'AVD-101010-AAAAA', status: 'paid' });
  admin = (await h.login('boss', 'parol1234')).cookie;
});

afterEach(() => { globalThis.fetch = baseFetch; delete process.env.AVTODROM12_URL; delete process.env.RECEIPT_SHARED_KEY; });

async function boss(method: string, url: string, o: { token?: string; payload?: any } = {}) {
  const headers: Record<string, string> = { 'x-real-ip': `10.1.0.${++ipSeq}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  const r = await h.app.inject({ method, url, headers, payload: o.payload });
  let body: any = {};
  try { body = JSON.parse(r.payload); } catch { body = r.payload; }
  return { status: r.statusCode, body };
}
async function token() {
  await h.call('GET', '/api/admin/boss-link', { cookie: admin });
  const set = await h.call('POST', '/api/admin/boss-link', { cookie: admin, payload: { pin: '482915' } });
  const k = new URL(set.body.url).searchParams.get('k') || '';
  const login = await boss('POST', '/api/boss-login', { payload: { k, pin: '482915' } });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

/* 10-oktabr: Avtodrom tomonidagi yozuvlar */
function seed() {
  const A = h.db.admin_audit_logs;
  const row = (id: string, action: string, created_at: string, x: any = {}) =>
    A.push({ id, admin_id: 'u-admin', action, entity_type: 'bookings', entity_id: null, old_data: null, new_data: null, created_at, staff_id: null, staff_login: null, ...x });
  row('a-login', 'LOGIN', at('08:00:00'), { entity_type: 'staff' });                                    // shovqin
  row('a-auto', 'LESSON_AUTO_FINISHED', at('08:01:00'), { admin_id: null, entity_id: 'bk-1' });       // shovqin
  row('a-sale', 'RECEIPT_ISSUED', at('08:02:00'), { entity_type: 'payments', new_data: { amount: 250000, receipt_code: 'AVD-1' } }); // oddiy sotuv
  row('a-over', 'RECEIPT_ISSUED', at('09:30:00'), { entity_type: 'payments', entity_id: 'py-1', staff_login: 'kassa1',
    new_data: { amount: 150000, receipt_code: 'AVD-101010-AAAAA', register: 'P1', price_override: { total: 150000, expected: 250000 } } });
  row('a-sheet0', 'BOOKING_SHEET_SAVED', at('08:03:00'), { entity_type: 'admin_settings', new_data: { by: 'boss', created: [{ code: 'AVD-1' }], cancelled: [] } });
  row('a-sheet1', 'BOOKING_SHEET_SAVED', at('10:15:00'), { entity_type: 'admin_settings', new_data: { by: 'boss', date: D, cancelled: [{ code: 'AVD-7' }, { code: 'AVD-8' }] } });
  row('a-status', 'BOOKING_STATUS_CHANGED', at('11:00:00'), { entity_id: 'bk-1', old_data: { status: 'confirmed' }, new_data: { status: 'cancelled', reason: 'Mijoz kelmaydi' }, staff_login: 'boss' });
  row('a-set', 'SETTING_UPDATED', at('12:00:00'), { entity_type: 'admin_settings', old_data: null, new_data: { value: 270000, entity_key: 'rate_b' } });
  h.db.db_changes = [
    /* ilova amali bilan juft (o'sha kalit, 2 soniya farq) — alohida chiqmaydi */
    { id: 11, at: '2026-10-10T07:00:02.123456+00:00', tbl: 'admin_settings', op: 'U', row_id: 'rate_b', actor: 'l:boss', changes: { value: [{ value: 250000 }, { value: 270000 }] }, n_rows: 1 },
    /* faqat bazada: kassir to'lov summasini o'zgartirgan */
    { id: 12, at: '2026-10-10T08:20:00.000001+00:00', tbl: 'payments', op: 'U', row_id: 'py-1', actor: 's:st-k1', changes: { amount: [250000, 150000] }, n_rows: 1 },
    /* yopilgan bronda instruktor almashtirilgan, Telegram orqali */
    { id: 13, at: '2026-10-10T03:30:00+00:00', tbl: 'bookings', op: 'U', row_id: 'bk-1', actor: 'tg:777', changes: { instructor_id: [null, 'ip-1'] }, n_rows: 1 },
    /* o'chirilgan bron (nusxa bilan) */
    { id: 14, at: '2026-10-10T02:00:00+00:00', tbl: 'bookings', op: 'D', row_id: 'bk-gone', actor: null, changes: { id: 'bk-gone', customer_id: 'u-ali', start_at: at('07:00:00'), status: 'confirmed' }, n_rows: 1 },
    /* boshqa kun — chiqmaydi */
    { id: 15, at: '2026-10-11T08:00:00+00:00', tbl: 'payments', op: 'U', row_id: 'py-1', actor: null, changes: { amount: [1, 2] }, n_rows: 1 },
  ];
}

describe('Kim qildi — so‘rov konteksti', () => {
  it('xodim cookie’si audit (staff_login) va bazaga sarlavha (x-avt-actor) bo‘lib boradi', async () => {
    h.db.admin_settings.push({ key: 'rate_b', value: { value: 250000 }, updated_at: at('07:00:00') });
    const r = await h.call('PUT', '/api/admin/settings/rate_b', { cookie: admin, payload: { value: { value: 270000 } } });
    expect(r.status).toBe(200);
    const log = h.db.admin_audit_logs.find((x: any) => x.action === 'SETTING_UPDATED');
    expect(log?.staff_login).toBe('boss');
    const patch = actorHeaders.find((x) => x.method === 'PATCH' && x.table === 'admin_settings');
    expect(patch?.actor).toBe('l:boss');
  });

  it('kirmagan so‘rovda sarlavha yo‘q (tizim)', async () => {
    h.db.admin_settings.push({ key: 'rate_b', value: { value: 250000 } });
    await h.call('PUT', '/api/admin/settings/rate_b', { payload: { value: 1 } });   // 401
    expect(actorHeaders.filter((x) => x.table === 'admin_settings')).toHaveLength(0);
  });
});

describe('Tahrirlanganlar — /api/boss-edits', () => {
  it('tokensiz — 401', async () => {
    expect((await boss('GET', `/api/boss-edits?from=${D}&to=${D}`)).status).toBe(401);
  });

  it('shovqin yo‘q, juftlar birlashgan, nomlar va «eski → yangi» bor, eng yangisi birinchi', async () => {
    seed();
    const t = await token();
    const r = await boss('GET', `/api/boss-edits?from=${D}&to=${D}&limit=50`, { token: t });
    expect(r.status).toBe(200);
    const items = r.body.items;
    const avd = items.filter((x: any) => x.source === 'avtodrom');
    /* 8 audit − 4 shovqin (kirish, avto, oddiy sotuv, bekorsiz jadval) = 4; bazadan juftsiz 3 */
    expect(avd).toHaveLength(7);
    expect(r.body.totals).toMatchObject({ avtodrom: 7, avtodrom12: 3, total: 10 });
    expect(items.map((x: any) => x.at)).toEqual([...items.map((x: any) => x.at)].sort().reverse());
    expect(new Set(items.map((x: any) => x.id)).size).toBe(items.length);
    expect(avd.some((x: any) => /^a:a-(login|auto|sale|sheet0)$/.test(x.id))).toBe(false);

    const set = avd.find((x: any) => x.action === 'SETTING_UPDATED');
    expect(set.title).toBe('Narx · B toifa (1 soat)');
    expect(set.fields).toEqual([expect.objectContaining({ col: 'value', kind: 'money', old: 250000, new: 270000 })]);
    expect(set.actor).toBe('Bosh Admin');
    expect(set.money).toBe(true);
    expect(avd.some((x: any) => x.id === 'adb:000000000011')).toBe(false);   // juft — alohida emas

    const over = avd.find((x: any) => x.id === 'a:a-over');
    expect(over.action_label).toBe('Narx qo‘lda o‘zgartirildi');
    expect(over.fields[0]).toMatchObject({ col: 'price', old: 250000, new: 150000 });
    expect(over.actor).toBe('Nodira Kassir');
    expect(over.actor_role).toBe('kassir');

    const st = avd.find((x: any) => x.id === 'a:a-status');
    expect(st.title).toMatch(/^Ali Valiyev · 10\.10 09:00/);
    expect(st.fields[0]).toMatchObject({ col: 'status', kind: 'status', old: 'confirmed', new: 'cancelled' });
    expect(st.reason).toBe('Mijoz kelmaydi');
    expect(st.deleted).toBe(true);

    const pay = avd.find((x: any) => x.id === 'adb:000000000012');
    expect(pay.title).toBe('Chek AVD-101010-AAAAA · 150 000 so‘m');
    expect(pay.action_label).toBe('To‘lov tahrirlandi');
    expect(pay.fields[0]).toMatchObject({ label: 'Summa', kind: 'money', old: 250000, new: 150000 });
    expect(pay.money).toBe(true);

    const ins = avd.find((x: any) => x.id === 'adb:000000000013');
    expect(ins.fields[0]).toMatchObject({ col: 'instructor_id', new: 'ip-1', new_name: 'Aziz Karimov' });
    expect(ins.actor).toBe('Ali Valiyev');

    const del = avd.find((x: any) => x.id === 'adb:000000000014');
    expect(del.op).toBe('delete');
    expect(del.title).toMatch(/^Ali Valiyev · 10\.10 07:00/);
    expect(del.deleted).toBe(true);
    expect(del.actor).toBe(null);

    const sheet = avd.find((x: any) => x.id === 'a:a-sheet1');
    expect(sheet.note).toMatch(/2 ta bron bekor qilindi.*AVD-7, AVD-8/);

    const a12 = items.find((x: any) => x.id === 'log:9');
    expect(a12).toMatchObject({ source: 'avtodrom12', action_label: 'Xarajat tahrirlandi', title: 'Benzin', reason: 'Xarajat tahrirlandi' });
    expect(a12.fields[0]).toMatchObject({ label: 'Summa', kind: 'money' });

    expect(r.body.days).toEqual([{ day: D, n: 10, avtodrom: 7, avtodrom12: 3, deleted: 3 }]);
    expect(r.body.next_before).toBe(null);
  });

  it('sahifalash: ikkala manba birga, takrorsiz va bo‘shliqsiz', async () => {
    seed();
    const t = await token();
    const all: any[] = [];
    let cur: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await boss('GET', `/api/boss-edits?from=${D}&to=${D}&limit=5${cur ? `&before=${encodeURIComponent(cur)}` : ''}`, { token: t });
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(5);
      all.push(...r.body.items);
      cur = r.body.next_before;
      if (!cur) break;
    }
    expect(all).toHaveLength(10);
    expect(new Set(all.map((x) => x.id)).size).toBe(10);
    expect(all.map((x) => x.at)).toEqual([...all.map((x) => x.at)].sort().reverse());
  });

  it('manba filtri va avtodrom12 ishlamasa ham Avtodrom qismi chiqadi', async () => {
    seed();
    const t = await token();
    const only = await boss('GET', `/api/boss-edits?from=${D}&to=${D}&src=avtodrom12`, { token: t });
    expect(only.body.items.every((x: any) => x.source === 'avtodrom12')).toBe(true);
    expect(only.body.totals.avtodrom).toBe(0);
    const mine = await boss('GET', `/api/boss-edits?from=${D}&to=${D}&src=avtodrom`, { token: t });
    expect(mine.body.items.every((x: any) => x.source === 'avtodrom')).toBe(true);
    expect(bridgeUrls.filter((u) => u.includes('src='))).toHaveLength(0);

    a12Fail = true;
    const r = await boss('GET', `/api/boss-edits?from=${D}&to=${D}`, { token: t });
    expect(r.status).toBe(200);
    expect(r.body.totals.avtodrom).toBe(7);
    expect(r.body.sources.avtodrom12.ok).toBe(false);
  });

  it('db_changes jadvali hali yo‘q bo‘lsa ham ishlaydi (faqat ilova yozuvlari)', async () => {
    seed();
    delete (h.db as any).db_changes;
    const t = await token();
    const r = await boss('GET', `/api/boss-edits?from=${D}&to=${D}&src=avtodrom`, { token: t });
    expect(r.status).toBe(200);
    expect(r.body.totals.avtodrom).toBe(4);
  });
});

describe('yordamchilar', () => {
  it('usIso: PostgREST va Postgres vaqtlari bir xil ko‘rinishga keladi', () => {
    expect(usIso('2026-11-06T07:56:23.558586+00:00')).toBe('2026-11-06T07:56:23.558586Z');
    expect(usIso('2026-11-06T07:56:23+00:00')).toBe('2026-11-06T07:56:23.000000Z');
    expect(usIso('2026-11-06T07:56:23.5Z')).toBe('2026-11-06T07:56:23.500000Z');
    expect(usIso('2026-11-06T12:56:23.123+05:00')).toBe('2026-11-06T07:56:23.123000Z');
  });
  it('auditIsEdit: narx o‘zgarmagan chek va bekorsiz jadval — tahrir emas', () => {
    expect(auditIsEdit({ action: 'RECEIPT_ISSUED', new_data: { price_override: { total: 5, expected: 5 } } })).toBe(false);
    expect(auditIsEdit({ action: 'RECEIPT_ISSUED', new_data: { price_override: { total: 4, expected: 5 } } })).toBe(true);
    expect(auditIsEdit({ action: 'BOOKING_SHEET_SAVED', new_data: { cancelled: [] } })).toBe(false);
    expect(auditIsEdit({ action: 'LOGIN' })).toBe(false);
    expect(auditIsEdit({ action: 'SOMETHING_NEW' })).toBe(true);
  });
});
