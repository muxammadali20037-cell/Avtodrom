import type { FastifyInstance } from 'fastify';
import type { TelegramWebAppUser } from './telegram.js';

export async function registerAdminRoutes(
  _app: FastifyInstance,
  _authenticate: (request: any) => Promise<TelegramWebAppUser>,
) {
  // Admin API will be added in the admin Mini App stage.
}
