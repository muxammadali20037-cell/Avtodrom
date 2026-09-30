/**
 * ESLATMALAR (60 / 30 / 20 daqiqa) VA KECHIKISH QOIDASI (15 daqiqa).
 * Mijoz kelmasa bron o'z-o'zidan yopiladi — «tasdiqlangan» bo'lib qolib ketmaydi.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { makeHarness, type Harness } from './harness.js';
import { hashPassword } from '../backend/src/staff-auth.js';

let h: Harness;
let admin = '';
const CUST_TG = 555101, INS_TG = 880101;
const min = (m: number) => new Date(Date.now() + m * 60000).toISOString();
const cron = () => h.app.inject({ method: 'GET', url: '/api/cron/reminders', headers: { authorization: 'Bearer test-cron-secret' } })
  .then((r: any) => JSON.parse(r.body));

function bk(id: string, startMin: number, o: any = {}) {
  const start = min(startMin);
  h.db.bookings.push({ id, customer_id: 'u-mijoz', instructor_id: 'ip-1', course_id: 'c-b', start_at: start, booking_date: start,
    end_at: new Date(Date.parse(start) + 3600e3).toISOString(), status: 'confirmed', source: 'app', pickup_code: `AVD-${id.slice(-4)}`,
    created_at: min(-3 * 24 * 60), ...o });
}
const st = (id: string) => h.db.bookings.find((b: any) => b.id === id)?.status;

beforeAll(async () => { h = await makeHarness(); });
beforeEach(async () => {
  h.reset();
  h.db.staff.push({ id: 'st-admin', login: 'boss', password_hash: hashPassword('admin1234'), role: 'admin', register_id: null, is_active: true });
  h.db.users.push({ id: 'u-admin', full_name: 'Admin', role: 'admin', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-mijoz', full_name: 'Ali Valiyev', phone: '+998901112233', telegram_id: CUST_TG, role: 'customer', is_active: true, is_blocked: false });
  h.db.users.push({ id: 'u-instr', full_name: 'Aziz Karimov', phone: '+998901114455', telegram_id: INS_TG, role: 'instructor', is_active: true, is_blocked: false });
  h.db.instructor_profiles.push({ id: 'ip-1', user_id: 'u-instr', is_verified: true, is_available: true, categories: ['B'] });
  h.db.courses.push({ id: 'c-b', name: 'B kategoriya', category: 'B', price: 250000, duration_minutes: 60, is_active: true });
  admin = (await h.login('boss', 'admin1234')).cookie;
});

describe('Eslatmalar: 1 soat, 30 daqiqa, 20 daqiqa', () => {
  it('uchala eslatma o‘z vaqtida, har biri bir marta; ichida 15 daqiqa ogohlantirishi', async () => {
    const ts = (h.telegram as any[]);
    const { sendDueReminders } = await import('../backend/src/reminders.js');
    bk('b-0001', 70);
    const T = (m: number) => Date.now() + m * 60000;              // «hozir» ni suramiz
    expect((await sendDueReminders(T(0))).sent).toBe(0);           // 70 daq — hali erta
    expect((await sendDueReminders(T(11))).sent).toBe(1);          // 59 daq → 60
    expect((await sendDueReminders(T(12))).sent).toBe(0);          // takror yo'q
    expect((await sendDueReminders(T(41))).sent).toBe(1);          // 29 daq → 30
    expect((await sendDueReminders(T(51))).sent).toBe(1);          // 19 daq → 20
    expect((await sendDueReminders(T(52))).sent).toBe(0);
    expect(h.db.booking_reminders.map((r: any) => r.kind).sort()).toEqual([20, 30, 60]);
    const msgs = ts.filter((m) => m.chat === CUST_TG).map((m) => m.text);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toMatch(/1 soat qoldi/);
    expect(msgs[2]).toMatch(/1[89] daqiqa qoldi/);
    for (const t of msgs) expect(t).toMatch(/15 daqiqa kechiksangiz, bron avtomatik bekor qilinadi/);
  });

  it('sozlamadan o‘zgartiriladi (90 va 20 daqiqa, kechikish 10)', async () => {
    h.db.admin_settings.push({ key: 'reminder_minutes', value: '90, 20' }, { key: 'late_cancel_min', value: { value: 10 } });
    const { loadReminderConfig, sendDueReminders } = await import('../backend/src/reminders.js');
    expect(await loadReminderConfig()).toEqual({ kinds: [90, 20], lateMin: 10 });
    bk('b-0002', 85);
    const r = await sendDueReminders();
    expect(r.sent).toBe(1);
    expect(h.db.booking_reminders[0].kind).toBe(90);
    expect(h.telegram.at(-1)!.text).toMatch(/10 daqiqa kechiksangiz/);
  });

  it('bron tasdiqlanganda mijozga ham qoida yoziladi', async () => {
    bk('b-0003', 24 * 60, { status: 'pending' });
    const r = await h.call('PATCH', '/api/admin/bookings/b-0003/status', { cookie: admin, payload: { status: 'confirmed' } });
    expect(r.status).toBe(200);
    const m = (h.telegram as any[]).filter((x) => x.chat === CUST_TG).at(-1);
    expect(m.text).toMatch(/tasdiqlandi/);
    expect(m.text).toMatch(/15 daqiqa kechiksangiz/);
  });
});

describe('15 daqiqa kechikish — bron avtomatik yopiladi', () => {
  it('tasdiqlangan → «kelmagan», kutilayotgan → «bekor»; mijoz va instruktorga xabar', async () => {
    bk('b-late', -16);                                   // 16 daqiqa oldin boshlanishi kerak edi
    bk('b-pend', -20, { status: 'pending' });
    bk('b-ok', -10);                                     // hali 15 daqiqa o'tmagan
    bk('b-run', -30, { status: 'in_progress', arrived_at: min(-29) });
    const r = await cron();
    expect(r.late_closed).toBe(2);
    expect(st('b-late')).toBe('no_show');
    expect(st('b-pend')).toBe('cancelled');
    expect(h.db.bookings.find((b: any) => b.id === 'b-pend').cancellation_reason).toMatch(/15 daqiqa/);
    expect(st('b-ok')).toBe('confirmed');
    expect(st('b-run')).toBe('in_progress');
    const cust = (h.telegram as any[]).filter((m) => m.chat === CUST_TG);
    expect(cust).toHaveLength(2);
    expect(cust[0].text).toMatch(/Broningiz bekor qilindi/);
    expect(cust[0].text).toMatch(/15 daqiqa o‘tdi/);
    expect((h.telegram as any[]).filter((m) => m.chat === INS_TG)[0].text).toMatch(/Mijoz kelmadi/);
    expect(h.db.notifications.some((n: any) => /bekor qilindi/.test(n.title))).toBe(true);
    expect(h.db.admin_audit_logs.filter((a: any) => a.action === 'BOOKING_AUTO_LATE')).toHaveLength(2);
    // Qayta ishga tushsa — hech narsa takrorlanmaydi
    const n0 = h.telegram.length;
    expect((await cron()).late_closed).toBe(0);
    expect(h.telegram.length).toBe(n0);
    // Holat oxirgi ishga tushishda yozib qo'yiladi
    expect(h.db.admin_settings.find((x: any) => x.key === 'reminders_last_run')?.value?.late_closed).toBe(0);
  });

  it('eski (25-sentabrdagi kabi) bronlar jimgina yopiladi — xabar ketmaydi', async () => {
    bk('b-old1', -5 * 24 * 60);
    bk('b-old2', -4 * 60);
    const r = await cron();
    expect(r.late_closed).toBe(2);
    expect(st('b-old1')).toBe('no_show');
    expect(h.telegram.filter((m: any) => m.chat === CUST_TG)).toHaveLength(0);
  });

  it('kassada «hozir» chiqarilgan chek (bron emas) 15 daqiqada yopilmaydi, ertasi kuni tozalanadi', async () => {
    bk('b-walk', -40, { source: 'walk_in', created_at: min(-40) });          // mijoz joyida, skaner kutilmoqda
    bk('b-walkold', -26 * 60, { source: 'walk_in', created_at: min(-26 * 60) });
    bk('b-pkg', -20, { source: 'walk_in', created_at: min(-2 * 24 * 60) });  // paketning keyingi mashg'uloti — bron
    await cron();
    expect(st('b-walk')).toBe('confirmed');
    expect(st('b-walkold')).toBe('no_show');
    expect(st('b-pkg')).toBe('no_show');
  });

  it('TO‘LANGAN bron 15 daqiqada yopilmaydi — instruktor chekni kechroq skanerlashi mumkin; dars tugagach 12 soatdan keyin jimgina yopiladi', async () => {
    h.db.cash_registers.push({ id: 'reg-p1', code: 'P1', name: '1-kassa' });
    bk('b-paid', -30);                                    // 30 daqiqa oldin boshlanishi kerak edi, to'langan
    bk('b-paid-old', -14 * 60);                          // kecha to'langan, dars 13 soat oldin tugagan
    bk('b-free', -30);                                   // to'lanmagan — odatdagidek yopiladi
    const pay = (id: string, code: string) => h.db.payments.push({ id: 'p-' + id, booking_id: id, customer_id: 'u-mijoz', amount: 250000, method: 'cash', status: 'paid',
      paid_at: min(-60 * 24), receipt_code: code, register_id: 'reg-p1', cash_amount: 250000, card_amount: 0 });
    pay('b-paid', 'AVD-1'); pay('b-paid-old', 'AVD-2');
    const r = await cron();
    expect(st('b-paid')).toBe('confirmed');               // to'langan — ochiq qoladi
    expect(st('b-free')).toBe('no_show');
    expect(st('b-paid-old')).toBe('no_show');             // 12 soat o'tdi — yopildi
    expect(h.db.bookings.find((b: any) => b.id === 'b-paid-old').status).toBe('no_show');
    expect(r.late_closed).toBe(2);
    expect(h.db.payments.every((p: any) => p.status === 'paid')).toBe(true);   // pul kassa hisobotida qoladi
    // To'langan bronning yopilishi haqida mijozga xabar KETMAYDI (u kelmagan emas — dars boshlanmagan)
    const cust = (h.telegram as any[]).filter((m) => m.chat === CUST_TG && /bekor qilindi/.test(m.text));
    expect(cust).toHaveLength(1);                         // faqat b-free uchun
  });

  it('eslatma tugmasi — faqat Mini App (callback tugmalar webhook Vercel emasligida ishlamaydi)', async () => {
    const { reminderKeyboard } = await import('../backend/src/reminders.js');
    process.env.CUSTOMER_MINI_APP_URL = 'https://avtodrom.vercel.app/';
    delete process.env.REMINDER_CALLBACKS;
    const kb: any = reminderKeyboard('b-1');
    expect(kb.inline_keyboard.flat().every((b: any) => b.web_app && !b.callback_data)).toBe(true);
    process.env.REMINDER_CALLBACKS = '1';
    const kb2: any = reminderKeyboard('b-1');
    expect(kb2.inline_keyboard.flat().some((b: any) => b.callback_data === 'come:b-1')).toBe(true);
    delete process.env.REMINDER_CALLBACKS;
  });

  it('kechikish qoidasi o‘chirilsa (0) — hech narsa yopilmaydi', async () => {
    h.db.admin_settings.push({ key: 'late_cancel_min', value: 0 });
    bk('b-x', -60);
    expect((await cron()).late_closed).toBe(0);
    expect(st('b-x')).toBe('confirmed');
  });

  it('panel «tick»i ham yopadi; admin tekshiruvi qoidani ko‘rsatadi', async () => {
    const { _resetTickForTests } = await import('../backend/src/reminders.js');
    _resetTickForTests();
    bk('b-t', -20);
    const t = await h.call('POST', '/api/admin/reminders/tick', { cookie: admin });
    expect(t.body.ran).toBe(true);
    expect(t.body.late_closed).toBe(1);
    const c = await h.call('GET', '/api/admin/reminder-check', { cookie: admin });
    expect(c.body.summary).toMatch(/60, 30, 20 daqiqa/);
    expect(c.body.summary).toMatch(/15 daqiqa kechiksa/);
    expect(c.body.checks.map((x: any) => x.name)).toContain('Vaqti o‘tgan ochiq bronlar');
  });
});
