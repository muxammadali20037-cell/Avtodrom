import app from '../../../backend/src/app.js';
import { supabaseRest } from '../../../backend/src/supabase.js';

function parseMinutes(value: unknown, fallback: number) {
  const m = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallback;
  const n = Number(m[1]) * 60 + Number(m[2]);
  return Number.isFinite(n) ? n : fallback;
}

function hhmm(total: number) {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export default async function handler(request: any, response: any) {
  try {
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers || {})) {
      if (typeof value === 'string') headers[key] = value;
      else if (Array.isArray(value)) headers[key] = value.join(', ');
    }

    const id = String(request.query?.id || '').trim();
    const date = String(request.query?.date || '').trim();
    if (!id) {
      response.statusCode = 400;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: false, error: 'Instructor ID missing' }));
      return;
    }

    const url = `/api/instructors/${encodeURIComponent(id)}/availability?date=${encodeURIComponent(date)}`;
    const result = await app.inject({ method: 'GET', url, headers });
    let body: any;
    try { body = JSON.parse(result.body || '{}'); } catch { body = {}; }

    if (result.statusCode >= 200 && result.statusCode < 300 && body?.ok) {
      const settingRows = await supabaseRest<any[]>('admin_settings', {
        query: '?key=eq.working_hours&select=value&limit=1',
      }).catch(() => []);
      const wh = settingRows[0]?.value || {};
      const start = parseMinutes(wh.start, 8 * 60);
      const end = parseMinutes(wh.end, 18 * 60);
      const slotMinutes = Math.max(15, Math.min(180, Number(wh.slot_minutes || 60)));
      const slots: string[] = [];
      for (let t = start; t + slotMinutes <= end; t += slotMinutes) slots.push(hhmm(t));
      body = { ...body, slots, working_hours: { start: hhmm(start), end: hhmm(end), slot_minutes: slotMinutes, timezone: wh.timezone || 'Asia/Tashkent' } };
    }

    const output = JSON.stringify(body);
    response.statusCode = result.statusCode;
    for (const [key, value] of Object.entries(result.headers)) {
      if (key.toLowerCase() !== 'content-length' && value !== undefined) response.setHeader(key, value as string);
    }
    response.setHeader('content-type', 'application/json');
    response.setHeader('content-length', String(Buffer.byteLength(output)));
    response.end(output);
  } catch (error) {
    console.error('Availability function failed:', error);
    response.statusCode = 500;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: false, error: 'Internal server error' }));
  }
}
