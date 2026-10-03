import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openSelectedPdf } from '../file-actions.mjs';

const info={sourcePath:'C:\\Synthetic\\A & B, sample.pdf',documentId:'fixture'};
const store={describe:async()=>info};
test('file actions use fixed executables and literal path arguments, never a shell',async()=>{
  const calls=[];
  function launch(...args){calls.push(args);const p=new EventEmitter();p.unref=()=>{};queueMicrotask(()=>p.emit('spawn'));return p;}
  await openSelectedPdf(store,'host-path',{documentId:'fixture',action:'folder'},launch,'win32');
  await openSelectedPdf(store,'host-path',{documentId:'fixture',action:'default'},launch,'win32');
  assert.equal(calls[0][0],'explorer.exe');
  assert.deepEqual(calls[0][1],[`/select,${info.sourcePath}`]);
  assert.deepEqual(calls[1][1],['url.dll,FileProtocolHandler',info.sourcePath]);
  assert.equal(calls[0][2].shell,false);
});
test('wrong document and unsupported actions never launch programs',async()=>{
  const launch=()=>assert.fail('must not launch');
  await assert.rejects(()=>openSelectedPdf(store,'x',{documentId:'wrong',action:'folder'},launch,'win32'),/context mismatch/);
  await assert.rejects(()=>openSelectedPdf(store,'x',{documentId:'fixture',action:'delete'},launch,'win32'),/Invalid/);
  await assert.rejects(()=>openSelectedPdf(store,'x',{documentId:'fixture',action:'folder'},launch,'linux'),/Windows/);
});
