import {companyBlogs} from '@/lib/cid/blogs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{slug:string}>}){
 return companyBlogs(request,(await params).slug,'workspace',true);
}
