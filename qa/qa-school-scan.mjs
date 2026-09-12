/* AVTODROM INSTRUKTOR PANELI — avtoshkola QR chekini skanerlash.
   Chek avtodrom12 da chiqariladi (AVD-1234), shu yerda skanerlanadi.
   Tekshiramiz: kod tanib olinadi, "SHKOLA" belgisi chiqadi, narx
   ko'rsatilmaydi, dars boshlanadi va ro'yxatda ko'rinadi, yakunlanadi.
   Avtodrom ning O'Z cheki (AVD-260901-6KBCQ) ham avvalgidek ishlaydi. */
import pw from '/home/claude/.npm-global/lib/node_modules/playwright/index.js';
const { chromium } = pw;
import http from 'node:http';
import fs from 'node:fs';

const server = http.createServer((q, r) => {
  r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  r.end(fs.readFileSync('../instructor/index.html'));
});
await new Promise(r => server.listen(0, r));
const P = server.address().port;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(8000);

await page.addInitScript(() => {
  /* Telegram Mini App muhitini taqlid qilamiz (skaner popupsiz) */
  window.Telegram = { WebApp: {
    initData: 'fake-init-data', version: '6.0', ready() {}, expand() {}, close() {},
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {} },
    MainButton: { hide() {}, show() {} },
    themeParams: {},
  } };

  window.__scanCalls = [];
  window.__started = [];
  window.__finished = [];
  window.__bookings = [];
  const J = (o, st) => new Response(JSON.stringify(o), { status: st || 200, headers: { 'content-type': 'application/json' } });

  /* avtodrom12 da chiqarilgan chek */
  const school = { code: 'AVD-1001', status: 'issued', student_name: 'Aziz Rahimov', student_phone: '+998901112233',
                   school_name: 'TASH INDEX', group_name: 'A-1', planned_minutes: 90, free: true };

  window.fetch = async (url, opt) => {
    const u = String(url).split('?')[0];
    const m = (opt?.method || 'GET').toUpperCase();
    if (u === '/api/instructor/registration') return J({ ok: true, registration: { status: 'APPROVED' } });
    if (u === '/api/instructor/me') return J({ ok: true,
      profile: { id: 'u9', first_name: 'Shaxzod', last_name: 'Ruziqulov', phone: '+998901234567' },
      instructor: { id: 'ip-77', is_available: true, is_verified: true, vehicle_plate: '01 111QQQ', categories: ['B'] } });
    if (u === '/api/instructor/bookings') return J({ ok: true, bookings: window.__bookings });
    if (u === '/api/instructor/stats' || u === '/api/instructor/statistics') return J({ ok: true, stats: {}, totals: {} });
    if (u === '/api/instructor/report') return J({ ok: true, rows: [], totals: {} });

    if (u === '/api/instructor/scan' && m === 'POST') {
      const code = JSON.parse(opt.body).code;
      window.__scanCalls.push(code);
      if (/^AVD-\d{4,5}$/.test(code)) {
        if (school.status === 'scanned') return J({ ok: false, error: 'Bu chek allaqachon ishlatilgan (Shaxzod Ruziqulov)' }, 409);
        return J({ ok: true, school_lesson: true, receipt_code: code, can_start: true, can_finish: false, already: null,
          booking: { id: null, school_lesson: true, receipt_code: code, status: 'confirmed', duration_minutes: 90,
            price: 0, is_free: true, customer: { full_name: school.student_name, phone: school.student_phone },
            school_name: school.school_name, group_name: school.group_name, course: { name: 'Avtoshkola amaliyoti' } } });
      }
      /* Avtodrom ning o'z cheki */
      return J({ ok: true, receipt_code: code, can_start: true, can_finish: false, already: null,
        booking: { id: 'bk-own', status: 'confirmed', start_at: new Date().toISOString(), duration_minutes: 60,
          price: 250000, customer: { full_name: 'Jasur Qodirov', phone: '+998901234567' }, course: { name: 'B toifa amaliyot' } } });
    }

    if (u === '/api/instructor/scan/start' && m === 'POST') {
      const code = JSON.parse(opt.body).code;
      window.__started.push(code);
      if (/^AVD-\d{4,5}$/.test(code)) {
        school.status = 'scanned';
        const b = { id: 'bk-school', customer_id: 'c1', instructor_id: 'ip-77', status: 'in_progress',
          source: 'avtodrom12', school_receipt_code: code, duration_minutes: 90,
          start_at: new Date().toISOString(), booking_date: new Date().toISOString(),
          end_at: new Date(Date.now() + 90 * 60000).toISOString(),
          customer: { full_name: school.student_name, phone: school.student_phone },
          customer_note: `Avtoshkola · ${school.school_name} · ${school.group_name} · chek ${code} · to‘lovsiz` };
        window.__bookings = [b];
        return J({ ok: true, school_lesson: true, booking: b });
      }
      return J({ ok: true, booking: { id: 'bk-own', status: 'in_progress' } });
    }

    if (/\/api\/instructor\/bookings\/[^/]+\/departed$/.test(u)) {
      window.__finished.push(u.split('/')[4]);
      window.__bookings = window.__bookings.map(b => ({ ...b, status: 'completed' }));
      return J({ ok: true, booking: { id: 'bk-school', status: 'completed' } });
    }
    return J({ ok: true });
  };
});
const errs = []; page.on('pageerror', e => errs.push(e.message));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1800);

