import { createHmac, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function getCookie(request: any): string {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}

export function requireAdmin(request: any) {
  const token = getCookie(request);
  const secret = String(process.env.ADMIN_SESSION_SECRET ?? process.env.ADMIN_PASSWORD ?? '').trim();
  const expectedLogin = String(process.env.ADMIN_LOGIN ?? '').trim();
  if (!secret || !expectedLogin || !token) throw new Error('Unauthorized');

  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const first = decoded.indexOf(':');
  const second = decoded.indexOf(':', first + 1);
  if (first <= 0 || second <= first) throw new Error('Unauthorized');

  const login = decoded.slice(0, first);
  const timestamp = Number(decoded.slice(first + 1, second));
  const signature = decoded.slice(second + 1);
  if (login !== expectedLogin || !Number.isFinite(timestamp) || !signature) throw new Error('Unauthorized');

  const age = Date.now() - timestamp;
  if (age < 0 || age > SESSION_TTL * 1000) throw new Error('Session expired');

  const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
  const a = Buffer.from(signature, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('Unauthorized');
}

export function supabaseConfig() {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '');
  if (!url || !key) throw new Error('Supabase server credentials are missing');
  return { url, key };
}

export async function rest(table: string, options: RequestInit & { query?: string } = {}) {
  const { url, key } = supabaseConfig();
  const headers = new Headers(options.headers);
  headers.set('apikey', key);
  headers.set('Authorization', `Bearer ${key}`);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(`${url}/rest/v1/${table}${options.query || ''}`, { ...options, headers });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

export const BUCKET = 'customer-media';
