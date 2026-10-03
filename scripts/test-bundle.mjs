import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const result=spawnSync(process.execPath,['--test','test/server-stdio.test.mjs'],{
  cwd:root,stdio:'inherit',env:{...process.env,FAST_PDF_TEST_BUNDLED:'1'},
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
