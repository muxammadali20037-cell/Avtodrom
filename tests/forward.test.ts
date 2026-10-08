/**
 * VERCEL UZATUVCHISI: Telegram webhook tanasida kirill/emoji \uXXXX bo'lib
 * keladi. Uzatuvchi tanani qayta JSON qiladi — eski Content-Length bilan
 * Fastify 400 qaytarardi va instruktor boti xabarlarni ololmasdi (2026-10-08).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeHarness, type Harness } from './harness.js';

let h: Harness;
let forward: any, catchAll: any, adminCatchAll: any, handler: any;
beforeAll(async () => {
  h = await makeHarness();
  forward = (await import('../api/_forward.js')).default;
  catchAll = (await import('../api/[...path].js')).default;
  adminCatchAll = (await import('../api/admin/[...path].js')).default;
  handler = (await import('../backend/src/vercel-handler.js')).default;
});

async function run(fn: any, url: string, raw: string) {
  const res: any = { statusCode: 0, headers: {}, setHeader(k: string, v: any) { this.headers[k] = v; }, end(b: any) { this.body = String(b ?? ''); } };
  const req: any = { method: 'POST', url, body: JSON.parse(raw), headers: {
    'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)),
    'x-telegram-bot-api-secret-token': 'test-webhook-secret', host: 'avtodrom.vercel.app' } };
  await fn(req, res);
  return res;
}

describe('Vercel uzatuvchisi', () => {
  const raw = '{"update_id":1,"message":{"message_id":1,"chat":{"id":555,"type":"private"},"from":{"id":555,"first_name":"\\u0410\\u0437\\u0438\\u0437 \\ud83d\\ude97"},"text":"\\u0437\\u0430\\u0432\\u0442\\u0440\\u0430"}}';
  it('Telegram yuborgan \\uXXXX tanani 400 siz o‘tkazadi (hamma uzatuvchilar)', async () => {
    expect(Buffer.byteLength(raw)).not.toBe(Buffer.byteLength(JSON.stringify(JSON.parse(raw))));
    for (const fn of [forward, handler, catchAll]) {
      const r = await run(fn, '/api/telegram/instructor/webhook', raw);
      expect(r.statusCode).toBe(200);
    }
    const a = await run(adminCatchAll, '/api/admin/login', '{"login":"\\u0430","password":"x"}');
    expect(a.statusCode).not.toBe(400);
  });
});
