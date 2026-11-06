import {afterEach,expect,test,vi} from 'vitest';
const f=vi.hoisted(()=>({session:vi.fn(),account:vi.fn()}));
vi.mock('@/lib/auth/login',()=>({getLoginSession:f.session}));
vi.mock('@/lib/db/accounts',()=>({userByAuthUserId:f.account}));
import {GET} from '@/app/api/cid/[slug]/work-decks/route';
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.resetAllMocks();});
test('pilot-staging returns not found and never reaches a production origin',async()=>{
 vi.stubEnv('RAILWAY_ENVIRONMENT_NAME','pilot-staging');
 const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
 const res=await GET(new Request('https://login.test/api/cid/brandingcentres/work-decks',{headers:{origin:'https://cid-brandingcentres.10xid.com'}}),{params:Promise.resolve({slug:'brandingcentres'})});
 expect(res.status).toBe(404);
 expect(fetchMock).not.toHaveBeenCalled();
 expect(f.session).not.toHaveBeenCalled();
});
