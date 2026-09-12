/* KASSA — YURIB TURADIGAN SOAT
   Muammo: vaqt maydoni sahifa ochilganda bir marta to'ldirilar va
   qotib qolardi. Kassir oynani 16:30 da ochib qo'ysa, 17:11 da ham
   chek 16:30 bilan chiqar, bo'sh instruktorlar ham 16:30 ga qarab
   tekshirilardi.

   Tekshiramiz:
     1) ochilganda vaqt = hozir
     2) 40 daqiqa o'tsa vaqt o'zi yangilanadi
     3) vaqt yangilangach instruktorlar QAYTA so'raladi (yangi vaqt bilan)
     4) kassir qo'lda o'zgartirsa — soat tegmaydi («qo'lda» belgisi)
     5) «Hozir» tugmasi qaytaradi
     6) chek chiqarishda ANIQ hozirgi vaqt yuboriladi                       */
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
const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, timezoneId: 'Asia/Tashkent' });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(8000);

/* Soatni boshqaramiz: 2026-09-12 16:30 (Toshkent) dan boshlaymiz */
await page.clock.install({ time: new Date('2026-09-12T11:30:00Z') });
/* install() vaqtni to'xtatadi — sahifa esa setTimeout'larga tayanadi.
   resume() bilan vaqt yana odatdagidek yuradi, faqat boshlanish
   nuqtasi biz bergan payt bo'ladi. Sakrashlar — fastForward. */
await page.clock.resume();

await page.addInitScript(() => {
  const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const registers = [{ id: 'rg1', code: 'P1', name: 'Kassa P1' }];
  const me = { ok: true, login: 'kassir1', role: 'cashier', full_name: 'Kassir Bir', register: registers[0] };
  const instructor = { id: 'ip1', name: 'Shaxzod Ruziqulov', rating: 0, categories: ['A', 'B', 'C'] };
  const course = { id: 'cr1', name: 'B toifa amaliyot', category: 'B', duration_minutes: 60, price: 250000, is_active: true };
  window.__freeCalls = [];   // free-instructors qaysi vaqt bilan so'raldi
  window.__issued = null;    // chekka qanday start_at ketdi

  window.fetch = async (url, opt) => {
    const raw = String(url);
    const u = raw.split('?')[0];
    const qs = new URL(raw, 'http://x').searchParams;
    const m = (opt?.method || 'GET').toUpperCase();
    if (u === '/api/admin/me') return J(me);
    if (u === '/api/admin/login') return J(me);
    if (u === '/api/admin/registers') return J({ registers });
    if (/\/token$/.test(u)) return J({ token: 'tok.' + (Date.now() + 864e5), register: registers[0] });
    if (u === '/api/admin/courses') return J({ ok: true, courses: [course] });
    if (u === '/api/admin/cashier/free-instructors') {
      window.__freeCalls.push(qs.get('at'));
      return J({ ok: true, free: [instructor], busy: [], suggestion: instructor });
    }
    if (u === '/api/admin/cashier/issue' && m === 'POST') {
      window.__issued = JSON.parse(opt.body);
      return J({ ok: true, receipt: { code: 'AVD-260912-TEST', total: 250000 } });
    }
    return J({ ok: true, rows: [], items: [], bookings: [], list: [], data: [], registers, instructors: [], courses: [course], summary: {}, totals: {}, stats: {} });
  };
});
const errs = []; page.on('pageerror', e => errs.push(e.message));

const read = () => page.evaluate(() => ({
  date: document.getElementById('coDate')?.value,
  time: document.getElementById('coTime')?.value,
  tag: document.getElementById('coNowTag')?.textContent.trim(),
  manual: document.getElementById('coNowTag')?.classList.contains('manual'),
  calls: window.__freeCalls.slice(),
}));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1400);
/* Kassir hisobida kassa biriktirilgan bo'lsa ilova o'zi kiradi;
   rol ekrani chiqsa — P1 ni tanlab parol kiritamiz. */
const needLogin = await page.evaluate(() =>
  !document.querySelector('section.login')?.classList.contains('hidden'));
