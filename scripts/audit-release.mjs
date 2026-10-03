import {readdir,readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=fileURLToPath(new URL('../',import.meta.url));
const ignore=new Set(['.git','node_modules','dist','release','.release-staging']);
const forbiddenExtensions=/\.(?:pdf|pdfprobe|pftrace|wav|mp3|mp4|log|asar|exe|zip)$/i;
const privatePatterns=[/[A-Z]:[\\/]Users[\\/](?!Public(?:[\\/]|$))[^\\/\s]+/i,/OneDrive[\\/](?:Desktop|Documents)|codex-trace-/i,
  /(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{20,}/,/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/];
let files=0,bytes=0;
async function visit(directory){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(directory===root&&ignore.has(entry.name))continue;
    const full=path.join(directory,entry.name),relative=path.relative(root,full);
    const stat=await lstat(full);
    assert.ok(!stat.isSymbolicLink(),`No symlinks in release: ${relative}`);
    if(entry.isDirectory()){await visit(full);continue;}
    assert.ok(!forbiddenExtensions.test(entry.name),`Unexpected document/binary: ${relative}`);
    assert.ok(!/^\.env(?:\.|$)/.test(entry.name),`Environment file: ${relative}`);
    files++;bytes+=stat.size;
    if(/\.(?:mjs|js|json|html|css|md|txt|ya?ml|svg)$/i.test(entry.name)||['LICENSE','.gitignore'].includes(entry.name)){
      const content=await readFile(full,'utf8');
      // The scanner necessarily contains its own detection patterns.
      if(relative!==path.join('scripts','audit-release.mjs'))for(const pattern of privatePatterns)assert.ok(!pattern.test(content),`Potential private material in ${relative}`);
    }
  }
}
await visit(root);
const runtime=path.join(root,'plugins','fast-pdf-reader');
const manifest=JSON.parse(await readFile(path.join(runtime,'.codex-plugin','plugin.json'),'utf8'));
assert.equal(manifest.name,'fast-pdf-reader');assert.equal(manifest.interface.displayName,'Fast PDF Reader');assert.equal(manifest.license,'MIT');
const mcp=JSON.parse(await readFile(path.join(runtime,'.mcp.json'),'utf8'));
assert.equal(mcp.mcpServers['fast-pdf-reader'].command,'node');
assert.deepEqual(mcp.mcpServers['fast-pdf-reader'].args,['./server.mjs']);
for(const name of ['LICENSE','PRIVACY.md','dist/ui.html','vendor/pdfium/pdfium.wasm'])await lstat(path.join(runtime,name));
const notices=await readdir(path.join(runtime,'licenses'));
assert.ok(notices.some(name=>name.toLowerCase().includes('pdfium')));
console.log(JSON.stringify({files,bytes,privateMaterialMatches:0,portableNodeCommand:true,licence:'MIT',displayName:manifest.interface.displayName},null,2));
