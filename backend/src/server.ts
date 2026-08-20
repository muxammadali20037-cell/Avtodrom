import { app } from './app.js';

const PORT = Number(process.env.PORT || 3000);

await app.listen({ port: PORT, host: '0.0.0.0' });
