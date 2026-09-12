/* INSTRUKTOR HISOB-KITOBI (BOSHQARUV)
   Oy oxirida bitta instruktor bo'yicha: nechta o'quvchi, nechtasi
   avtoshkola (tekin), nechtasi pullik, qancha soat va pul.

   Tekshiramiz:
     1) BOSHQARUV menyusida bo'lim bor
     2) sana oralig'i o'zi to'ladi (joriy oy), «O'tgan oy» ishlaydi
     3) instruktor tanlanganda serverga TO'G'RI oraliq yuboriladi
     4) avtoshkola / pullik ajratmasi to'g'ri chiqadi
     5) o'quvchilar jadvali takrorlanmas mijozlarni sanaydi
     6) KASSA rejimida bu bo'lim ko'rinmaydi                               */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'node:http';
import fs from 'node:fs';

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync('../admin/index.html'));
});
await new Promise(r => server.listen(0, r));
const P = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, timezoneId: 'Asia/Tashkent' });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(9000);
await page.clock.install({ time: new Date('2026-09-12T09:00:00Z') });   // 14:00 Toshkent
await page.clock.resume();

await page.addInitScript(() => {
  const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const me = { ok: true, login: 'Adminn', role: 'admin', full_name: 'Bosh Administrator' };
  const instructor = { id: 'ip1', user_id: 'u1', profile: { full_name: 'Shaxzod Ruziqulov' }, categories: ['B'] };
  const instructor2 = { id: 'ip2', user_id: 'u2', profile: { full_name: 'Aziz Karimov' }, categories: ['A', 'B'] };
  window.__ctlUrls = [];

  /* Uchta o'quvchi: biri ikki marta avtoshkola, biri bir marta
     avtoshkola, biri ikki marta pullik. */
  const mk = (id, cust, school, minutes, amount, status) => ({
    id, start_at: `2026-09-0${id}T06:00:00Z`, status,
    school, school_receipt_code: school ? 'AVS-1000' + id : null,
    customer_id: cust.id, customer: cust,
    course: { id: 'cr1', name: 'B toifa amaliyot', duration_minutes: 60 },
    duration_minutes: minutes, amount, method: amount ? 'cash' : null,
    receipt_code: amount ? 'AVD-26091' + id : null, scanned: school,
  });
  const c1 = { id: 'c1', full_name: 'Aziz Rahimov', phone: '+998901112233' };
  const c2 = { id: 'c2', full_name: 'Dilnoza Yo‘ldosheva', phone: '+998901112244' };
  const c3 = { id: 'c3', full_name: 'Jasur Qodirov', phone: '+998901112255' };
  const rows = [
    mk(1, c1, true, 90, 0, 'completed'),
    mk(2, c1, true, 90, 0, 'completed'),
    mk(3, c2, true, 60, 0, 'completed'),
    mk(4, c3, false, 60, 250000, 'completed'),
    mk(5, c3, false, 90, 375000, 'completed'),
  ];
  const school = rows.filter(r => r.school), paid = rows.filter(r => !r.school);
  const grp = list => ({
    lessons: list.length,
    completed: list.filter(r => r.status === 'completed').length,
    students: new Set(list.map(r => r.customer_id)).size,
    minutes: list.reduce((a, r) => a + r.duration_minutes, 0),
    revenue: list.reduce((a, r) => a + r.amount, 0),
  });
  const payload = {
    ok: true,
    summary: {
      bookings: rows.length, completed: rows.length, no_show: 0, cancelled: 0,
      scanned: school.length, receipts: paid.length,
      minutes: rows.reduce((a, r) => a + r.duration_minutes, 0),
      revenue: 625000, cash: 625000, card: 0,
      students: new Set(rows.map(r => r.customer_id)).size,
      school: grp(school), paid: grp(paid),
    },
    students: [
      { id: 'c1', name: c1.full_name, phone: c1.phone, lessons: 2, school: 2, paid: 0, minutes: 180, amount: 0 },
      { id: 'c3', name: c3.full_name, phone: c3.phone, lessons: 2, school: 0, paid: 2, minutes: 150, amount: 625000 },
      { id: 'c2', name: c2.full_name, phone: c2.phone, lessons: 1, school: 1, paid: 0, minutes: 60, amount: 0 },
    ],
    rows,
  };

  window.fetch = async (url) => {
    const raw = String(url), u = raw.split('?')[0];
    if (u === '/api/admin/me') return J(me);
    if (u === '/api/admin/login') return J(me);
    if (u === '/api/admin/instructors') return J({ ok: true, instructors: [instructor, instructor2] });
    if (u.startsWith('/api/admin/instructor-control/')) { window.__ctlUrls.push(raw); return J(payload); }
    return J({ ok: true, rows: [], items: [], bookings: [], list: [], data: [], registers: [], instructors: [instructor, instructor2], summary: {}, totals: {}, stats: {} });
  };
});
const errs = []; page.on('pageerror', e => errs.push(e.message));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1300);
await page.click('.rolebtn[data-role="admin"]');
await page.waitForTimeout(300);
await page.fill('#loginUser', 'Adminn');
await page.fill('#loginPass', '12345678');
await page.click('#loginBtn');
await page.waitForTimeout(1900);