if (needLogin) {
  await page.click('.rolebtn[data-role="P1"]');
  await page.waitForTimeout(300);
  await page.fill('#loginUser', 'kassir1');
  await page.fill('#loginPass', '12345678');
  await page.click('#loginBtn');
  await page.waitForTimeout(1800);
} else {
  console.log('(kassir hisobi bilan to‘g‘ridan-to‘g‘ri kirdi)');
}
await page.click('.nav[data-p="checkout"]');
await page.waitForTimeout(900);
/* Bronsiz (walk-in) rejimga o'tamiz */
await page.evaluate(() => { if (typeof coSetMode === 'function') coSetMode('walk_in'); });
await page.waitForTimeout(800);

console.log('=== 1) OCHILGANDA ===');
let v = await read();
console.log('  sana:', v.date, '| vaqt:', v.time, v.time === '16:30' ? '✅' : '❌ kutilgan 16:30');
console.log('  belgi:', v.tag, v.manual ? '❌ qo‘lda' : '✅');
const firstCalls = v.calls.length;

console.log('\n=== 2) 41 DAQIQA O‘TDI (17:11) ===');
await page.clock.fastForward('41:00');
await page.waitForTimeout(600);
v = await read();
console.log('  vaqt:', v.time, v.time === '17:11' ? '✅ o‘zi yangilandi' : '❌ qotib qoldi');

console.log('\n=== 3) INSTRUKTORLAR QAYTA SO‘RALDIMI ===');
const last = v.calls[v.calls.length - 1];
const lastHH = last ? new Date(last).toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit' }) : '—';
console.log('  so‘rovlar soni:', firstCalls, '→', v.calls.length, v.calls.length > firstCalls ? '✅' : '❌');
console.log('  oxirgi so‘rov vaqti:', lastHH, lastHH === '17:11' ? '✅' : '❌ eski vaqt bilan so‘ralgan');

console.log('\n=== 4) KASSIR QO‘LDA O‘ZGARTIRDI ===');
await page.fill('#coTime', '09:00');
await page.dispatchEvent('#coTime', 'change');
await page.waitForTimeout(400);
await page.clock.fastForward('20:00');
await page.waitForTimeout(500);
v = await read();
console.log('  vaqt:', v.time, v.time === '09:00' ? '✅ tegilmadi' : '❌ ustidan yozib yubordi');
console.log('  belgi:', v.tag, v.manual ? '✅' : '❌');

console.log('\n=== 5) «HOZIR» TUGMASI ===');
await page.click('#coNowBtn');
await page.waitForTimeout(500);
v = await read();
console.log('  vaqt:', v.time, v.time === '17:31' ? '✅' : '❌ kutilgan 17:31');
console.log('  belgi:', v.tag, v.manual ? '❌' : '✅');

console.log('\n=== 6) CHEKDAGI VAQT ===');
await page.clock.fastForward('04:20');          // 17:35:20
await page.waitForTimeout(500);
/* Formani haqiqiy tugmalar orqali to'ldiramiz */
await page.fill('#coName', 'Test Mijoz');
const insBtn = await page.$('#coInsBox [data-ins]');
if (insBtn) await insBtn.click();
await page.waitForTimeout(500);
await page.click('[data-paytype="cash"]');
await page.waitForTimeout(400);
const before = await page.evaluate(() => ({
  amount: document.getElementById('coAmount')?.value,
  time: document.getElementById('coTime')?.value,
}));
console.log('  forma: summa', before.amount, '| maydondagi vaqt', before.time);
await page.click('#coIssue');
await page.waitForTimeout(1200);
const sent = await page.evaluate(() => window.__issued);
if (sent && sent.start_at) {
  const hhmm = new Date(sent.start_at).toLocaleTimeString('en-GB',
    { timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log('  chekka yozilgan vaqt:', hhmm,
    hhmm.startsWith('17:35') ? '✅ aniq hozirgi payt' : '❌ eski/yaxlitlangan');
} else {
  const msg = await page.evaluate(() => document.getElementById('coErr')?.textContent
    || document.querySelector('#checkout .error')?.textContent || '(sabab noma\u2019lum)');
  console.log('  ❌ chek yuborilmadi:', String(msg).trim().slice(0, 90));
}

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 6).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
