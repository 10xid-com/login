import {defineConfig} from 'vitest/config';
import {resolve} from 'node:path';
export default defineConfig({resolve:{alias:{'@':resolve(import.meta.dirname,'.'),'server-only':resolve(import.meta.dirname,'test/stubs/server-only.ts')}},
 test:{include:['test/cid-*.test.ts'],environment:'node',fileParallelism:false,testTimeout:20000}});
