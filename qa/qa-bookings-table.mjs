/* BRONLAR JADVALI — sig'adimi?
   Muammo: 10 ta ustun 800px ichiga siqilib, "Amal" tugmalari o'ngda
   kesilib qolardi. Tekshiramiz:
     1) jadval oynadan kengroq bo'lsa ham oyna gorizontal aylanadi
     2) "Amal" ustuni o'ng chetda yopishib turadi (sticky)
     3) tugmalar ustma-ust, sinib ketmagan holda chiqadi
     4) Hisobot ichidagi ikki jadval yarim ustunga sig'adi */
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
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
await page.route('**', r => (new URL(r.request().url()).hostname === 'localhost' ? r.continue() : r.abort()));
page.setDefaultTimeout(8000);

await page.addInitScript(() => {
  const J = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const me = { ok: true, login: 'Adminn', role: 'admin', full_name: 'Bosh Administrator' };
  const instructor = { id: 'ip1', user_id: 'u1', profile: { full_name: 'Shaxzod Ruziqulov' }, categories: ['B'] };
  const course = { id: 'cr1', name: 'B toifa amaliyot', category: 'B', duration_minutes: 60, price: 250000 };
  const mk = (i, status) => ({
    id: 'bk' + i,
    customer: { id: 'c' + i, full_name: 'Jasurbek Qodirov ' + i, phone: '+99890123456' + (i % 10) },
    instructor, instructor_id: 'ip1', course, course_id: 'cr1',
    start_at: new Date(Date.now() + i * 36e5).toISOString(),
    end_at: new Date(Date.now() + i * 36e5 + 36e5).toISOString(),
    status, price: 250000, pickup_code: 'AVD-482' + i,
    reminder_sent_at: i % 2 ? new Date().toISOString() : null,
  });
  const bookings = [mk(1, 'pending'), mk(2, 'confirmed'), mk(3, 'in_progress'), mk(4, 'completed')];
  const daily = [{ date: '2026-09-10', total: 12, came: 9, no_show: 1, cancelled: 1, completed: 9, revenue: 2250000 }];

  window.fetch = async (url) => {
    const u = String(url).split('?')[0];
    if (u === '/api/admin/me') return J(me);
    if (u === '/api/admin/login') return J(me);
    if (u === '/api/admin/bookings') return J({ ok: true, bookings, total: bookings.length });
    if (u === '/api/admin/instructors') return J({ ok: true, instructors: [instructor] });
    if (u === '/api/admin/courses') return J({ ok: true, courses: [course] });
    if (u === '/api/admin/reports') return J({ ok: true, daily, byInstructor: [], instructors: [], summary: {} });
    return J({ ok: true, rows: [], items: [], bookings: [], list: [], data: [], daily, registers: [], instructors: [instructor], summary: {}, totals: {}, stats: {} });
  };
});
const errs = []; page.on('pageerror', e => errs.push(e.message));

await page.goto(`http://localhost:${P}/`);
await page.waitForTimeout(1200);
await page.click('.rolebtn[data-role="admin"]');
await page.waitForTimeout(300);
await page.fill('#loginUser', 'Adminn');
await page.fill('#loginPass', '12345678');
await page.click('#loginBtn');
await page.waitForTimeout(1800);

console.log('=== BRONLAR ===');
await page.click('.nav[data-p="bookings"]');
await page.waitForTimeout(1200);

