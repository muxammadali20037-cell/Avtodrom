import { rest } from './admin/media/_auth.js';

export default async function handler(_request:any,response:any){
  try{
    const media=await rest('admin_media',{
      query:'?is_active=eq.true&select=id,key,title,media_type,public_url,sort_order,created_at&order=sort_order.asc,created_at.desc',
    });
    response.statusCode=200;
    response.setHeader('content-type','application/json; charset=utf-8');
    response.setHeader('cache-control','public, max-age=30, s-maxage=60, stale-while-revalidate=300');
    response.end(JSON.stringify({ok:true,media}));
  }catch(error){
    response.statusCode=500;
    response.setHeader('content-type','application/json; charset=utf-8');
    response.end(JSON.stringify({ok:false,error:'Content load failed'}));
  }
}
