/**
 * AVTODROM — sog'liq va konfiguratsiya diagnostikasi.
 * MUHIM: hech qanday maxfiy qiymat qaytarilmaydi.
 * Faqat "bormi/yo'qmi", uzunlik va tokenning ochiq bot ID qismi.
 */

/** Telegram tokeni "<bot_id>:<secret>" shaklida. bot_id ochiq ma'lumot. */
function tokenInfo(raw) {
  const value = String(raw ?? '');
  if (!value) return { set: false, reason: 'o‘zgaruvchi yo‘q yoki bo‘sh' };

  const trimmed = value.trim();
  const info = {
    set: true,
    length: trimmed.length,
    has_whitespace: trimmed !== value,           // oldi/orqada bo'sh joy bormi
    looks_like_token: /^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(trimmed),
    bot_id: null,
  };
  const m = trimmed.match(/^(\d{6,}):/);
  if (m) info.bot_id = Number(m[1]);             // ochiq ID, maxfiy emas
  if (!info.looks_like_token) {
    info.reason = trimmed.includes(':')
      ? 'format noto‘g‘ri (uzunlik yoki belgilar mos emas)'
      : '":" belgisi yo‘q — bu token emas (shablon matn qolgan bo‘lishi mumkin)';
  }
  return info;
}

function plain(raw) {
  const value = String(raw ?? '');
  return { set: Boolean(value.trim()), length: value.trim().length, has_whitespace: value.trim() !== value };
}

export default function handler(_request, response) {
  const env = process.env;

  let supabaseHost = null;
  try { supabaseHost = env.SUPABASE_URL ? new URL(env.SUPABASE_URL).host : null; } catch { supabaseHost = 'NOTO‘G‘RI URL'; }

  const body = {
    ok: true,
    service: 'avtodrom-api',
    time: new Date().toISOString(),
    vercel_env: env.VERCEL_ENV ?? 'unknown',

    bots: {
      customer:   tokenInfo(env.CUSTOMER_BOT_TOKEN   ?? env.TELEGRAM_CUSTOMER_BOT_TOKEN),
      instructor: tokenInfo(env.INSTRUCTOR_BOT_TOKEN ?? env.TELEGRAM_INSTRUCTOR_BOT_TOKEN),
      admin:      tokenInfo(env.ADMIN_BOT_TOKEN      ?? env.TELEGRAM_ADMIN_BOT_TOKEN),
    },

    supabase: {
      url_host: supabaseHost,
      service_key: plain(env.SUPABASE_SERVICE_ROLE_KEY),
    },

    admin_panel: {
      login: plain(env.ADMIN_LOGIN),
      password: plain(env.ADMIN_PASSWORD),
      session_secret: plain(env.ADMIN_SESSION_SECRET),
    },

    frontend_origin: env.FRONTEND_ORIGIN ?? null,
  };

  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body, null, 2));
}