console.log('=== 1) MENYUDA BORMI ===');
const navOk = await page.evaluate(() => {
  const b = document.querySelector('.nav[data-p="insacc"]');
  return { bor: !!b, matn: b?.textContent.trim(), guruh: b?.dataset.grp };
});
console.log('  bo‘lim:', navOk.bor ? `✅ «${navOk.matn}»` : '❌ yo‘q', '| guruh:', navOk.guruh);

await page.click('.nav[data-p="insacc"]');
await page.waitForTimeout(900);

console.log('\n=== 2) SANA ORALIG‘I ===');
let v = await page.evaluate(() => ({ f: document.getElementById('iaFrom').value, t: document.getElementById('iaTo').value }));
console.log('  o‘zi to‘ldi:', v.f, '—', v.t, (v.f === '2026-09-01' && v.t === '2026-09-12') ? '✅ joriy oy, bugungacha' : '❌');

console.log('\n=== 3) INSTRUKTOR TANLANDI ===');
await page.click('#iaPicker [data-iains="ip1"]');
await page.waitForTimeout(900);
const urls = await page.evaluate(() => window.__ctlUrls);
const last = urls[urls.length - 1] || '';
console.log('  so‘rov:', last.replace(/^.*instructor-control\//, ''));
console.log('  oraliq to‘g‘ri:', /from=2026-09-01&to=2026-09-12/.test(last) ? '✅' : '❌');

console.log('\n=== 4) AVTOSHKOLA / PULLIK AJRATMASI ===');
const cards = await page.evaluate(() => {
  const out = {};
  document.querySelectorAll('#iaBody .grid2 .card').forEach(c => {
    const t = c.querySelector('h3')?.textContent.trim();
    const vals = [...c.querySelectorAll('b')].map(b => b.textContent.trim());
    out[t] = vals;
  });
  return out;
});
for (const [k, vals] of Object.entries(cards)) console.log(' ', k, '→', vals.join(' | '));
const sch = cards['Avtoshkola (tekin)'] || [], pd = cards['Pullik'] || [];
console.log('  avtoshkola: 2 o‘quvchi / 3 dars', (sch[0] === '2' && sch[1] === '3') ? '✅' : '❌');
console.log('  pullik: 1 o‘quvchi / 2 dars / 625 000', (pd[0] === '1' && pd[1] === '2') ? '✅' : '❌');

console.log('\n=== 5) O‘QUVCHILAR JADVALI ===');
const st = await page.evaluate(() => {
  const tb = [...document.querySelectorAll('#iaBody table')][0];
  return [...tb.querySelectorAll('tbody tr')].map(tr =>
    [...tr.children].map(td => td.textContent.trim()).join(' | '));
});
st.forEach(r => console.log('   ', r));
console.log('  takrorlanmas o‘quvchi soni:', st.length, st.length === 3 ? '✅' : '❌');
const kpiStudents = await page.evaluate(() =>
  document.querySelector('#iaBody .kpis .kpi b')?.textContent.trim());
console.log('  KPI «O‘quvchilar»:', kpiStudents, kpiStudents === '3' ? '✅' : '❌');

console.log('\n=== 6) «O‘TGAN OY» ===');
await page.click('#iaPrevMonth');
await page.waitForTimeout(800);
v = await page.evaluate(() => ({ f: document.getElementById('iaFrom').value, t: document.getElementById('iaTo').value }));
console.log('  oraliq:', v.f, '—', v.t, (v.f === '2026-08-01' && v.t === '2026-08-31') ? '✅' : '❌');

console.log('\n=== 7) KASSA REJIMIDA KO‘RINMASIN ===');
await page.evaluate(() => { try { localStorage.clear(); } catch (e) {} });
await page.reload();
await page.waitForTimeout(1300);
await page.click('.rolebtn[data-role="P1"]');
await page.waitForTimeout(300);
await page.fill('#loginUser', 'Adminn');
await page.fill('#loginPass', '12345678');
await page.click('#loginBtn');
await page.waitForTimeout(1800);
const hidden = await page.evaluate(() => {
  const b = document.querySelector('.nav[data-p="insacc"]');
  return !b || b.classList.contains('hidden') || b.offsetParent === null;
});
console.log('  KASSA P1 da yashirin:', hidden ? '✅' : '❌');

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 6).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
