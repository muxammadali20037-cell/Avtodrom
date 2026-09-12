/* INSTRUKTORGA AVTOMOBIL RAQAMI
   Muammo: avtoshkola QR cheki skanerlanganda «Avtomobil raqami
   topilmadi» chiqardi va avtodrom12 da sessiya ochilmasdi. Xabar
   «Instruktorlar bo'limiga qo'ying» derdi — lekin Avtodrom panelida
   bunday maydon umuman yo'q edi.

   Tekshiramiz:
     1) jadvalda «Avtomobil» ustuni bor, raqamsiz instruktor
        qizil «yo'q» bilan belgilanadi
     2) tahrirlash oynasida raqam va rusum maydonlari bor
     3) saqlashda serverga vehicle_plate / vehicle_model ketadi
     4) mavjud qiymat formaga to'ldirilgan holda chiqadi            */
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
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(9000);

await page.addInitScript(() => {
  const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const me = { ok: true, login: 'Adminn', role: 'admin', full_name: 'Administrator' };
  const A = { id: 'ip1', user_id: 'u1', full_name: 'Shaxzod Ruziqulov',
    profile: { id: 'u1', full_name: 'Shaxzod Ruziqulov', phone: '+998901112233' },
    categories: ['B'], experience_years: 5, rating: 0, active: true, is_verified: true,
    vehicle_plate: '01 111 QQQ', vehicle_model: 'Chevrolet Cobalt' };
  const B = { id: 'ip2', user_id: 'u2', full_name: 'Aziz Karimov',
    profile: { id: 'u2', full_name: 'Aziz Karimov', phone: '+998901112244' },
    categories: ['A', 'B'], experience_years: 2, rating: 0, active: true, is_verified: true,
    vehicle_plate: null, vehicle_model: null };     // raqamsiz
  window.__patch = null;
  window.fetch = async (url, opt) => {
    const u = String(url).split('?')[0];
    const m = (opt?.method || 'GET').toUpperCase();
    if (u === '/api/admin/me') return J(me);
    if (u === '/api/admin/login') return J(me);
    if (u === '/api/admin/instructors') return J({ ok: true, instructors: [A, B] });
    if (u.startsWith('/api/admin/instructors/') && m === 'PATCH') {
      window.__patch = JSON.parse(opt.body);
      return J({ ok: true, not_saved: [] });
    }
    return J({ ok: true, rows: [], items: [], bookings: [], list: [], data: [], registers: [], instructors: [A, B], summary: {}, totals: {}, stats: {} });
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
await page.click('.nav[data-p="instructors"]');
await page.waitForTimeout(900);

console.log('=== 1) JADVALDAGI «AVTOMOBIL» USTUNI ===');
const tbl = await page.evaluate(() => {
  const heads = [...document.querySelectorAll('#instructors thead th')].map(t => t.textContent.trim());
  const rows = [...document.querySelectorAll('#instRows tr')].map(tr =>
    [...tr.children].map(td => td.textContent.trim().replace(/\s+/g, ' ')));
  return { heads, rows };
});
console.log('  sarlavhalar:', tbl.heads.join(' | '));
console.log('  «Avtomobil» ustuni:', tbl.heads.includes('Avtomobil') ? '✅' : '❌');
tbl.rows.forEach(r => console.log('   ', r.slice(0, 3).join(' | ')));
const bosh = tbl.rows.find(r => /Aziz Karimov/.test(r[0]));
console.log('  raqamsiz instruktor belgilandi:', bosh && /yo‘q/.test(bosh[2]) ? '✅' : '❌');

console.log('\n=== 2) TAHRIRLASH OYNASI ===');
await page.click('[data-insedit="ip1"]');
await page.waitForTimeout(700);
let f = await page.evaluate(() => ({
  plate: document.getElementById('iePlate')?.value,
  model: document.getElementById('ieModel')?.value,
  bor: !!document.getElementById('iePlate') && !!document.getElementById('ieModel'),
}));
console.log('  maydonlar bor:', f.bor ? '✅' : '❌');
console.log('  mavjud qiymat to‘ldirildi:', f.plate === '01 111 QQQ' && f.model === 'Chevrolet Cobalt' ? '✅' : `❌ ${f.plate} / ${f.model}`);

console.log('\n=== 3) SAQLASH ===');
await page.fill('#iePlate', '01 A 555 AA');
await page.fill('#ieModel', 'Cobalt');
await page.click('#ieSave');
await page.waitForTimeout(900);
const sent = await page.evaluate(() => window.__patch);
console.log('  serverga ketdi:', sent ? JSON.stringify({ p: sent.vehicle_plate, m: sent.vehicle_model }) : '❌ yuborilmadi');
console.log('  vehicle_plate:', sent?.vehicle_plate === '01 A 555 AA' ? '✅' : '❌');
console.log('  vehicle_model:', sent?.vehicle_model === 'Cobalt' ? '✅' : '❌');

console.log('\n=== 4) RAQAMSIZ INSTRUKTOR ===');
await page.waitForTimeout(500);
await page.click('[data-insedit="ip2"]');
await page.waitForTimeout(700);
f = await page.evaluate(() => ({ plate: document.getElementById('iePlate')?.value }));
console.log('  maydon bo‘sh chiqdi:', f.plate === '' ? '✅' : `❌ "${f.plate}"`);

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 5).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
