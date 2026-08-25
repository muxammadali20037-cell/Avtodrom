import type { FastifyInstance } from 'fastify';
import { supabaseRest } from './supabase.js';
import { sendBookingNotification } from './telegram.js';
import type { TelegramWebAppUser } from './telegram.js';

function q(value: string) { return encodeURIComponent(value); }

/**
 * Admin authorization must use the real production `users` table.
 * The old code queried a non-existent `profiles` table, so every
 * instructor approve/reject request could fail even for a real admin.
 */
async function adminProfile(user: TelegramWebAppUser) {
  const rows = await supabaseRest<any[]>('users', {
    query: `?telegram_id=eq.${q(String(user.id))}&select=id,telegram_id,full_name,role,is_active,is_blocked&limit=1`
  });

  const profile = rows[0];
  if (
    !profile ||
    String(profile.role || '').toLowerCase() !== 'admin' ||
    profile.is_active !== true ||
    profile.is_blocked === true
  ) {
    throw new Error('ADMIN_REQUIRED');
  }

  return profile;
}

export function registerAdminInstructorRoutes(
  app: FastifyInstance,
  authenticate: (request: any) => Promise<TelegramWebAppUser>
) {
  app.get('/api/admin/instructor-applications', async (request, reply) => {
    try {
      await adminProfile(await authenticate(request));
      return {
        ok: true,
        applications: await supabaseRest<any[]>('instructor_applications', {
          query: '?select=*&order=created_at.desc'
        })
      };
    } catch (e: any) {
      return reply.code(403).send({
        ok: false,
        error: e.message || 'Admin huquqi talab qilinadi'
      });
    }
  });

  app.post('/api/admin/instructor-applications/:id/approve', async (request, reply) => {
    try {
      const admin = await adminProfile(await authenticate(request));
      const applicationId = String((request.params as any).id);

      const applications = await supabaseRest<any[]>('instructor_applications', {
        query: `?id=eq.${q(applicationId)}&select=*`
      });
      if (!applications[0]) {
        return reply.code(404).send({ ok: false, error: 'Ariza topilmadi' });
      }

      const application = applications[0];

      const rows = await supabaseRest<any[]>('rpc/admin_approve_instructor', {
        method: 'POST',
        body: JSON.stringify({
          p_application_id: applicationId,
          p_admin_id: admin.id
        })
      });

      // Do not let a Telegram notification failure undo a successful approval.
      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
        const miniAppUrl = String(
          process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor'
        );

        if (token && application.telegram_user_id) {
          await sendBookingNotification(
            token,
            Number(application.telegram_user_id),
            '✅ Arizangiz tasdiqlandi!\n\nEndi AVTODROM Instruktor Mini Appiga kirib, bronlaringiz va darslaringizni boshqarishingiz mumkin.',
            miniAppUrl,
            '👨‍🏫 Instruktor panelini ochish'
          );
        }
      } catch (notifyError) {
        console.error('Instructor approval notification failed:', notifyError);
      }

      return { ok: true, application: rows };
    } catch (e: any) {
      console.error('Instructor approval failed:', e);
      return reply.code(400).send({
        ok: false,
        error: e.message || 'Tasdiqlash amalga oshmadi'
      });
    }
  });

  app.post('/api/admin/instructor-applications/:id/reject', async (request, reply) => {
    try {
      const admin = await adminProfile(await authenticate(request));
      const applicationId = String((request.params as any).id);
      const reason = String((request.body as any)?.reason || '').trim() || null;

      const applications = await supabaseRest<any[]>('instructor_applications', {
        query: `?id=eq.${q(applicationId)}&select=*`
      });
      const application = applications[0];
      if (!application) {
        return reply.code(404).send({ ok: false, error: 'Ariza topilmadi' });
      }

      const rows = await supabaseRest<any[]>('rpc/admin_reject_instructor', {
        method: 'POST',
        body: JSON.stringify({
          p_application_id: applicationId,
          p_admin_id: admin.id,
          p_reason: reason
        })
      });

      try {
        const token = String(process.env.INSTRUCTOR_BOT_TOKEN || '');
        const miniAppUrl = String(
          process.env.INSTRUCTOR_MINI_APP_URL || 'https://avtodrom.vercel.app/instructor'
        );

        if (token && application.telegram_user_id) {
          await sendBookingNotification(
            token,
            Number(application.telegram_user_id),
            `❌ Arizangiz rad etildi.${reason ? `\n\nSabab: ${reason}` : ''}\n\nMa'lumotlarni to‘g‘rilab, qayta ariza yuborishingiz mumkin.`,
            miniAppUrl,
            '📝 Qayta ariza yuborish'
          );
        }
      } catch (notifyError) {
        console.error('Instructor rejection notification failed:', notifyError);
      }

      return { ok: true, application: rows };
    } catch (e: any) {
      console.error('Instructor rejection failed:', e);
      return reply.code(400).send({
        ok: false,
        error: e.message || 'Rad etish amalga oshmadi'
      });
    }
  });
}
