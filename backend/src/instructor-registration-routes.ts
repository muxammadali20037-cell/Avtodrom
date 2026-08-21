import type { FastifyInstance } from 'fastify';
import { instructorRegistrationStatus, submitInstructorRegistration } from './instructor-registration.js';
import type { TelegramWebAppUser } from './telegram.js';

export function registerInstructorRegistrationRoutes(app: FastifyInstance, authenticate: (request:any)=>Promise<TelegramWebAppUser>) {
  app.get('/api/instructor/registration', async (request, reply) => {
    try { return { ok:true, registration: await instructorRegistrationStatus(await authenticate(request)) }; }
    catch (e:any) { return reply.code(401).send({ok:false,error:e.message || 'Authentication failed'}); }
  });

  app.post<{Body:{firstName?:string;lastName?:string;phone?:string;experienceYears?:number;message?:string}}>('/api/instructor/registration', async (request, reply) => {
    try {
      const b=request.body||{};
      if (!b.firstName?.trim() || !b.lastName?.trim() || !b.phone?.trim()) return reply.code(400).send({ok:false,error:'Ism, familiya va telefon raqami majburiy'});
      const result=await submitInstructorRegistration(await authenticate(request), {firstName:b.firstName.trim(),lastName:b.lastName.trim(),phone:b.phone.trim(),experienceYears:b.experienceYears,message:b.message});
      return {ok:true,registration:result};
    } catch(e:any) { return reply.code(400).send({ok:false,error:e.message||'Ariza yuborilmadi'}); }
  });
}
