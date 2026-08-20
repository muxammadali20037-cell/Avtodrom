import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).json({ ok: false });
  const token = process.env.ADMIN_BOT_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'ADMIN_BOT_TOKEN is not configured' });
  const base = process.env.PUBLIC_API_URL || 'https://avtodrom12-five.vercel.app';
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const body: Record<string, unknown> = { url: `${base}/api/telegram/admin-webhook` };
  if (secret) body.secret_token = secret;
  const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return res.status(r.ok ? 200 : 502).json(await r.json());
}
