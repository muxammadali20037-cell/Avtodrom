/**
 * Umumiy forwarder — so'rovni Fastify ilovasiga uzatadi.
 *
 * NEGA KERAK:
 * Vercel'da `api/admin/[...path].ts` catch-all ichma-ich manzillarni
 * (`/api/admin/courses/<id>`) tutmayapti — faqat bir bo'g'inli
 * (`/api/admin/courses`) manzillar yetib boradi. Isbot: ishlaydigan har bir
 * ichma-ich endpointning alohida fayli bor (bookings/[id]/status.ts,
 * instructors/[id].ts, settings/[key].ts), fayli yo'q yagona endpoint —
 * courses/:id — 404 qaytaradi.
 *
 * Har bir endpoint uchun mantiqni qayta yozish o'rniga, shu yerda bitta
 * uzatuvchi turadi. Route fayllari faqat bir qator:
 *     export { default } from '../../_forward.js';
 * Biznes logika esa backend/src/ da bitta joyda qoladi.
 *
 * Fayl nomi `_` bilan boshlanadi — Vercel uni route sifatida ko'rmaydi.
 */
import app from '../backend/src/app.js';

export default async function forward(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const rawUrl = String(request.url || '/api');
    const parsed = new URL(rawUrl, 'http://vercel.local');
    const url = `${parsed.pathname}${parsed.search}`;

    const method = String(request.method || 'GET').toUpperCase();
    const payload =
      method === 'GET' || method === 'HEAD' || request.body === undefined
        ? undefined
        : typeof request.body === 'string'
          ? request.body
          : JSON.stringify(request.body);

    const result = await app.inject({ method: method as any, url, headers, payload });

    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (value !== undefined) response.setHeader(key, value as string);
    }
    response.end(result.body);
  } catch (error) {
    console.error('API forward failed:', request?.method, request?.url, error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
