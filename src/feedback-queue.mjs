import {appendChangeRequest,getContextSupport,makeFeedbackContext,sourceFingerprint} from './feedback-data.mjs';

/** Collect locally; only an explicit handoff publishes a complete context batch.
 * No ui/message call: the composer text and conversation remain untouched.
 */
export function createFeedbackQueue({app,extensions,onChange=()=>{}}){
  let requests=[],attachedRequests=[],busy=false,epoch=0,writes=Promise.resolve(),contextTouched=false;
  const snapshot=()=>({requests:[...requests],attachedRequests:[...attachedRequests],busy,
    contextAttached:requests.length>0&&requests.length===attachedRequests.length&&requests.every((item,i)=>item===attachedRequests[i])});
  const notify=()=>onChange(snapshot());
  function idle(){if(busy)throw new Error('Wait for the current context update to finish.');}
  function write(next){
    const support=getContextSupport(app,extensions);
    if(!support.available)return Promise.reject(new Error('This surface has no chat-context connection. Comments remain in the reader; no text was added to the input box.'));
    const payload=makeFeedbackContext(next,{structured:support.structured});
    contextTouched=true;
    const operation=writes.catch(()=>{}).then(async()=>{
      // Keep the full result where possible: the older helper discards isError.
      const result=typeof app?.updateModelContext==='function'?await app.updateModelContext(payload):await extensions.modelContext.update(payload);
      if(result?.isError)throw new Error('The host could not attach the PDF comments. Your collected comments are still available.');
    });
    writes=operation;
    return operation;
  }
  async function commit(next,nextAttached){
    idle();const current=epoch;busy=true;notify();
    try{
      await write(nextAttached);
      if(current!==epoch)return false;
      requests=next;attachedRequests=nextAttached;return true;
    }finally{if(current===epoch){busy=false;notify();}}
  }
  function add(request){
    idle();requests=appendChangeRequest(requests,structuredClone(request));notify();
  }
  async function send(){
    idle();if(!requests.length)throw new Error('Collect at least one comment first.');
    return commit(requests,[...requests]);
  }
  async function attachSelection(request){
    idle();
    if(!getContextSupport(app,extensions).available)throw new Error('This surface has no chat-context connection. Use Collect comment to keep a local note.');
    if(request.inputMode!=='composer'||request.comment!=='')throw new Error('Expected a selection for the Codex composer.');
    const match=requests.find(item=>item.inputMode==='composer'&&sourceFingerprint(item.source)===sourceFingerprint(request.source)&&JSON.stringify(item.selection)===JSON.stringify(request.selection));
    // Keep a failed handoff locally, and reuse it when the user retries.
    if(!match)add(request);
    return send();
  }
  async function remove(id){
    idle();const next=requests.filter(item=>item.id!==id);
    if(attachedRequests.some(item=>item.id===id))return commit(next,attachedRequests.filter(item=>item.id!==id));
    requests=next;notify();return true;
  }
  async function clear(){
    idle();if(attachedRequests.length||contextTouched)return commit([],[]);
    requests=[];notify();return true;
  }
  function reset(){
    const clearContext=contextTouched;
    epoch++;requests=[];attachedRequests=[];busy=false;contextTouched=false;notify();
    // Queue the clear after any obsolete write, before a new document's send.
    return clearContext?write([]):Promise.resolve();
  }
  function syncHostContext(hostState){
    if(hostState===undefined)return;
    const expected=makeFeedbackContext(attachedRequests).content[0]?.text;
    if(!hostState||!hostState.content?.some(block=>block.type==='text'&&block.text===expected)){
      attachedRequests=[];notify();
    }
  }
  return{snapshot,add,send,attachSelection,remove,clear,reset,syncHostContext};
}
