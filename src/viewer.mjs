import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { PDFViewer, EventBus, PDFLinkService, PDFFindController } from 'pdfjs-dist/web/pdf_viewer.mjs';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';
import { createFeedbackController } from './feedback.mjs';
import { createMotionDiagnostics, snapshotCanvasSurfaces, planCanvasEvictions } from './render-budget.mjs';
import { PagePreviewController } from './preview-controller.mjs';
import { BlockRangeReader } from './range-reader.mjs';
import { EarlyTextLayerController } from './early-text-layer.mjs';
import { closePdfWorker } from './worker-lifecycle.mjs';
import { initializeToolbar } from './toolbar.mjs';

const $ = id => document.getElementById(id);
const disposeToolbar=initializeToolbar(document);
window.addEventListener('pagehide',disposeToolbar,{once:true});
const preview = new URL(location.href).searchParams.get('preview') === '1';
const app = preview ? null : new App({name:'fast-pdf-reader',version:'1.0.0'}, {}, {autoResize:false});
const extensions = app ? new OpenAIExtensions(app) : null;
const state = {info:null, resourceUri:null, task:null, doc:null, range:null,
  outlineLoaded:false, connected:preview, pendingOpen:false, generation:0, disposed:false, localFile:null, workerStatus:'not-started'};
const metrics = {rangeRequests:0, bytesRead:0, pagesRendered:0, longTasks:0, longTaskMs:0, openedAt:0, firstPageMs:null};
const container = $('viewer-container');
const motion=createMotionDiagnostics();
container.addEventListener('scroll',motion.noteInput,{passive:true});
container.addEventListener('wheel',motion.noteInput,{passive:true});
const eventBus = new EventBus();
const linkService = new PDFLinkService({eventBus, externalLinkTarget:2, externalLinkRel:'noopener noreferrer'});
const findController = new PDFFindController({eventBus,linkService});
const pdfViewer = new PDFViewer({
  container, viewer:$('viewer'), eventBus, linkService, findController,
  // Mozilla's native overflow/viewport queue stays in control. There is no
  // scroll-end debounce, custom scroll simulation, or whole-document prerender.
  textLayerMode:1, annotationMode:1, enablePermissions:true,
  maxCanvasPixels:4 * 1024 * 1024, enableDetailCanvas:true,
  minDurationToUpdateCanvas:0, enableAutoLinking:false,
});
linkService.setViewer(pdfViewer);
const previewStatus=document.createElement('span');previewStatus.id='preview-status';previewStatus.style.cssText='flex:none;font-size:11px';
$('status').after(previewStatus);
const previews=new PagePreviewController({pdfViewer,eventBus,getPinnedPages:()=>feedback.pinnedPages(),getWasm:async()=>decodeBase64((await callTool('pdf_asset',{kind:'preview_engine',name:'pdfium.wasm'})).base64),onProgress:info=>{
  previewStatus.textContent=info.state==='loading'?'Preparing fast-scroll cache…':info.state==='preparing'?`Page previews ${info.preparedPages}/${info.pageCount}`:info.state==='ready'?'Fast-scroll cache ready':info.state==='failed'?'Preview cache unavailable':'';
}});
const feedback=createFeedbackController({container,pdfViewer,getDocumentInfo:()=>state.info,getResourceUri:()=>state.localFile?null:state.resourceUri,app,extensions,status});
const earlyText=new EarlyTextLayerController({pdfViewer,eventBus,container,TextLayer:pdfjs.TextLayer,normalizeUnicode:pdfjs.normalizeUnicode,isSelectionPinned:div=>feedback.isSelectionPinned(div)});

function status(message, error=false) { $('status').textContent=message; $('status').dataset.error=String(error); }
function decodeBase64(value) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(value);
  const binary=atob(value), bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes;
}
async function callTool(name,args={}) {
  let result;
  if(preview) {
    const token=document.querySelector('meta[name="local-preview-token"]')?.content;
    if(!token) throw new Error('Preview token is missing; start the local preview server.');
    const response=await fetch('/api/tool',{method:'POST',headers:{'Content-Type':'application/json','X-Preview-Token':token},body:JSON.stringify({name,arguments:args})});
    if(!response.ok) throw new Error(`Local ${name} failed (${response.status}).`);
    result=await response.json();
  } else result=await app.callServerTool({name,arguments:args});
  if(result.isError || !result.structuredContent){
    const detail=(result.content||[]).filter(item=>item.type==='text').map(item=>item.text).join(' ').trim();
    const error=new Error(detail||`Local ${name} returned no structured data (response fields: ${Object.keys(result||{}).join(', ')||'none'}).`);
    error.code=result._meta?.localPdfErrorCode||(detail==='The desktop host has not supplied local file context.'?'MISSING_HOST_FILE_CONTEXT':null);
    throw error;
  }
  return result.structuredContent;
}

