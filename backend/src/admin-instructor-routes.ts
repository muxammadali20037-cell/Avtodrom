import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
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
      const applicationId = String((request.params as any).id);
      const applications = await supabaseRest<any[]>('instructor_applications', { query:`?id=eq.${q(applicationId)}&select=*` });
      if (!applications[0]) return reply.code(404).send({ok:false,error:'Ariza topilmadi'});
      const application = applications[0];
      const rows = await supabaseRest<any[]>('rpc/admin_approve_instructor', { method:'POST', body:JSON.stringify({p_application_id:applicationId,p_admin_id:admin.id}) });
      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
        const miniAppUrl = String(process.env.INSTRUCTOR_MINI_APP_URL || '');
        if (token && application.telegram_user_id) {
          await sendBookingNotification(token, Number(application.telegram_user_id), '✅ Arizangiz tasdiqlandi!\n\nEndi AVTODROM Instruktor Mini Appiga kirib, bronlaringiz va darslaringizni boshqarishingiz mumkin.', miniAppUrl, '👨‍🏫 Instruktor panelini ochish');
        }
      } catch (notifyError) { console.error('Instructor approval notification failed:', notifyError); }
      return {ok:true,application:rows};
    } catch(e:any) { return reply.code(400).send({ok:false,error:e.message || 'Tasdiqlash amalga oshmadi'}); }
  });

  app.post('/api/admin/instructor-applications/:id/reject', async (request, reply) => {
    try {
      const admin = await adminProfile(await authenticate(request));
      const applicationId = String((request.params as any).id);
      const reason = String((request.body as any)?.reason || '').trim() || null;
      const applications = await supabaseRest<any[]>('instructor_applications', { query:`?id=eq.${q(applicationId)}&select=*` });
      const application = applications[0];
      const rows = await supabaseRest<any[]>('rpc/admin_reject_instructor', { method:'POST', body:JSON.stringify({p_application_id:applicationId,p_admin_id:admin.id,p_reason:reason}) });
      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
        if (token && application?.telegram_user_id) await sendBookingNotification(token, Number(application.telegram_user_id), `❌ Arizangiz rad etildi.${reason ? `\n\nSabab: ${reason}` : ''}\n\nMa'lumotlarni to‘g‘rilab, qayta ariza yuborishingiz mumkin.`);
      } catch (notifyError) { console.error('Instructor rejection notification failed:', notifyError); }
      return {ok:true,application:rows};
    } catch(e:any) { return reply.code(400).send({ok:false,error:e.message || 'Rad etish amalga oshmadi'}); }
  });
}