const m = await page.evaluate(() => {
  const wrap = document.querySelector('#bookings .tableWrap');
  const tb = document.querySelector('#bookingRows');
  const row = tb.querySelector('tr');
  const act = row && row.querySelector('td.actions');
  const btns = act ? [...act.querySelectorAll('.btn')] : [];
  const st = act && getComputedStyle(act);
  return {
    rows: tb.querySelectorAll('tr').length,
    wrapW: Math.round(wrap.clientWidth),
    tableW: Math.round(wrap.querySelector('table').scrollWidth),
    canScroll: wrap.scrollWidth > wrap.clientWidth + 2,
    sticky: st ? st.position : '(yo‘q)',
    btnCount: btns.length,
    /* tugmalar ustma-ust turishi kerak: har birining top'i farqli */
    stacked: btns.length < 2 ? true : new Set(btns.map(b => Math.round(b.getBoundingClientRect().top))).size === btns.length,
    /* birorta tugma kesilib qolmasin */
    clipped: btns.some(b => {
      const r = b.getBoundingClientRect(), w = wrap.getBoundingClientRect();
      return r.right > w.right + 1 || r.left < w.left - 1;
    }),
    hint: !!document.querySelector('#bookings .scrollHint'),
  };
});
console.log('  qatorlar:', m.rows, '| oyna eni:', m.wrapW, '| jadval eni:', m.tableW);
console.log('  gorizontal aylanish:', m.canScroll ? '✅ bor' : 'ℹ️ kerak emas (sig‘di)');
console.log('  «Amal» ustuni yopishgan:', m.sticky === 'sticky' ? '✅' : '❌ ' + m.sticky);
console.log('  tugmalar:', m.btnCount, '| ustma-ust:', m.stacked ? '✅' : '❌', '| kesilgan:', m.clipped ? '❌ ha' : '✅ yo‘q');
console.log('  eslatma yozuvi:', m.hint ? '✅' : '❌');

/* O'ngga surib ham "Amal" ko'rinib turadimi */
await page.evaluate(() => { const w = document.querySelector('#bookings .tableWrap'); w.scrollLeft = w.scrollWidth; });
await page.waitForTimeout(400);
const after = await page.evaluate(() => {
  const wrap = document.querySelector('#bookings .tableWrap');
  const b = document.querySelector('#bookingRows td.actions .btn');
  if (!b) return { ok: false };
  const r = b.getBoundingClientRect(), w = wrap.getBoundingClientRect();
  return { ok: r.right <= w.right + 1 && r.left >= w.left - 1 && r.width > 20 };
});
console.log('  oxirigacha surilganda tugma ko‘rinadi:', after.ok ? '✅' : '❌');
await page.screenshot({ path: '/tmp/bookings.png', clip: { x: 250, y: 120, width: 1100, height: 560 } });

console.log('\n=== HISOBOT (yarim ustundagi jadvallar) ===');
await page.click('.nav[data-p="reports"]');
await page.waitForTimeout(1000);
const rep = await page.evaluate(() => {
  const wraps = [...document.querySelectorAll('#reports .grid2 .tableWrap')];
  return wraps.map(w => ({
    wrap: Math.round(w.clientWidth),
    table: Math.round(w.querySelector('table').scrollWidth),
    over: w.querySelector('table').scrollWidth > w.clientWidth + 2,
  }));
});
rep.forEach((r, i) => console.log(`  jadval ${i + 1}: oyna ${r.wrap}px, jadval ${r.table}px →`, r.over ? '❌ sig‘madi' : '✅ sig‘di'));
await page.screenshot({ path: '/tmp/reports.png' });

console.log('\n=== KICHIK EKRAN (390px) ===');
await page.setViewportSize({ width: 390, height: 840 });
await page.waitForTimeout(400);
await page.click('.nav[data-p="bookings"]');
await page.waitForTimeout(900);
const small = await page.evaluate(() => {
  const d = document.documentElement;
  return { over: d.scrollWidth > d.clientWidth + 1, sw: d.scrollWidth, cw: d.clientWidth };
});
console.log('  sahifa o‘zi gorizontal chiqib ketmadi:', small.over ? `❌ ${small.sw} > ${small.cw}` : '✅');

console.log('\n=== JS XATOLAR ===');
console.log(errs.length ? [...new Set(errs)].slice(0, 6).join('\n') : "  yo'q ✅");
await browser.close(); server.close();
