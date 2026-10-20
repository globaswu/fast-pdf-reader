/** Selection and user-authored change requests. No model messages are sent. */
import {FEEDBACK_LIMITS,sourceFingerprint,intersectRects,validPdfBox,validateSelectionData,getContextSupport,placeSelectionPopup,shouldSubmitComment,isAskForChangeShortcut} from './feedback-data.mjs';
import {createFeedbackQueue} from './feedback-queue.mjs';
import {createRequestHighlights,projectRequestBox} from './request-highlights.mjs';
import {createInlineDictation} from './inline-dictation.mjs';
export * from './feedback-data.mjs';

export function createFeedbackController({container,pdfViewer,eventBus,getDocumentInfo,getResourceUri,app,extensions,status,callTool}){
  const doc=container.ownerDocument,win=doc.defaultView,$=id=>doc.getElementById(id),listeners=[];
  let selection=null,region=null,queue=[],fingerprint=null,pendingSelection=null,busy=false,disposed=false,selectionFrame=0,viewFrame=0,dragCleanup=null;
  let contextAttached=false,attachedCount=0,selecting=false,documentOpening=false,pendingAnchor=null;
  const dialog=$('feedback-dialog');
  const highlights=createRequestHighlights({pdfViewer,eventBus,getDocumentInfo});
  const comments=createFeedbackQueue({app,extensions,onChange:state=>{
    queue=state.requests;busy=state.busy;contextAttached=state.contextAttached;attachedCount=state.attachedRequests.length;
    if(!disposed){refreshHighlights();renderQueue();updateCapabilities();}
  }});
  const dictation=createInlineDictation({callTool,randomUUID:()=>win.crypto.randomUUID(),
    getDraft:()=>({value:$('feedback-comment').value,start:$('feedback-comment').selectionStart,end:$('feedback-comment').selectionEnd}),
    setDraft:(value,caret)=>{
      const input=$('feedback-comment');input.value=value;input.focus();input.setSelectionRange(caret,caret);
      if(value.length>FEEDBACK_LIMITS.comment)$('feedback-dialog-error').textContent=`Your dictation has ${value.length.toLocaleString()} characters. Shorten it to ${FEEDBACK_LIMITS.comment.toLocaleString()} before saving; nothing was truncated.`;
      updateInlineEditor();
    },
    getBinding:()=>pendingSelection,
    isBindingCurrent:selected=>!disposed&&!documentOpening&&dialog.open&&pendingSelection===selected&&selected?.fingerprint===fingerprint&&sourceMatches(),
    onState:({state:voiceState,message})=>{
      $('feedback-voice').dataset.state=voiceState;$('feedback-dictation-status').textContent=message;
      $('feedback-dictation-status').hidden=voiceState==='idle';
      if(!disposed){updateCapabilities();updateInlineEditor();}
    },
    onError:message=>{if(dialog.open){$('feedback-dialog-error').textContent=message;updateInlineEditor();}status(message,true);},
    onNotice:message=>{status(message);if(dialog.open)$('feedback-comment').focus();},
  });
  const on=(target,type,callback,options)=>{target.addEventListener(type,callback,options);listeners.push(()=>target.removeEventListener(type,callback,options));};
  const nativeApi=()=>typeof doc.oai?.annotation?.request==='function'?doc.oai.annotation:null;
  function refreshHighlights(){
    const draft=pendingSelection?{id:'inline-draft',source:pendingSelection.source,selection:pendingSelection.selection,preview:true}:null;
    highlights.setRequests(draft?[...queue,draft]:queue);
  }
  const source=()=>{const info=getDocumentInfo();return info?{documentId:info.documentId,name:info.name,sourcePath:info.sourcePath??null,resourceUri:getResourceUri()??null,size:info.size,modifiedMs:info.modifiedMs}:null;};
  const sourceMatches=()=>{try{return fingerprint!==null&&fingerprint===sourceFingerprint(getDocumentInfo());}catch{return false;}};
  const viewport=()=>intersectRects(container.getBoundingClientRect(),{left:0,top:0,right:win.innerWidth,bottom:win.innerHeight});
  const pageElement=node=>(node?.nodeType===1?node:node?.parentElement)?.closest('.page[data-page-number]');
  function canvasBounds(page){return(page.querySelector('.canvasWrapper')||page).getBoundingClientRect();}
  function pdfBox(page,rect){
    const number=Number(page.dataset.pageNumber),view=pdfViewer.getPageView(number-1),bounds=canvasBounds(page);
    if(!view?.viewport||!bounds.width||!bounds.height)throw new Error('The PDF page has not finished laying out.');
    const sx=view.viewport.width/bounds.width,sy=view.viewport.height/bounds.height;
    const p1=view.viewport.convertToPdfPoint((rect.left-bounds.left)*sx,(rect.top-bounds.top)*sy),p2=view.viewport.convertToPdfPoint((rect.right-bounds.left)*sx,(rect.bottom-bounds.top)*sy);
    return{page:number,pdfRect:[Math.min(p1[0],p2[0]),Math.min(p1[1],p2[1]),Math.max(p1[0],p2[0]),Math.max(p1[1],p2[1])].map(n=>Math.round(n*1000)/1000)};
  }
  function selectionIsVisible(){
    if(!sourceMatches())return false;
    const visible=viewport();if(!visible)return false;
    if(region)return region.element.isConnected&&!!intersectRects(region.element.getBoundingClientRect(),visible);
    if(!selection?.range||selection.range.collapsed||!selection.range.startContainer.isConnected||!selection.range.endContainer.isConnected)return false;
    if(!container.contains(selection.range.commonAncestorContainer))return false;
    const text=selection.range.toString();
    if(text!==selection.data.text||!text.trim()||text.length>FEEDBACK_LIMITS.selectedText)return false;
    return[...selection.range.getClientRects()].some(rect=>intersectRects(rect,visible));
  }
  function clearRegion(){region?.element.remove();region=null;}
  function clearSelection(){selection=null;clearRegion();}
  function clearDrag(){dragCleanup?.();dragCleanup=null;container.classList.remove('region-mode');$('region-toggle').setAttribute('aria-pressed','false');}
  function captureSelection(){
    if(disposed||dialog.open||container.classList.contains('region-mode'))return;
    const current=win.getSelection();
    if(!current?.rangeCount||current.isCollapsed){selection=null;updateCapabilities();return;}
    const range=current.getRangeAt(0);
    if(!container.contains(range.commonAncestorContainer)){selection=null;updateCapabilities();return;}
    const first=pageElement(range.startContainer),last=pageElement(range.endContainer),text=range.toString();
    if(!first||!last||!text.trim()){selection=null;updateCapabilities();return;}
    if(text.length>FEEDBACK_LIMITS.selectedText){selection=null;status('Select at most 20,000 characters for one request.',true);updateCapabilities();return;}
    const rectangles=[...range.getClientRects()],boxes=[];
    for(let number=Number(first.dataset.pageNumber);number<=Number(last.dataset.pageNumber);number++){
      const page=pdfViewer.getPageView(number-1)?.div;if(!page)continue;
      const bounds=canvasBounds(page);
      for(const rect of rectangles){const clipped=intersectRects(rect,bounds);if(clipped){const box=pdfBox(page,clipped);if(validPdfBox(box))boxes.push(box);}}
      if(boxes.length>FEEDBACK_LIMITS.boxes)break;
    }
    try{const data=validateSelectionData({kind:'text',text,boxes});selection={range:range.cloneRange(),data};clearRegion();}
    catch(error){selection=null;status(error.message,true);}
    updateCapabilities();
  }
  function snapshot(){
    if(!selectionIsVisible())throw new Error('Select a visible passage or figure region in the current PDF first.');
    const data=region?{kind:'region',boxes:[region.box]}:selection.data;
    validateSelectionData(data);
    return{source:source(),selection:structuredClone(data),fingerprint};
  }
  function anchorRect(){
    const visible=viewport();if(!visible)return null;
    if(region)return intersectRects(region.element.getBoundingClientRect(),visible);
    const rects=selection?.range?[...selection.range.getClientRects()]:[];
    for(let index=rects.length-1;index>=0;index--){const clipped=intersectRects(rects[index],visible);if(clipped)return clipped;}
    return null;
  }
  function positionPopup(element,anchor){
    const bounds=viewport()||{left:0,top:0,right:win.innerWidth,bottom:win.innerHeight};
    element.style.maxWidth=`${Math.max(1,bounds.right-bounds.left-16)}px`;
    const position=placeSelectionPopup(anchor,{width:element.offsetWidth,height:element.offsetHeight},bounds,{preferAbove:element.id==='selection-actions'});
    element.style.left=`${position.left}px`;element.style.top=`${position.top}px`;
  }
  function setPanel(show){$('feedback-panel').hidden=!show;$('feedback-toggle').setAttribute('aria-expanded',String(show));pdfViewer.update();}
  function editorAnchor(){
    const box=pendingSelection?.selection.boxes.at(-1),view=box?pdfViewer.getPageView(box.page-1):null;
    const rect=view?.div?.isConnected?projectRequestBox(box.pdfRect,view.viewport):null;
    if(!rect)return pendingAnchor;
    const bounds=canvasBounds(view.div),width=bounds.width,height=bounds.height;
    return intersectRects({left:bounds.left+rect.left*width/100,top:bounds.top+rect.top*height/100,right:bounds.left+(rect.left+rect.width)*width/100,bottom:bounds.top+(rect.top+rect.height)*height/100},viewport()||bounds)||pendingAnchor;
  }
  function updateInlineEditor(){
    const input=$('feedback-comment'),hasText=!!input.value.trim(),voiceActive=dictation.isActive();
    input.style.height='20px';input.style.height=`${Math.min(100,Math.max(20,input.scrollHeight))}px`;
    $('feedback-save').hidden=!hasText||voiceActive;
    $('feedback-voice').hidden=voiceActive&&dictation.getState()!=='listening';
    $('feedback-dictation-cancel').hidden=!voiceActive;
    if(dialog.open){const anchor=editorAnchor();if(anchor)positionPopup(dialog,anchor);}
  }
  function renderQueue(){
    $('feedback-count').textContent=String(queue.length);$('feedback-clear').disabled=busy||documentOpening||!queue.length;
    $('feedback-list').replaceChildren();
    for(const request of queue){
      const item=doc.createElement('li'),label=doc.createElement('div'),comment=doc.createElement('p'),remove=doc.createElement('button');
      const pages=[...new Set(request.selection.boxes.map(box=>box.page))];
      label.className='request-location';label.textContent=`${request.source.name} · physical page${pages.length>1?'s':''} ${pages.join(', ')}`;
      item.append(label);
      if(request.selection.kind==='text'){const quote=doc.createElement('blockquote');quote.textContent=request.selection.text;item.append(quote);}
      else{const location=doc.createElement('p');location.textContent=`Figure region: [${request.selection.boxes[0].pdfRect.join(', ')}] PDF points`;item.append(location);}
      comment.className='request-comment';comment.textContent=request.inputMode==='composer'?'Selection for your typed or dictated instructions in Codex.':request.comment;remove.textContent='Remove';remove.disabled=busy||documentOpening;remove.setAttribute('aria-label',`Remove request on page ${pages.join(', ')}`);
      remove.onclick=()=>comments.remove(request.id).catch(error=>status(error.message,true));
      item.append(comment,remove);$('feedback-list').append(item);
    }
    const composerSelection=queue.some(item=>item.inputMode==='composer');
    $('feedback-attachment-status').textContent=!queue.length?'No selections or comments collected.':contextAttached?`All ${queue.length} item${queue.length===1?'':'s'} attached as context. ${composerSelection?'Type or click the microphone in Codex\'s input box. ':''}Input text unchanged; no message sent.`:`${queue.length} item${queue.length===1?'':'s'} collected in this reader.${attachedCount?` ${attachedCount} already attached; send again to include the new items.`:' Send the batch when ready.'}`;
    $('feedback-send-help').textContent=getContextSupport(app,extensions).available?'Attaches the complete batch as context without typing or sending a message. Keep this reader open until you send your message.':'This surface has no chat-context connection. Comments stay in the reader; the input box will not be used as a fallback.';
  }
  async function requestDictation(){
    if(busy||documentOpening)return;
    if(!dialog.open||!pendingSelection||pendingSelection.fingerprint!==fingerprint||!sourceMatches())return;
    $('feedback-dialog-error').textContent='';await dictation.toggle();
  }
  function openRequest(){
    if(busy||documentOpening)return;
    try{pendingAnchor=anchorRect();pendingSelection=snapshot();clearDrag();const pages=[...new Set(pendingSelection.selection.boxes.map(box=>box.page))];
      $('feedback-selection-summary').textContent=`${pendingSelection.source.name} · physical page${pages.length>1?'s':''} ${pages.join(', ')}`;
      $('feedback-selected-text').textContent=pendingSelection.selection.kind==='text'?pendingSelection.selection.text:`Selected figure region: [${pendingSelection.selection.boxes[0].pdfRect.join(', ')}] PDF points`;
      $('feedback-comment').value='';$('feedback-dialog-error').textContent='';
      $('feedback-dialog-help').textContent='Enter to save; Shift+Enter for a new line; Escape to close. Click the microphone to record and insert dictation here. Enter or Stop finishes a recording; Cancel discards it and keeps your typed text. Review the transcript before saving. Windows microphone privacy settings still apply.';
      $('selection-actions').hidden=true;dialog.showModal();win.getSelection()?.removeAllRanges();refreshHighlights();updateInlineEditor();updateCapabilities();$('feedback-comment').focus();
    }catch(error){status(error.message,true);}
  }
  function updateCapabilities(){
    if(disposed)return;
    const selected=selectionIsVisible(),support=getContextSupport(app,extensions);
    $('request-change').disabled=busy||documentOpening||!selected;
    $('request-change').title='Ask for change (Ctrl+Shift+X; Ctrl+I also works)';
    const voiceState=dictation.getState(),voiceActive=dictation.isActive();
    $('feedback-voice').disabled=busy||documentOpening||typeof callTool!=='function';
    $('feedback-dictation-cancel').disabled=!voiceActive;
    const voiceLabel=voiceState==='idle'?'Dictate in this input':voiceState==='listening'?'Stop dictation':'Cancel dictation';
    $('feedback-voice').setAttribute('aria-label',voiceLabel);$('feedback-voice').setAttribute('aria-pressed',String(voiceState==='listening'));
    $('feedback-voice').title=voiceState==='idle'?'Dictate here with the local Windows microphone recorder':voiceState==='listening'?'Stop recording and transcribe here (Enter)':'Cancel the pending recording or transcription';
    const actions=$('selection-actions');actions.hidden=busy||documentOpening||!selected||dialog.open||selecting;
    if(!actions.hidden){const anchor=anchorRect();if(anchor)positionPopup(actions,anchor);else actions.hidden=true;}
    $('region-toggle').disabled=busy||documentOpening||!sourceMatches();
    $('feedback-clear').disabled=busy||documentOpening||!queue.length;$('feedback-save').disabled=busy||documentOpening||voiceActive;
    $('feedback-send').disabled=busy||documentOpening||!queue.length||!sourceMatches()||!support.available||contextAttached;
    $('feedback-send').textContent=documentOpening?'Opening PDF…':busy?'Updating context…':contextAttached?'Attached to dialogue box':'Send to dialogue box';
    $('capability-status').textContent=`Context attachment: ${support.available?support.mode:'unavailable on this surface'}. Inline dictation: ${voiceState}; local runtime: ${dictation.diagnostics().runtime}. Its microphone uses the plugin's local Windows recorder; speech is transcribed locally into this same input. Nothing is attached or sent automatically.`;
  }
  on($('request-change'),'click',openRequest);
  on($('request-change'),'pointerdown',event=>event.preventDefault());
  on($('feedback-voice'),'click',requestDictation);
  on($('feedback-voice'),'pointerdown',event=>event.preventDefault());
  on($('feedback-dictation-cancel'),'click',()=>{dictation.cancel();$('feedback-comment').focus();status('Dictation discarded. Your typed text is unchanged.');});
  on($('feedback-dictation-cancel'),'pointerdown',event=>event.preventDefault());
  on($('feedback-toggle'),'click',()=>setPanel($('feedback-panel').hidden));
  on($('feedback-clear'),'click',()=>comments.clear().catch(error=>status(error.message,true)));
  on($('feedback-send'),'click',async()=>{
    if(busy||documentOpening||contextAttached)return;
    try{
      if(!sourceMatches())throw new Error('The PDF revision changed. Reopen the current document before sending comments.');
      if(await comments.send())status('All comments attached as context. Your input text is unchanged; send your message when ready.');
    }catch(error){status(error.message,true);}
  });
  on($('feedback-cancel'),'click',()=>dialog.close());
  on(dialog,'close',()=>{dictation.cancel();pendingSelection=null;pendingAnchor=null;refreshHighlights();captureSelection();});
  on($('feedback-comment'),'input',()=>{if($('feedback-comment').value.length<=FEEDBACK_LIMITS.comment)$('feedback-dialog-error').textContent='';updateInlineEditor();});
  on($('feedback-form'),'submit',async event=>{
    event.preventDefault();if(busy||documentOpening||dictation.isActive())return;
    try{
      if(!pendingSelection||pendingSelection.fingerprint!==fingerprint||!sourceMatches())throw new Error('The PDF revision changed. Close this dialog and select the passage again.');
      const comment=$('feedback-comment').value;
      if(comment.length>FEEDBACK_LIMITS.comment)throw new Error(`Shorten this comment to ${FEEDBACK_LIMITS.comment.toLocaleString()} characters before saving. Your full text has been preserved.`);
      const request={id:win.crypto.randomUUID(),createdAt:new Date().toISOString(),source:pendingSelection.source,selection:pendingSelection.selection,comment};
      comments.add(request);dialog.close();clearSelection();win.getSelection()?.removeAllRanges();
      pendingSelection=null;refreshHighlights();updateCapabilities();status('Comment saved. Open Comments and use Send to dialogue box when your batch is ready.');
    }catch(error){$('feedback-dialog-error').textContent=error.message;updateInlineEditor();}
  });
  on($('feedback-comment'),'keydown',event=>{if(shouldSubmitComment(event)){event.preventDefault();if(dictation.getState()==='listening')void dictation.stop();else if(!dictation.isActive())$('feedback-form').requestSubmit();}});
  on(doc,'visibilitychange',()=>{if(doc.visibilityState==='hidden')dictation.cancel();});
  on(win,'pagehide',()=>dictation.cancel());
  on(doc,'keydown',event=>{
    const editable=event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if(isAskForChangeShortcut(event)&&!editable&&!dialog.open&&selectionIsVisible()){event.preventDefault();openRequest();}
    if(event.key==='Escape'&&!dialog.open){clearDrag();clearSelection();updateCapabilities();}
  });
  on(doc,'selectionchange',()=>{if(selectionFrame||dialog.open)return;selectionFrame=win.requestAnimationFrame(()=>{selectionFrame=0;captureSelection();});});
  on(container,'pointerdown',()=>{selecting=true;updateCapabilities();});
  on(doc,'pointerup',()=>{selecting=false;queueMicrotask(captureSelection);});on(container,'keyup',captureSelection);
  on(doc,'pointercancel',()=>{selecting=false;updateCapabilities();});
  on($('region-toggle'),'click',()=>{clearSelection();win.getSelection()?.removeAllRanges();const enabled=!container.classList.contains('region-mode');clearDrag();container.classList.toggle('region-mode',enabled);$('region-toggle').setAttribute('aria-pressed',String(enabled));updateCapabilities();});
  on(container,'pointerdown',event=>{
    if(!container.classList.contains('region-mode')||event.button!==0)return;
    const page=event.target.closest('.page[data-page-number]');if(!page)return;
    event.preventDefault();clearSelection();const bounds=canvasBounds(page),visible=viewport();if(!visible)return;
    const start={x:event.clientX,y:event.clientY},element=doc.createElement('div');element.className='pdf-region';page.append(element);
    const move=e=>{
      const rect=intersectRects({left:Math.min(start.x,e.clientX),top:Math.min(start.y,e.clientY),right:Math.max(start.x,e.clientX),bottom:Math.max(start.y,e.clientY)},bounds);
      if(!rect)return;
      const parent=page.getBoundingClientRect();Object.assign(element.style,{left:`${rect.left-parent.left-page.clientLeft}px`,top:`${rect.top-parent.top-page.clientTop}px`,width:`${rect.right-rect.left}px`,height:`${rect.bottom-rect.top}px`});
      region={element,box:pdfBox(page,rect)};element.setAttribute('aria-label',`${getDocumentInfo().name}, physical page ${region.box.page}, selected figure region`);
    };
    const finish=e=>{if(e.type!=='pointercancel')move(e);clearDrag();if(e.type==='pointercancel'||!region||!validPdfBox(region.box)){element.remove();clearRegion();}updateCapabilities();};
    dragCleanup=()=>{container.removeEventListener('pointermove',move);container.removeEventListener('pointerup',finish);container.removeEventListener('pointercancel',finish);if(container.hasPointerCapture(event.pointerId))container.releasePointerCapture(event.pointerId);if(region?.element!==element)element.remove();};
    container.setPointerCapture(event.pointerId);container.addEventListener('pointermove',move);container.addEventListener('pointerup',finish,{once:true});container.addEventListener('pointercancel',finish,{once:true});
  });
  function onViewChanged(){
    if(disposed)return;
    // Native requests must refer to visible, current DOM ranges. Region boxes
    // remain source coordinates but their overlay is invalid after layout changes.
    if(dragCleanup)clearDrag();
    clearRegion();updateCapabilities();if(dialog.open)updateInlineEditor();
  }
  on(container,'scroll',()=>{if(viewFrame)return;viewFrame=win.requestAnimationFrame(()=>{viewFrame=0;updateCapabilities();});},{passive:true});
  function onDocumentChanged(){
    dictation.cancel();
    const info=getDocumentInfo();let next=null;try{next=sourceFingerprint(info);}catch{}
    clearDrag();clearSelection();if(dialog.open)dialog.close();pendingSelection=null;
    if(next!==fingerprint){
      comments.reset().catch(error=>status(`The PDF changed; old chat context could not be cleared: ${error.message}`,true));
    }
    fingerprint=next;highlights.refresh();renderQueue();updateCapabilities();
  }
  function dispose(){disposed=true;dictation.dispose();highlights.dispose();clearDrag();clearSelection();for(const remove of listeners)remove();if(selectionFrame)win.cancelAnimationFrame(selectionFrame);if(viewFrame)win.cancelAnimationFrame(viewFrame);if(dialog.open)dialog.close();}
  onDocumentChanged();
  const diagnostics=()=>({requestCount:queue.length,attachedCount,contextAttached,busy,highlights:highlights.diagnostics(),delivery:'explicit-context-batch',askForChange:'reference-style-inline-editor',voice:dictation.diagnostics(),composerDraft:false,automaticMicrophone:false,contextSupport:getContextSupport(app,extensions).mode,nativeAnnotation:!!nativeApi(),validVisibleSelection:selectionIsVisible(),nativePdfParityVerified:false});
  function isSelectionPinned(div){
    if(!sourceMatches()||!selection?.range?.startContainer.isConnected||!selection.range.endContainer.isConnected)return false;
    try{return selection.range.intersectsNode(div);}catch{return false;}
  }
  const pinnedPages=()=>sourceMatches()&&selection?.data?[...new Set(selection.data.boxes.map(box=>box.page))]:[];
  function onHostContextChanged(context){comments.syncHostContext(context?.['openai/modelContext']);renderQueue();updateCapabilities();}
  function setDocumentOpening(value){documentOpening=Boolean(value);if(documentOpening)dictation.cancel();renderQueue();updateCapabilities();}
  return{onDocumentChanged,onViewChanged,onHostContextChanged,setDocumentOpening,captureSelection,updateCapabilities,dispose,diagnostics,isSelectionPinned,pinnedPages};
}