class LocalRangeTransport extends pdfjs.PDFDataRangeTransport {
  constructor(info,onError) {
    super(info.size,null,true,info.name);this.aborted=false;this.onError=onError;
    this.reader=new BlockRangeReader({size:info.size,readAheadBlocks:0,readChunk:async(begin,end)=>{
      const result=await callTool('pdf_read',{documentId:info.documentId,begin,end});
      const bytes=decodeBase64(result.base64);
      if(result.begin!==begin||bytes.length!==end-begin)throw new Error('PDF range length or position mismatch. Reload the document.');
      metrics.rangeRequests++;metrics.bytesRead+=bytes.length;return bytes;
    }});
  }
  requestDataRange(begin,end){this.reader.read(begin,end).then(data=>{if(!this.aborted)this.onDataRange(begin,data);}).catch(error=>{if(!this.aborted)this.onError(error);});}
  abort(){this.aborted=true;this.reader.abort();}
}
class LocalBinaryDataFactory {
  async fetch({kind,filename}) {
    const kinds={cMapUrl:'cmaps',standardFontDataUrl:'standard_fonts',wasmUrl:'wasm'};
    if(!kinds[kind])throw new Error('Unsupported local PDF asset type.');
    const result=await callTool('pdf_asset',{kind:kinds[kind],name:filename});
    return decodeBase64(result.base64);
  }
}

