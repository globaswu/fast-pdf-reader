import { spawn } from 'node:child_process';

// This is intentionally not a general launcher: the host-selected PDF is
// validated again and the executable/arguments are fixed for these two actions.
export async function openSelectedPdf(store, sourcePath, {documentId, action}, launch=spawn, platform=process.platform) {
  if (platform !== 'win32') throw new Error('External file actions require Windows on this build.');
  if (!['folder','default'].includes(action)) throw new Error('Invalid external file action.');
  const info=await store.describe(sourcePath);
  if(info.documentId!==documentId) throw new Error('Document changed or context mismatch; reload required.');
  const executable=action==='folder'?'explorer.exe':'rundll32.exe';
  const args=action==='folder'?[`/select,${info.sourcePath}`]:['url.dll,FileProtocolHandler',info.sourcePath];
  await new Promise((resolve,reject)=>{
    const child=launch(executable,args,{shell:false,detached:true,stdio:'ignore',windowsHide:false});
    child.once('error',reject);
    child.once('spawn',()=>{child.unref();resolve();});
  });
  return {opened:true,action};
}
