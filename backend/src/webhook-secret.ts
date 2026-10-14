import crypto from 'node:crypto';
import { telegramApi } from './telegram.js';

/**
 * TELEGRAM WEBHOOK SIRI
 *
 * Telegram har bir webhook so'roviga `X-Telegram-Bot-Api-Secret-Token`
 * sarlavhasini qo'shadi — begona odam soxta xabar yubora olmasin.
 *
 * TELEGRAM_WEBHOOK_SECRET Vercel'da sozlangan bo'lsa — o'sha ishlatiladi.
 * Sozlanmagan bo'lsa webhook ilgari butunlay yopiq edi (503) va instruktor
 * boti umuman javob bermasdi. Endi sir bot tokenidan hosil qilinadi:
 * tokenni faqat server biladi, demak sir ham faqat serverda — xavfsizlik
 * o'sha-o'sha, lekin Vercel'da qo'shimcha sozlama shart emas.
 */
export function webhookSecret(envSecret: string, token: string): string {
  if (envSecret) return envSecret;
  if (!token) return '';
  return crypto.createHash('sha256').update(`avtodrom-webhook:${token}`).digest('hex').slice(0, 48);
}

/**
 * Webhook'ni XUDDI SHU manzil va TO'G'RI sir bilan qayta o'rnatadi.
 * Telegram shundan keyin navbatda turgan xabarlarni darhol qayta yuboradi
 * (navbat o'chirilmaydi). Boshqa manzilga ulangan webhook'ga tegilmaydi.
 */
export async function resetWebhook(token: string, url: string, secret: string, opts: { onlyIfPending?: boolean } = {}): Promise<{ done: boolean; note: string; info: any }> {
  const info = await telegramApi<any>(token, 'getWebhookInfo', {});
  if (!secret) return { done: false, note: 'webhook siri yo‘q — tegilmadi', info };
  if (info?.url !== url) return { done: false, note: 'webhook boshqa manzilda — tegilmadi', info };
  if (opts.onlyIfPending && !(info.pending_update_count > 0)) return { done: false, note: 'navbat bo‘sh — kerak emas', info };
  await telegramApi(token, 'setWebhook', {
    url, secret_token: secret, drop_pending_updates: false,
    ...(info.max_connections ? { max_connections: info.max_connections } : {}),
    allowed_updates: withCallbacks(info.allowed_updates),
  });
  return { done: true, note: 'qayta o‘rnatildi — navbatdagi xabarlar qayta yuboriladi', info: await telegramApi<any>(token, 'getWebhookInfo', {}) };
}
/** Tugmalar (callback_query) doim kelsin: ro'yxat bo'sh bo'lsa — standart, bo'lmasa qo'shiladi */
function withCallbacks(list: unknown): string[] {
  const base = Array.isArray(list) && list.length ? list.map(String) : ['message', 'callback_query'];
  return base.includes('callback_query') ? base : [...base, 'callback_query'];
}

/**
 * Bot tugmalari ishlashi uchun webhook callback_query'ni ham qabul qilishi
 * kerak. Webhook faqat «message» bilan o'rnatilgan bo'lsa — o'sha manzil va
 * sir bilan callback_query qo'shiladi (jarayon davomida bir marta tekshiriladi).
 */
const ensuredCb = new Set<string>();
export async function ensureCallbackUpdates(token: string, url: string, secret: string): Promise<string | null> {
  if (!token || !secret || ensuredCb.has(url)) return null;
  ensuredCb.add(url);
  try {
    const info = await telegramApi<any>(token, 'getWebhookInfo', {});
    const list = Array.isArray(info?.allowed_updates) ? info.allowed_updates : [];
    if (info?.url !== url || !list.length || list.includes('callback_query')) return null;
    await telegramApi(token, 'setWebhook', {
      url, secret_token: secret, drop_pending_updates: false,
      ...(info.max_connections ? { max_connections: info.max_connections } : {}),
      allowed_updates: withCallbacks(list),
    });
    return 'callback_query qo‘shildi';
  } catch {
    ensuredCb.delete(url);
    return null;
  }
}
export const _resetEnsuredCallbacks = () => ensuredCb.clear();

/**
 * Sirsiz yoki noto'g'ri sir bilan kelgan so'rovdan keyin webhook'ni o'zi
 * tuzatadi (masalan, webhook boshqa joydan sirsiz o'rnatib yuborilgan
 * bo'lsa). So'rovning o'zi baribir rad etiladi. Daqiqasiga ko'pi bilan
 * bir marta — begona so'rovlar Telegram'ga ortiqcha yuk bermasin.
 */
const lastHeal = new Map<string, number>();
export async function healWebhook(token: string, url: string, secret: string, now = Date.now()): Promise<string | null> {
  if (!token || !secret) return null;
  if (now - (lastHeal.get(url) || 0) < 60_000) return null;
  lastHeal.set(url, now);
  try {
    const r = await resetWebhook(token, url, secret);
    return r.note;
  } catch (e) {
    return `xato: ${e instanceof Error ? e.message : String(e)}`;
  }
}
export const _resetHealThrottle = () => lastHeal.clear();