let workerUrl=null;
function createWorker(kind='graphics') {
  workerUrl ||= URL.createObjectURL(new Blob([__PDF_WORKER_SOURCE__],{type:'text/javascript'}));
  // A real module worker is mandatory. No silent main-thread fake-worker fallback.
  const workerField=kind==='text'?'textWorker':'worker',taskField=kind==='text'?'textTask':'task',statusField=kind==='text'?'textWorkerStatus':'workerStatus';
  const worker=new Worker(workerUrl,{type:'module',name:kind==='text'?'local-pdf-selectable-text':'local-pdfjs-renderer'});
  state[statusField]='starting';
  worker.addEventListener('error',()=>{if(state[workerField]!==worker)return;state[statusField]='failed';worker.terminate();state[workerField]=null;const failedTask=state[taskField];state[taskField]=null;failedTask?.destroy().catch(()=>{});status(kind==='text'?'The independent text worker failed; the standard text layer remains available.':'The local PDF worker could not start or stopped. No main-thread fallback was used.',true);if(kind==='text'&&state.doc)void earlyText.setDocument(state.doc);});
  return worker;
}
async function prepareIndependentText(bytes,generation){
  if(generation!==state.generation)return;
  const textWorker=createWorker('text');state.textWorker=textWorker;
  let task;
  try{
    const worker=pdfjs.PDFWorker.create({port:textWorker});await worker.promise;
    if(generation!==state.generation){await closePdfWorker(null,textWorker);return;}
    task=pdfjs.getDocument({data:bytes,worker,disableAutoFetch:true,disableStream:true,useWorkerFetch:false,BinaryDataFactory:LocalBinaryDataFactory,
      cMapUrl:'local-assets:/cmaps/',cMapPacked:true,standardFontDataUrl:'local-assets:/standard_fonts/',wasmUrl:'local-assets:/wasm/',isEvalSupported:false,enableXfa:false});
    state.textTask=task;const textDocument=await task.promise;
    if(generation!==state.generation){await closePdfWorker(task,textWorker);return;}
    const accepted=await earlyText.useExtractionDocument(textDocument);
    if(generation===state.generation&&accepted)state.textWorkerStatus='ready';
    else {await closePdfWorker(task,textWorker);}
  }catch(error){
    await closePdfWorker(task,textWorker);
    if(generation!==state.generation)return;
    state.textWorkerStatus='failed';state.textWorkerError=error.message;
    if(state.textWorker===textWorker)state.textWorker=null;
    if(state.textTask===task)state.textTask=null;
  }
}
async function openDocument() {
  if(!state.connected) {state.pendingOpen=true;return;}
  const generation=++state.generation;
  const previousPage=state.resetPage?1:pdfViewer.currentPageNumber || 1;
  state.resetPage=false;
  status('Opening the local PDF…');
  previews.stop();
  earlyText.stop();
  const priorTextTask=state.textTask;state.textTask=null;
  const priorTextWorker=state.textWorker;state.textWorker=null;state.textWorkerStatus='not-started';
  state.textWorkerError=null;
  feedback.onViewChanged();
  const previousRange=state.range;state.range=null;previousRange?.abort();
  state.doc=null;
  pdfViewer.setDocument(null); linkService.setDocument(null); findController.setDocument(null);
  const previousTask=state.task;state.task=null;
  const previousWorker=state.worker;state.worker=null;
  state.workerStatus='terminated';
  // Detach every old handle before awaiting cleanup: overlapping reloads must
  // never resume and accidentally destroy the newer document's live workers.
  await Promise.all([
    closePdfWorker(priorTextTask,priorTextWorker),
    closePdfWorker(previousTask,previousWorker),
  ]);
  if(generation!==state.generation)return;
  let info,data;
  if(state.localFile){
    state.sourceKind='local-file';
    const file=state.localFile;
    if(file.size>512*1024*1024)throw new Error('The local file picker is limited to 512 MiB; use a host file entrypoint for larger files.');
    data=new Uint8Array(await file.arrayBuffer());
    const digest=await crypto.subtle.digest('SHA-256',data);
    const documentId=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    info={documentId,name:file.name,size:file.size,modifiedMs:file.lastModified,sourcePath:null};
  }else{
    try{info=await callTool('pdf_info');state.sourceKind='host-path';}
    catch(error){
      if(error.code!=='MISSING_HOST_FILE_CONTEXT'||!extensions?.resources||!state.resourceUri)throw error;
      // Public host-owned resource access is the primary standard file API.
      // Use it only when the host omitted its optional server filesystem path;
      // never as a fallback for denied access or an unrelated filesystem error.
      const resource=await extensions.resources.read({uri:state.resourceUri,representation:'blob'});
      const content=resource.contents.find(item=>item.uri===state.resourceUri&&typeof item.blob==='string')||(resource.contents.length===1&&typeof resource.contents[0].blob==='string'?resource.contents[0]:null);
      if(!content)throw new Error('The host did not provide binary PDF data for the selected resource. Reopen the PDF or use Open PDF.');
      data=decodeBase64(content.blob);
      state.sourceKind='host-resource';
      const digest=await crypto.subtle.digest('SHA-256',data);
      info={documentId:Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''),name:state.resourceName||'Selected PDF',size:data.byteLength,modifiedMs:null,sourcePath:null};
    }
  }
  if(generation!==state.generation)return;
  if(!Number.isSafeInteger(info.size)||info.size<=0||typeof info.documentId!=='string')throw new Error('Invalid PDF metadata.');
  state.info=info; state.doc=null; state.outlineLoaded=false; $('outline').textContent='Open the outline to load bookmarks.';
  $('document-name').textContent=info.name; $('document-name').title=info.name; document.title=`${info.name} · Fast PDF Reader`;
  metrics.openedAt=performance.now(); metrics.firstPageMs=null;
  state.worker=createWorker();
  const worker=pdfjs.PDFWorker.create({port:state.worker});
  await worker.promise;
  if(generation!==state.generation){await worker.destroy();return;}
  state.workerStatus='ready';
  const range=data?null:new LocalRangeTransport(info,error=>{status(error.message,true);state.task?.destroy().catch(()=>{});});
  state.range=range;
  const task=pdfjs.getDocument({...(data?{data}:{range}),worker,rangeChunkSize:256*1024,enableHWA:true,
    disableAutoFetch:true,disableStream:true,useWorkerFetch:false,BinaryDataFactory:LocalBinaryDataFactory,
    cMapUrl:'local-assets:/cmaps/',cMapPacked:true,standardFontDataUrl:'local-assets:/standard_fonts/',wasmUrl:'local-assets:/wasm/',
    isEvalSupported:false,enableXfa:false,stopAtErrors:false});
  state.task=task;
  task.onPassword=()=>{status('Password-protected PDFs are not supported in this release.',true);task.destroy().catch(()=>{});};
  const loadedDocument=await task.promise;
  if(generation!==state.generation)return;
  state.doc=loadedDocument;
  feedback.onDocumentChanged();
  linkService.setDocument(state.doc);
  pdfViewer.setDocument(state.doc);
  void earlyText.setDocument(state.doc);
  const previewDocument=state.doc;
  // The browser worker prepares appearances independently; reading stays live.
  // PDF.js returns a new data buffer, not the one owned by its parsing worker.
  void previews.start({pageCount:state.doc.numPages,getBytes:async()=>{
    const bytes=await previewDocument.getData();
    if(generation!==state.generation)throw new Error('Document changed during preview preparation.');
    // Isolate text extraction from expensive graphics/image operator work.
    // Copy before either worker takes ownership of its transferable buffer.
    void prepareIndependentText(bytes.slice(),generation);
    return bytes;
  }});
  $('page-count').textContent=`/ ${state.doc.numPages}`; $('page-number').max=state.doc.numPages;
  $('empty-state').hidden=true;
  for(const id of ['previous','next','page-number','zoom-out','zoom','zoom-in','find-toggle','reload','region-toggle']) $(id).disabled=false;
  $('open-folder').disabled=preview||!info.sourcePath;
  $('open-default').disabled=preview||!info.sourcePath;
  await pdfViewer.firstPagePromise;
  if(generation!==state.generation)return;
  pdfViewer.currentScaleValue='page-width';
  pdfViewer.currentPageNumber=Math.min(previousPage,state.doc.numPages);
  status(`${state.doc.numPages} pages · Fast PDF Reader · ${info.sourcePath?'host-selected local file':state.sourceKind==='host-resource'?'host-selected resource (filesystem path unavailable)':'local file picker (full path not provided by browser)'}`);
  feedback.updateCapabilities();
  if(!$('outline-panel').hidden)loadOutline().catch(error=>status(error.message,true));
}
function requestOpen(){openDocument().catch(error=>status(`Unable to open PDF: ${error.message}`,true));}

