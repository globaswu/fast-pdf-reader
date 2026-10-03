import { PreviewCache, previewPriority } from './preview-cache.mjs';
import { SharpCache, SharpScheduler, sharpTargetWidth, choosePageAppearance } from './sharp-scheduler.mjs';

/** Persistent page appearances independent of PDF.js's evicted sharp canvases. */
export class PagePreviewController {
  constructor({pdfViewer,eventBus,getWasm,onProgress=()=>{},width=1200,enableSharp=true,getPinnedPages=()=>[]}){
    Object.assign(this,{pdfViewer,eventBus,getWasm,onProgress,width,enableSharp,getPinnedPages});
    this.generation=0;this.focus=1;this.direction=1;this.pageCount=0;this.sequence=0;
    this.worker=null;this.pending=new Map();this.prepared=new Set();this.failed=new Set();this.deferred=new Set();this.mounted=new Set();
    this.mountedUrls=new Map();this.visiblePages=[];
    const onEvict=(id,item)=>{this.unmount(id);URL.revokeObjectURL(item.url);};
    this.cache=new PreviewCache({maxBytes:128*1024*1024,onEvict});
    this.sharpCache=new SharpCache({onEvict});
    this.sharpScheduler=new SharpScheduler({isReady:(id,width,rotation)=>this.sharpCache.has(id,width,rotation)||((rotation===0)&&Math.max(this.cache.peek(id)?.width||0,this.cache.peek(id)?.requestedWidth||0)>=width)});
    this.metrics={state:'idle',rendered:0,failures:0,renderMs:0,encodeMs:0,wasmBytes:0};
    this.onRenderStart=({pageNumber,source})=>{const view=this.pdfViewer.getPageView(pageNumber-1);if(!view||(source&&source!==view))return;delete view.div.dataset.sharpReady;this.mount(pageNumber);};
    this.onRenderEnd=({pageNumber,error,source,isDetailView})=>{const view=this.pdfViewer.getPageView(pageNumber-1);if(isDetailView||!view||(source&&source!==view))return;if(!error)view.div.dataset.sharpReady='true';};
    eventBus.on('pagerender',this.onRenderStart);eventBus.on('pagerendered',this.onRenderEnd);
  }
  async start({pageCount,getBytes}){
    this.stop();const generation=this.generation;this.pageCount=pageCount;
    this.sharpScheduler.reset(pageCount);this.syncViewport();
    this.metrics={state:'loading',rendered:0,sharpRendered:0,failures:0,renderMs:0,encodeMs:0,wasmBytes:0};this.notify();
    try{
      const [bytes,wasm]=await Promise.all([getBytes(),this.getWasm()]);
      if(generation!==this.generation)return;
      const source=URL.createObjectURL(new Blob([__PREVIEW_WORKER_SOURCE__],{type:'text/javascript'}));
      const worker=new Worker(source,{type:'module',name:'local-pdf-page-previews'});this.workerSource=source;
      this.worker=worker;worker.onmessage=event=>{
        if(generation!==this.generation||this.worker!==worker)return;
        const result=event.data,waiting=this.pending.get(result.id);if(!waiting)return;
        this.pending.delete(result.id);clearTimeout(waiting.timer);
        if(result.type==='error')waiting.reject(new Error(result.message));else waiting.resolve(result);
      };
      worker.onerror=()=>{if(generation===this.generation&&this.worker===worker)this.fail(new Error('The PDF preview worker failed or WASM compilation was blocked.'));};
      const data=bytes instanceof Uint8Array?bytes: new Uint8Array(bytes);
      const binary=wasm instanceof Uint8Array?wasm:new Uint8Array(wasm);
      // Caller supplies buffers not used by the sharp-render worker.
      const ready=await this.request({type:'init',bytes:data.buffer,wasmBinary:binary.buffer},[data.buffer,binary.buffer]);
      URL.revokeObjectURL(source);if(this.workerSource===source)this.workerSource=null;
      if(generation!==this.generation)return;
      if(ready.pageCount!==pageCount)throw new Error('Preview and document page counts disagree.');
      this.metrics.state='preparing';this.notify();await this.pump(generation);
    }catch(error){if(generation===this.generation)this.fail(error);}
  }
  request(payload,transfer=[]){
    return new Promise((resolve,reject)=>{
      const id=++this.sequence;
      const timer=setTimeout(()=>{this.fail(new Error('PDF preview worker response timed out.'));},30000);
      this.pending.set(id,{resolve,reject,timer});
      try{this.worker.postMessage({id,...payload},transfer);}catch(error){clearTimeout(timer);this.pending.delete(id);reject(error);}
    });
  }
  nextPage(){
    const near=previewPriority(this.pageCount,this.focus,this.direction);
    for(const id of near)if(!this.cache.has(id)&&!this.failed.has(id)&&!this.deferred.has(id))return id;
    for(let id=1;id<=this.pageCount;id++)if(!this.prepared.has(id)&&!this.failed.has(id))return id;
    return null;
  }
  async pump(generation=this.generation){
    if(this.pumping||!this.worker)return;this.pumping=true;
    try{
      while(generation===this.generation&&this.worker){
        const sharpJob=this.enableSharp?this.sharpScheduler.next():null;
        const id=sharpJob?.pageNumber??this.nextPage();if(id===null)break;
        try{
          const requestedWidth=sharpJob?.width||this.width;
          const result=await this.request({type:'render',pageNumber:id,width:requestedWidth,format:'png'});
          if(generation!==this.generation)return;
          if(result.pageNumber!==id||!result.buffer?.byteLength)throw new Error('Invalid preview result.');
          const blob=new Blob([result.buffer],{type:result.mime});const url=URL.createObjectURL(blob);
          const item={url,bytes:blob.size,width:result.width,height:result.height,requestedWidth,rotation:0};
          if(sharpJob&&requestedWidth>this.width){
            const accepted=this.sharpCache.set(id,item,this.protectedPages());
            if(!accepted)URL.revokeObjectURL(url);
          }else{
            if(!this.cache.set(id,item,new Set(previewPriority(this.pageCount,this.focus,this.direction)))){URL.revokeObjectURL(url);this.deferred.add(id);}
            this.prepared.add(id);this.metrics.rendered++;
          }
          if(sharpJob){
            if(this.sharpScheduler.isReady(id,requestedWidth,sharpJob.rotation))this.sharpScheduler.complete(sharpJob);else this.sharpScheduler.defer(sharpJob);
            this.metrics.sharpRendered++;
          }
          this.metrics.renderMs+=result.renderMs;this.metrics.encodeMs+=result.encodeMs;
          this.metrics.wasmBytes=result.wasmBytes;this.mountNeighborhood();this.notify();
        }catch(error){if(generation!==this.generation)return;if(sharpJob)this.sharpScheduler.fail(sharpJob);else this.failed.add(id);this.metrics.failures++;this.metrics.lastError=error.message;}
      }
      if(generation===this.generation&&this.metrics.state!=='failed'){
        this.metrics.state=this.failed.size?'partial':'ready';
        // Keep one decoder idle for immediate higher-zoom/current-page work.
        // The inexpensive preview-only mode can still release it completely.
        if(!this.enableSharp&&this.cache.items.size===this.pageCount){this.worker?.terminate();this.worker=null;this.metrics.wasmBytes=0;}
        this.notify();
      }
    }finally{if(generation===this.generation)this.pumping=false;}
  }
  setFocus(pageNumber){
    if(!Number.isInteger(pageNumber)||pageNumber<1)return;
    if(pageNumber!==this.focus){this.direction=pageNumber>this.focus?1:-1;this.deferred.clear();}
    this.focus=pageNumber;this.syncViewport();this.mountNeighborhood();
    if(this.metrics.state==='ready'||this.metrics.state==='partial')void this.pump();
  }
  mount(id){
    const div=this.pdfViewer.getPageView(id-1)?.div,rotation=this.pdfViewer.pagesRotation||0;
    const item=choosePageAppearance(this.cache.peek(id),this.sharpCache.peek(id),rotation);
    if(!div)return;if(!item){this.unmount(id);return;}
    if(this.mountedUrls.get(id)!==item.url){div.style.backgroundImage=`url("${item.url}")`;div.dataset.previewReady='true';div.dataset.appearanceWidth=String(item.width);this.mounted.add(id);this.mountedUrls.set(id,item.url);}
  }
  unmount(id){const div=this.pdfViewer.getPageView(id-1)?.div;if(div){div.style.backgroundImage='';delete div.dataset.previewReady;delete div.dataset.appearanceWidth;}this.mounted.delete(id);this.mountedUrls.delete(id);}
  protectedPages(){return new Set([this.focus,...this.visiblePages,...this.getPinnedPages()]);}
  syncViewport(){
    if(!this.enableSharp||!this.pageCount)return;
    const view=this.pdfViewer.getPageView(this.focus-1),container=this.pdfViewer.container;
    const bounds=container?.getBoundingClientRect?.();
    this.visiblePages=previewPriority(this.pageCount,this.focus,this.direction,4).filter(id=>{
      const box=this.pdfViewer.getPageView(id-1)?.div?.getBoundingClientRect?.();return !bounds||!box?id===this.focus:box.bottom>bounds.top&&box.top<bounds.bottom;
    });
    const cssWidth=view?.div?.clientWidth||view?.viewport?.width||this.width;
    const ratio=container?.ownerDocument?.defaultView?.devicePixelRatio||1;
    this.sharpScheduler.setViewport({focus:this.focus,direction:this.direction,visiblePages:this.visiblePages,width:sharpTargetWidth(cssWidth,ratio),rotation:0});
    this.sharpCache.trim(this.protectedPages());
  }
  onViewportChanged(){this.syncViewport();this.mountNeighborhood();if(this.metrics.state==='ready'||this.metrics.state==='partial')void this.pump();}
  mountNeighborhood(){
    const desired=new Set(previewPriority(this.pageCount,this.focus,this.direction,8));
    for(const id of [...this.mounted])if(!desired.has(id))this.unmount(id);
    for(const id of desired)this.mount(id);
  }
  notify(){this.onProgress(this.snapshot());}
  snapshot(){return{...this.metrics,...this.cache.snapshot(),...this.sharpCache.snapshot(),sharpQueue:this.sharpScheduler.snapshot(),preparedPages:this.prepared.size,pageCount:this.pageCount,mountedPages:this.mounted.size,focus:this.focus,workerActive:!!this.worker,workerRendering:this.pumping};}
  fail(error){this.metrics.state='failed';this.metrics.lastError=error.message;this.worker?.terminate();this.worker=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.notify();}
  stop(){
    this.generation++;this.pumping=false;this.worker?.terminate();this.worker=null;
    if(this.workerSource){URL.revokeObjectURL(this.workerSource);this.workerSource=null;}
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('PDF preview document changed.'));}this.pending.clear();
    this.cache.clear();this.sharpCache.clear();this.sharpScheduler.reset();this.prepared.clear();this.failed.clear();this.deferred.clear();this.mounted.clear();this.mountedUrls.clear();this.pageCount=0;this.metrics.state='idle';
  }
  dispose(){this.stop();this.eventBus.off('pagerender',this.onRenderStart);this.eventBus.off('pagerendered',this.onRenderEnd);}
}
