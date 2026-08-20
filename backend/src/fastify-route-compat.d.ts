// Vercel's function TypeScript compiler can resolve a reduced FastifyInstance type.
// Keep the runtime implementation unchanged while allowing the existing route
// registration methods used by admin-password-routes.ts to type-check.
import 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    [key: string]: any;
  }
}