eventBus.on('pagesinit',()=>{pdfViewer.currentScaleValue='page-width';});
eventBus.on('pagechanging',({pageNumber})=>{if(document.activeElement!==$('page-number'))$('page-number').value=pageNumber;feedback.onViewChanged();previews.setFocus(pageNumber);});
eventBus.on('pagerendered',({pageNumber,error})=>{
  if(error) {status(`Page ${pageNumber} did not render: ${error.message}`,true);return;}
  metrics.pagesRendered++;
  if(metrics.firstPageMs===null)metrics.firstPageMs=performance.now()-metrics.openedAt;
  const page=pdfViewer.getPageView(pageNumber-1)?.div;
  if(page) {page.dataset.sourcePage=String(pageNumber);page.setAttribute('aria-label',`${state.info?.name || 'PDF'}, physical page ${pageNumber}`);}
});
eventBus.on('textlayerrendered',({pageNumber})=>{
  const layer=pdfViewer.getPageView(pageNumber-1)?.div.querySelector('.textLayer');
  layer?.setAttribute('oai-annotation-container-text','');
});
eventBus.on('scalechanging',({scale,presetValue})=>{
  feedback.onViewChanged();
  previews.onViewportChanged();
  if(presetValue&&[...$('zoom').options].some(option=>option.value===presetValue))$('zoom').value=presetValue;
  else {const option=$('custom-zoom');option.hidden=false;option.textContent=`${Math.round(scale*100)}%`; $('zoom').value='custom';}
});
eventBus.on('updatefindmatchescount',({matchesCount})=>{$('find-count').textContent=`${matchesCount.current} / ${matchesCount.total}`;});
eventBus.on('updatefindcontrolstate',({state:findState})=>{if(findState===1)$('find-count').textContent='No matches';});
$('previous').onclick=()=>{pdfViewer.currentPageNumber=Math.max(1,pdfViewer.currentPageNumber-1);};
$('next').onclick=()=>{pdfViewer.currentPageNumber=Math.min(state.doc.numPages,pdfViewer.currentPageNumber+1);};
function navigatePage(){const page=Number($('page-number').value);if(Number.isInteger(page)&&page>=1&&page<=state.doc.numPages)pdfViewer.currentPageNumber=page;else $('page-number').value=pdfViewer.currentPageNumber;}
$('page-number').onchange=navigatePage;
$('page-number').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();navigatePage();$('page-number').blur();}};
$('zoom').onchange=()=>{if($('zoom').value!=='custom')pdfViewer.currentScaleValue=$('zoom').value;};
$('zoom-in').onclick=()=>pdfViewer.increaseScale({steps:1});
$('zoom-out').onclick=()=>pdfViewer.decreaseScale({steps:1});
$('reload').onclick=requestOpen;
$('choose-file').onclick=()=>$('local-file-input').click();
$('local-file-input').onchange=()=>{const file=$('local-file-input').files?.[0];if(file){state.localFile=file;state.resetPage=true;requestOpen();}};
for(const [id,action] of [['open-folder','folder'],['open-default','default']])$(id).onclick=()=>{
  if(!state.info?.sourcePath)return;
  callTool('pdf_open_external',{documentId:state.info.documentId,action}).then(()=>status(action==='folder'?'Opened the PDF location in Explorer.':'Requested the default PDF application.')).catch(error=>status(error.message,true));
};
function showFind(show=true){$('findbar').hidden=!show;$('find-toggle').setAttribute('aria-expanded',String(show));if(show)$('find-query').focus();else eventBus.dispatch('findbarclose',{source:window});}
function find(again=false,previous=false){eventBus.dispatch('find',{source:window,type:again?'again':'',query:$('find-query').value,caseSensitive:$('find-case').checked,entireWord:false,highlightAll:true,findPrevious:previous,matchDiacritics:false});}
$('find-toggle').onclick=()=>showFind($('findbar').hidden);$('find-close').onclick=()=>showFind(false);
$('find-query').oninput=()=>find();$('find-case').onchange=()=>find();
$('find-next').onclick=()=>find(true);$('find-previous').onclick=()=>find(true,true);
$('find-query').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();find(true,event.shiftKey);}};
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='f'&&!$('feedback-dialog').open){event.preventDefault();showFind();}if(event.key==='Escape'&&!$('feedback-dialog').open)showFind(false);});

