import { build, transform } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const worker = await readFile(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'), 'utf8');
const previewWorker=await build({absWorkingDir:root,entryPoints:['src/preview-worker.mjs'],bundle:true,write:false,format:'esm',platform:'browser',target:['chrome124'],minify:true,legalComments:'inline'});
const js = await build({
  absWorkingDir:root, entryPoints:['src/viewer.mjs'], bundle:true, write:false,
  format:'esm', platform:'browser', target:['chrome124'], minify:true,
  legalComments:'inline', define:{__PDF_WORKER_SOURCE__:JSON.stringify(worker),__PREVIEW_WORKER_SOURCE__:JSON.stringify(previewWorker.outputFiles[0].text)},
});
const css = await build({
  absWorkingDir:root, entryPoints:['src/viewer.css'], bundle:true, write:false,
  minify:true, loader:{'.svg':'dataurl','.png':'dataurl','.gif':'dataurl'},
});
const shell = await readFile(path.join(root, 'src/shell.html'), 'utf8');
const html = shell.replace('/* INLINE_STYLE */', () => css.outputFiles[0].text.replaceAll('</style', '<\\/style'))
  .replace('/* INLINE_SCRIPT */', () => js.outputFiles[0].text.replaceAll('</script', '<\\/script'));
const script=html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
if(!script)throw new Error('Built UI script is missing.');
await transform(script,{loader:'js',target:'chrome124',format:'esm'});
await mkdir(path.join(root,'dist'), {recursive:true});
await writeFile(path.join(root,'dist/ui.html'), html);
console.log(`Built dist/ui.html (${Buffer.byteLength(html)} bytes), including local Mozilla worker and inline styles.`);
