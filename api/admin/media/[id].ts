import { requireAdmin, rest, supabaseConfig, BUCKET } from './_auth.js';

export default async function handler(request:any,response:any){
  try{
    requireAdmin(request);
    if(request.method!=='DELETE'){
      response.statusCode=405;response.setHeader('Allow','DELETE');
      response.end(JSON.stringify({ok:false,error:'Method not allowed'}));return;
    }
    const id=String((request.query as any)?.id || '').trim();
    if(!id){response.statusCode=400;response.end(JSON.stringify({ok:false,error:'Media ID required'}));return;}
    const rows:any[]=await rest('admin_media',{query:`?id=eq.${encodeURIComponent(id)}&select=*`});
    if(!rows[0]){response.statusCode=404;response.end(JSON.stringify({ok:false,error:'Media topilmadi'}));return;}
    const {url,key}=supabaseConfig();
    const storage=await fetch(`${url}/storage/v1/object/${BUCKET}/${rows[0].storage_path}`,{method:'DELETE',headers:{apikey:key,Authorization:`Bearer ${key}`}});
    if(!storage.ok) throw new Error(`Storage delete ${storage.status}`);
    await rest('admin_media',{method:'DELETE',query:`?id=eq.${encodeURIComponent(id)}`});
    response.statusCode=200;response.setHeader('content-type','application/json');
    response.end(JSON.stringify({ok:true}));
  }catch(error){
    const status=error instanceof Error && (error.message==='Unauthorized'||error.message==='Session expired')?401:500;
    response.statusCode=status;response.setHeader('content-type','application/json');
    response.end(JSON.stringify({ok:false,error:error instanceof Error?error.message:'Media delete failed'}));
  }
}
