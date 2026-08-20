import { app } from './app.js';
import { startCustomerPolling } from './telegram.js';

const PORT = Number(process.env.PORT || 3000);
const CUSTOMER_BOT_TOKEN = process.env.CUSTOMER_BOT_TOKEN || '';
const MINI_APP_URL = process.env.MINI_APP_URL || '';

await app.listen({ port: PORT, host: '0.0.0.0' });

if (CUSTOMER_BOT_TOKEN && MINI_APP_URL) {
  void startCustomerPolling(CUSTOMER_BOT_TOKEN, MINI_APP_URL);
} else {
  app.log.warn('CUSTOMER_BOT_TOKEN or MINI_APP_URL is missing; Telegram polling is disabled.');
}
