import type { FastifyInstance } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';

const COOKIE_NAME = 'avtodrom_admin_session';
const SESSION_TTL = 60 * 60 * 12;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const BUCKET = 'admin-media';
const WEB_ADMIN_ID = '6d94122e-8b9f-4523-a304-ec2d2e85a003';

function q(value: string) { return encodeURIComponent(value); }
function getCookie(request: any): string {
  const raw = String(request.headers?.cookie ?? '');
  const item = raw.split(';').map((v: string) => v.trim()).find((v: string) => v.startsWith(`${COOKIE_NAME}=`));
  if (!item) return '';
  try { return decodeURIComponent(item.slice(COOKIE_NAME.length + 1)); } catch { return ''; }
}
function validSession(token: string) {
  try {
    const fallback = String(process.env.ADMIN_PASSWORD ?? '').trim();
    const secret = String(process.env.ADMIN_SESSION_SECRET ?? fallback).trim();
    const login = String(process.env.ADMIN_LOGIN ?? '').trim();
    if (!secret || !login || !token) return false;
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const a = decoded.indexOf(':'); const b = decoded.indexOf(':', a + 1);
    if (a <= 0 || b <= a) return false;
    const actualLogin = decoded.slice(0, a); const timestamp = Number(decoded.slice(a + 1, b)); const sig = decoded.slice(b + 1);
    if (actualLogin !== login || !Number.isFinite(timestamp) || !sig) return false;
    const age = Date.now() - timestamp;
    if (age < 0 || age > SESSION_TTL * 1000) return false;
    const expected = createHmac('sha256', secret).update(`${login}:${timestamp}`).digest('hex');
    const x = Buffer.from(sig); const y = Buffer.from(expected);
    return x.length === y.length && timingSafeEqual(x, y);
  } catch { return false; }
}
async function requireAdmin(request: any) {
  if (!validSession(getCookie(request))) throw new Error('Unauthorized');
}
function publicUrl(path: string) { return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`; }

export function registerAdminDashboardRoutes(app: FastifyInstance) {
  app.get('/api/admin/applications', async (request, reply) => {
    try {
      await requireAdmin(request);
      const applications = await supabaseRest<any[]>('instructor_applications', { query: '?select=*&order=created_at.desc' });
      return { ok: true, applications };
    } catch (e: any) { return reply.code(401).send({ ok:false, error:e?.message || 'Unauthorized' }); }
  });

  app.post<{ Params:{id:string} }>('/api/admin/applications/:id/approve', async (request, reply) => {
    try {
      await requireAdmin(request);
      const id = String(request.params.id);
      const rows = await supabaseRest<any[]>('instructor_applications', { query:`?id=eq.${q(id)}&select=*` });
      const application = rows[0];
      if (!application) return reply.code(404).send({ ok:false, error:'Ariza topilmadi' });
      const result = await supabaseRest<any[]>('rpc/admin_approve_instructor', { method:'POST', body:JSON.stringify({ p_application_id:id, p_admin_id:WEB_ADMIN_ID }) });
      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
        const url = String(process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor');
        if (token && application.telegram_user_id) await sendBookingNotification(token, Number(application.telegram_user_id), '✅ Arizangiz tasdiqlandi!\n\nEndi AVTODROM Instruktor Mini Appiga kirishingiz mumkin.', url, '👨‍🏫 Instruktor panelini ochish');
      } catch (e) { console.error('approval telegram notification failed', e); }
      return { ok:true, application:result?.[0] || application };
    } catch (e:any) { return reply.code(400).send({ok:false,error:e?.message || 'Tasdiqlash amalga oshmadi'}); }
  });

  app.post<{ Params:{id:string}; Body:{reason?:string} }>('/api/admin/applications/:id/reject', async (request, reply) => {
    try {
      await requireAdmin(request);
      const id = String(request.params.id);
      const reason = String(request.body?.reason || '').trim() || null;
      const rows = await supabaseRest<any[]>('instructor_applications', { query:`?id=eq.${q(id)}&select=*` });
      const application = rows[0];
      if (!application) return reply.code(404).send({ok:false,error:'Ariza topilmadi'});
      const result = await supabaseRest<any[]>('rpc/admin_reject_instructor', { method:'POST', body:JSON.stringify({p_application_id:id,p_admin_id:WEB_ADMIN_ID,p_reason:reason}) });
      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || process.env.TELEGRAM_INSTRUCTOR_BOT_TOKEN || '');
        if (token && application.telegram_user_id) await sendBookingNotification(token, Number(application.telegram_user_id), `❌ Arizangiz rad etildi.${reason ? `\n\nSabab: ${reason}` : ''}`);
      } catch (e) { console.error('rejection telegram notification failed', e); }
      return {ok:true,application:result?.[0] || application};
    } catch (e:any) { return reply.code(400).send({ok:false,error:e?.message || 'Rad etish amalga oshmadi'}); }
  });

  app.get('/api/admin/notifications', async (request, reply) => {
    try {
      await requireAdmin(request);
      const rows = await supabaseRest<any[]>('notifications', { query:'?select=*&order=created_at.desc&limit=100' });
      return {ok:true,notifications:rows};
    } catch (e:any) { return reply.code(401).send({ok:false,error:e?.message || 'Unauthorized'}); }
  });

  app.get('/api/admin/media', async (request, reply) => {
    try {
      await requireAdmin(request);
      const rows = await supabaseRest<any[]>('admin_media', { query:'?select=*&order=key.asc' });
      return {ok:true,media:rows};
    } catch (e:any) { return reply.code(401).send({ok:false,error:e?.message || 'Unauthorized'}); }
  });

  app.post<{Body:{key:string;title:string;media_type:'image'|'video';file_name:string;content_type:string}}>('/api/admin/media/sign', async (request, reply) => {
    try {
      await requireAdmin(request);
      if (!SUPABASE_URL || !SERVICE_KEY) return reply.code(500).send({ok:false,error:'Supabase server credentials are missing'});
      const key = String(request.body?.key || '').trim();
      const title = String(request.body?.title || '').trim();
      const mediaType = request.body?.media_type;
      const fileName = String(request.body?.file_name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
      const contentType = String(request.body?.content_type || 'application/octet-stream');
      if (!['home_image','guide_video'].includes(key)) return reply.code(400).send({ok:false,error:'Noto‘g‘ri media kaliti'});
      if (!['image','video'].includes(String(mediaType))) return reply.code(400).send({ok:false,error:'Noto‘g‘ri media turi'});
      if (key === 'home_image' && !contentType.startsWith('image/')) return reply.code(400).send({ok:false,error:'Bu joyga faqat rasm yuklang'});
      if (key === 'guide_video' && !contentType.startsWith('video/')) return reply.code(400).send({ok:false,error:'Bu joyga faqat video yuklang'});
      const path = `${key}/${Date.now()}-${fileName}`;
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {auth:{persistSession:false,autoRefreshToken:false}});
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path, {upsert:true});
      if (error || !data?.token) throw new Error(error?.message || 'Signed upload URL yaratilmadi');
      return {ok:true,path,token:data.token,title:title || key,media_type:mediaType,public_url:publicUrl(path)};
    } catch (e:any) { return reply.code(400).send({ok:false,error:e?.message || 'Upload tayyorlashda xato'}); }
  });

  app.post<{Body:{key:string;title:string;media_type:'image'|'video';path:string;public_url:string}}>('/api/admin/media/commit', async (request, reply) => {
    try {
      await requireAdmin(request);
      const key = String(request.body?.key || '').trim();
      const title = String(request.body?.title || '').trim();
      const mediaType = request.body?.media_type;
      const path = String(request.body?.path || '').trim();
      const url = String(request.body?.public_url || '').trim();
      if (!['home_image','guide_video'].includes(key) || !['image','video'].includes(String(mediaType)) || !path || !url) return reply.code(400).send({ok:false,error:'Media ma’lumotlari to‘liq emas'});
      const rows = await supabaseRest<any[]>('admin_media', {method:'POST',headers:{Prefer:'resolution=merge-duplicates,return=representation'},body:JSON.stringify({key,title:title || key,media_type:mediaType,path,public_url:url,updated_at:new Date().toISOString()})});
      return {ok:true,media:rows[0]};
    } catch (e:any) { return reply.code(400).send({ok:false,error:e?.message || 'Media saqlanmadi'}); }
  });
}