async function loadOutline() {
  if(!state.doc||state.outlineLoaded)return;
  state.outlineLoaded=true;
  const items=await state.doc.getOutline();
  $('outline').replaceChildren();
  if(!items?.length){$('outline').textContent='This PDF has no bookmarks. Use page entry or Find.';return;}
  function list(entries){const ul=document.createElement('ul');for(const item of entries){const li=document.createElement('li'),button=document.createElement('button');button.textContent=item.title;button.onclick=()=>{if(item.dest)linkService.goToDestination(item.dest);else if(item.url)openExternal(item.url);};li.append(button);if(item.items?.length)li.append(list(item.items));ul.append(li);}return ul;}
  $('outline').append(list(items));
}
$('outline-toggle').onclick=()=>{$('outline-panel').hidden=!$('outline-panel').hidden;$('outline-toggle').setAttribute('aria-expanded',String(!$('outline-panel').hidden));if(!$('outline-panel').hidden)loadOutline().catch(error=>status(error.message,true));pdfViewer.update();};
function openExternal(url) {try{const parsed=new URL(url);if(!['https:','http:','mailto:'].includes(parsed.protocol))throw new Error('Unsupported external-link protocol.');if(app)app.openLink({url:parsed.href}).catch(error=>status(error.message,true));else window.open(parsed.href,'_blank','noopener,noreferrer');}catch(error){status(error.message,true);}}
container.addEventListener('click',event=>{const a=event.target.closest('a[href]');if(a&&/^https?:|^mailto:/i.test(a.href)){event.preventDefault();event.stopPropagation();openExternal(a.href);}},true);