const boot = await page.evaluate(() => ({
  nav: !document.getElementById('nav').classList.contains('hide'),
  greet: document.getElementById('greet')?.textContent,
  scanBtn: !!document.getElementById('scanBtn'),
}));
console.log('=== PANEL ===');
console.log('  ochildi:', boot.nav ? '✅' : '❌', '|', boot.greet, '| skaner tugmasi:', boot.scanBtn ? '✅' : '❌');

/* --- 1) Avtoshkola cheki: qo'lda kod (4 xonali) --- */
console.log('\n=== 1) AVTOSHKOLA CHEKI (AVD-1001) ===');
await page.click('#scanBtn');            // Telegram skaneri yo'q → qo'lda kiritish
await page.waitForTimeout(500);
const manual = await page.evaluate(() => ({
  has: !!document.getElementById('mcInput'),
  ph: document.getElementById('mcInput')?.placeholder,
  sub: document.querySelector('#sheet .sub')?.textContent,
}));
console.log('  qo\'lda kiritish:', manual.has ? '✅' : '❌', '|', manual.ph);
console.log(' ', manual.sub);

await page.fill('#mcInput', '1001');     // faqat raqam yozsa ham topilishi kerak
await page.click('#mcYes');
await page.waitForTimeout(700);
const res = await page.evaluate(() => ({
  sent: window.__scanCalls,
  text: document.getElementById('sheet')?.innerText.replace(/\s+/g, ' '),
  badge: !!document.querySelector('#sheet .st-pill[style*="0f7b3f"]'),
  startBtn: document.getElementById('scStart')?.textContent?.trim(),
}));
console.log('  serverga yuborilgan kod:', JSON.stringify(res.sent), res.sent[0] === 'AVD-1001' ? '✅' : '❌');
console.log('  SHKOLA belgisi:', res.badge ? '✅' : '❌', '| tugma:', JSON.stringify(res.startBtn));
console.log('  oyna:', res.text);
console.log('  narx ko\'rsatilmadi:', /so‘m|so'm/.test(res.text) ? '❌' : '✅');

await page.click('#scStart');
await page.waitForTimeout(900);
const started = await page.evaluate(() => ({
  started: window.__started,
  sheetOpen: document.getElementById('sheet').classList.contains('on'),
  list: document.getElementById('bkList')?.innerText.replace(/\s+/g, ' ').slice(0, 200)
     || document.getElementById('todayList')?.innerText.replace(/\s+/g, ' ').slice(0, 200),
}));
console.log('\n  dars boshlandi:', JSON.stringify(started.started), started.started[0] === 'AVD-1001' ? '✅' : '❌');
console.log('  oyna yopildi:', started.sheetOpen ? '❌' : '✅');

await page.evaluate(() => { if (typeof showPanel === 'function') showPanel('bookings'); });
await page.waitForTimeout(600);
const card = await page.evaluate(() => {
  const el = document.querySelector('#bkList .bk') || document.querySelector('.bk');
  return { text: el ? el.innerText.replace(/\s+/g, ' ') : '(karta yo\'q)',
           badge: !!document.querySelector('.bk .st-pill[style*="0f7b3f"]'),
           finish: !!document.querySelector('[data-a="departed"]') };
});
console.log('\n  ro\'yxatdagi karta:', card.text);
console.log('  SHKOLA belgisi:', card.badge ? '✅' : '❌', '| yakunlash tugmasi:', card.finish ? '✅' : '❌');
console.log('  narx yo\'q:', /so‘m|so'm/.test(card.text) ? '❌' : '✅');

if (card.finish) {
  page.on('dialog', d => d.accept());
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-a="departed"]')];
    const vis = btns.find(b => b.offsetParent !== null) || btns[0];
    vis.click();
  });
  await page.waitForTimeout(900);
  const fin = await page.evaluate(() => ({ finished: window.__finished,
    confirm: document.getElementById('sheet')?.innerText.replace(/\s+/g, ' ').slice(0, 120) }));
  if (!fin.finished.length) {
    /* tasdiq oynasi chiqqan bo'lishi mumkin */
    const ok = await page.$('#cfYes, [id$="Yes"]');
    if (ok) { await ok.click(); await page.waitForTimeout(800); }
  }
  const fin2 = await page.evaluate(() => window.__finished);
  console.log('\n  yakunlash yuborildi:', JSON.stringify(fin2), fin2.length ? '✅' : '❌');
}

/* --- 2) Avtodrom ning o'z cheki hali ham ishlaydi --- */
console.log('\n=== 2) AVTODROM NING O\'Z CHEKI ===');
await page.evaluate(() => {
  if (typeof closeSheet === 'function') closeSheet();
  if (typeof showPanel === 'function') showPanel('today');   // skaner tugmasi shu panelda
});
await page.waitForTimeout(400);
await page.click('#scanBtn');
await page.waitForTimeout(400);
await page.fill('#mcInput', 'AVD-260901-6KBCQ');
await page.click('#mcYes');
await page.waitForTimeout(700);
const own = await page.evaluate(() => ({
  sent: window.__scanCalls[window.__scanCalls.length - 1],
  text: document.getElementById('sheet')?.innerText.replace(/\s+/g, ' '),
  badge: !!document.querySelector('#sheet .st-pill[style*="0f7b3f"]'),
}));
console.log('  kod:', own.sent, own.sent === 'AVD-260901-6KBCQ' ? '✅' : '❌');
console.log('  SHKOLA belgisi yo\'q:', own.badge ? '❌' : '✅');
console.log('  narx ko\'rinadi:', /so‘m|so'm|250/.test(own.text) ? '✅' : '❌');
console.log('  oyna:', own.text?.slice(0, 160));

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 8).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
