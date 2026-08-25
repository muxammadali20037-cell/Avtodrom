import { requireAdmin, rest } from '../media/_auth.js';

export default async function handler(request: any, response: any) {
  try {
    requireAdmin(request);
    if (request.method !== 'GET') {
      response.statusCode = 405;
      response.setHeader('Allow', 'GET');
      response.end(JSON.stringify({ ok:false, error:'Method not allowed' }));
      return;
    }

    const media = await rest('admin_media', {
      query: '?select=*&order=sort_order.asc,created_at.desc',
    });

    response.statusCode = 200;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok:true, media }));
  } catch (error) {
    response.statusCode = error instanceof Error && error.message === 'Unauthorized' ? 401 : 500;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify({ ok:false, error:error instanceof Error ? error.message : 'Media load failed' }));
  }
}