let subscribedUri=null,removeUpdateHandler=null;
async function subscribeToFile(){
  if(!extensions?.resources||!state.resourceUri||state.localFile)return;
  if(subscribedUri===state.resourceUri)return;
  if(subscribedUri)await extensions.resources.unsubscribe({uri:subscribedUri}).catch(()=>{});
  removeUpdateHandler?.();
  subscribedUri=state.resourceUri;
  removeUpdateHandler=extensions.resources.addUpdateHandler(notification=>{
    if(notification.params.uri===subscribedUri&&!state.localFile){$('reload').classList.add('file-changed');status('The PDF changed on disk. Reload when ready; the current view and unsent requests are preserved.');}
  });
  await extensions.resources.subscribe({uri:subscribedUri}).catch(()=>{status('Automatic file-change notifications are unavailable; use Reload after rebuilding the PDF.');});
}
function applyContext(context){if(context?.theme)applyDocumentTheme(context.theme);if(context?.styles?.variables)applyHostStyleVariables(context.styles.variables);feedback.updateCapabilities();}
if(app){
  app.ontoolinput=({arguments:args})=>{const input=OpenAIFileEntrypointInputSchema.safeParse(args);if(!input.success){status('Choose Open PDF to read a local file. PDF rendering stays local.');return;}state.localFile=null;state.resourceUri=input.data.file.resourceUri;state.resourceName=input.data.file.name;requestOpen();subscribeToFile().catch(()=>{});};
  app.ontoolresult=()=>{};
  app.addEventListener('hostcontextchanged',applyContext);
  app.connect().then(()=>{state.connected=true;applyContext(app.getHostContext());if(state.pendingOpen){state.pendingOpen=false;requestOpen();}subscribeToFile().catch(()=>{});}).catch(error=>status(`Codex viewer connection failed: ${error.message}`,true));
} else requestOpen();
let longTaskObserver;
if('PerformanceObserver' in window)try{longTaskObserver=new PerformanceObserver(list=>{for(const entry of list.getEntries()){metrics.longTasks++;metrics.longTaskMs+=entry.duration;motion.recordLongTask(entry.startTime,entry.duration);}});longTaskObserver.observe({type:'longtask',buffered:true});}catch{}
const CANVAS_TARGET=192*1024*1024;
function enforceCanvasBudget(){
  const views=[...pdfViewer.getCachedPageViews()],visible=container.getBoundingClientRect();
  const protectedPageIds=views.filter(view=>{const r=view.div.getBoundingClientRect();return r.bottom>visible.top&&r.top<visible.bottom;}).map(view=>view.id);
  const surface=snapshotCanvasSurfaces(views);
  const plan=planCanvasEvictions({pages:surface.pages,protectedPageIds,maxBytes:CANVAS_TARGET});
  for(const id of plan.evictPageIds)pdfViewer.getPageView(id-1)?.destroy();
}
eventBus.on('pagerendered',enforceCanvasBudget);
let lastWidth=0,lastHeight=0;
const resizeObserver=new ResizeObserver(()=>{
  const w=container.clientWidth,h=container.clientHeight;
  if(w===lastWidth&&h===lastHeight)return;lastWidth=w;lastHeight=h;
  feedback.onViewChanged();
  previews.onViewportChanged();
  if(state.doc&&['auto','page-width','page-fit'].includes(pdfViewer.currentScaleValue))pdfViewer.currentScaleValue=pdfViewer.currentScaleValue;
});
resizeObserver.observe(container);
// Read-only local diagnostics for the manual test harness, never model context.
function diagnosticSnapshot(){return{version:'1.0.0',pdfjsVersion:pdfjs.version,preview,physicalPage:pdfViewer.currentPageNumber,pageCount:state.doc?.numPages||0,scale:pdfViewer.currentScale,workerStatus:state.workerStatus,textWorkerStatus:state.textWorkerStatus,textWorkerError:state.textWorkerError,metrics:{...metrics},motion:motion.snapshot(),previews:previews.snapshot(),earlyText:earlyText.snapshot(),byteReader:state.range?.reader.snapshot(),surfaces:snapshotCanvasSurfaces(pdfViewer.getCachedPageViews()),canvasTargetBytes:CANVAS_TARGET,host:app?.getHostVersion?.(),hostCapabilities:app?.getHostCapabilities?.(),feedback:feedback.diagnostics()};}
Object.defineProperty(window,'localPdfDiagnostics',{value:diagnosticSnapshot});
const diagnosticButton=document.createElement('button');diagnosticButton.textContent='Refresh diagnostics';diagnosticButton.id='refresh-diagnostics';
const diagnosticOutput=document.createElement('pre');diagnosticOutput.id='diagnostic-output';diagnosticOutput.style.cssText='max-height:160px;overflow:auto;white-space:pre-wrap';
diagnosticButton.onclick=()=>{diagnosticOutput.textContent=JSON.stringify(diagnosticSnapshot(),null,2);};$('capabilities').append(diagnosticButton,diagnosticOutput);
window.addEventListener('pagehide',()=>{state.disposed=true;earlyText.dispose();previews.dispose();removeUpdateHandler?.();if(subscribedUri)extensions?.resources?.unsubscribe({uri:subscribedUri}).catch(()=>{});resizeObserver.disconnect();longTaskObserver?.disconnect();motion.dispose();feedback.dispose();state.range?.abort();state.task?.destroy().catch(()=>{});state.textTask?.destroy().catch(()=>{});state.textWorker?.terminate();state.worker?.terminate();state.workerStatus='terminated';if(workerUrl)URL.revokeObjectURL(workerUrl);},{once:true});
feedback.updateCapabilities();
