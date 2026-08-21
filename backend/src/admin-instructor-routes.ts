import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

async function adminProfile(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('profiles', { query: `?telegram_id=eq.${q(String(user.id))}&select=*` });
  const profile = rows[0];
  if (!profile || String(profile.role).toLowerCase() !== 'admin' || profile.active === false) throw new Error('ADMIN_REQUIRED');
  return profile;
}

export function registerAdminInstructorRoutes(app: FastifyInstance, authenticate: (request:any)=>Promise<TelegramWebAppUser>) {
  app.get('/api/admin/instructor-applications', async (request, reply) => {
    try {
      await adminProfile(await authenticate(request));
      return { ok:true, applications: await supabaseRest<any[]>('instructor_applications', { query:'?select=*&order=created_at.desc' }) };
    } catch(e:any) { return reply.code(403).send({ok:false,error:e.message || 'Admin huquqi talab qilinadi'}); }
  });

  app.post('/api/admin/instructor-applications/:id/approve', async (request, reply) => {
    try {
      const admin = await adminProfile(await authenticate(request));
      const rows = await supabaseRest<any[]>('rpc/admin_approve_instructor', { method:'POST', body:JSON.stringify({p_application_id:String((request.params as any).id),p_admin_id:admin.id}) });
      return {ok:true,application:rows};
    } catch(e:any) { return reply.code(400).send({ok:false,error:e.message || 'Tasdiqlash amalga oshmadi'}); }
  });

  app.post('/api/admin/instructor-applications/:id/reject', async (request, reply) => {
    try {
      const admin = await adminProfile(await authenticate(request));
      const reason = String((request.body as any)?.reason || '').trim() || null;
      const rows = await supabaseRest<any[]>('rpc/admin_reject_instructor', { method:'POST', body:JSON.stringify({p_application_id:String((request.params as any).id),p_admin_id:admin.id,p_reason:reason}) });
      return {ok:true,application:rows};
    } catch(e:any) { return reply.code(400).send({ok:false,error:e.message || 'Rad etish amalga oshmadi'}); }
  });
}
