/**
 * BOSHLIQ ILOVASI — qo'lda ko'rish uchun server (production bazasiga TEGMAYDI).
 *   AVTODROM12_URL=http://localhost:8790 npx vite-node tests/boss-preview.ts
 * E2E sinov serveri (soxta baza) + boshliq havolasi va PIN 1234.
 * avtodrom12 ko'prigi uchun haqiqiy tarmoq ishlatiladi (AVTODROM12_URL).
 */
const realFetch = globalThis.fetch;
process.env.RECEIPT_SHARED_KEY = process.env.RECEIPT_SHARED_KEY || 'demo-shared-key-0123456789abcdef';
await import('./e2e-server.js');
const a12 = String(process.env.AVTODROM12_URL || '');
const wrapped = globalThis.fetch;
globalThis.fetch = (async (u: any, o: any) => (a12 && String(u).startsWith(a12) ? realFetch(u, o) : wrapped(u, o))) as any;

const PORT = Number(process.env.PORT || 8770);
const base = `http://localhost:${PORT}`;
await new Promise((r) => setTimeout(r, 300));
const login = await realFetch(`${base}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'admin', password: 'parol1234' }) });
const cookie = String(login.headers.get('set-cookie') || '').split(';')[0];
const r = await realFetch(`${base}/api/admin/boss-link`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ pin: '1234' }) });
const d: any = await r.json();
console.log(`BOSS: ${String(d.url).replace(/^https:\/\/[^/]+/, base)}  (PIN 1234)`);
