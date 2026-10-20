/** Local inline dictation orchestration. This module never sends chat context. */
export function insertDictatedText({current,original,start,end,text}){
  const transcript=String(text??'').trim();
  if(!transcript)return{value:current,caret:current.length,appended:false};
  const appended=current!==original;
  const from=appended?current.length:Math.max(0,Math.min(current.length,Number.isInteger(start)?start:current.length));
  const to=appended?from:Math.max(from,Math.min(current.length,Number.isInteger(end)?end:from));
  const before=current.slice(0,from),after=current.slice(to);
  const left=before&&!/\s$/.test(before)&&!/^\s|^[,.;:!?，。！？、]/.test(transcript)?' ':'';
  const right=after&&!/^\s|^[,.;:!?，。！？、]/.test(after)&&!/[\s]$/.test(transcript)?' ':'';
  return{value:before+left+transcript+right+after,caret:before.length+left.length+transcript.length,appended};
}

const payload=result=>{
  if(result?.isError)throw new Error(result?.structuredContent?.message||result?.structuredContent?.error||'Local dictation could not complete.');
  return result?.structuredContent??result;
};

/** Native helper capture is explicit and leased; no browser microphone is used. */
export function createInlineDictation({callTool,getDraft,setDraft,getBinding,isBindingCurrent,randomUUID=()=>globalThis.crypto.randomUUID(),timers=globalThis,onState=()=>{},onError=()=>{},onNotice=()=>{}}){
  let session=null,state='idle',disposed=false,runtime='unchecked';
  const active=run=>!disposed&&session===run&&!run.cancelled&&isBindingCurrent(run.binding);
  const emit=(next,message='',elapsedSeconds=0)=>{state=next;onState({state:next,message,elapsedSeconds});};
  const invoke=async(name,args,timeout=5000)=>payload(await callTool(name,args,{timeout}));
  function clearTimers(run){if(!run)return;timers.clearTimeout(run.pollTimer);timers.clearTimeout(run.heartbeatTimer);}
  async function cancelRemote(run,bySession=false){
    if(!run.startSent||typeof callTool!=='function')return;
    try{await invoke('pdf_dictation_cancel',bySession&&run.sessionId?{sessionId:run.sessionId}:{requestId:run.requestId});}catch{/* The native helper's eight-second lease is the disconnect failsafe. */}
  }
  function cancel(){
    const run=session;session=null;
    if(run){run.cancelled=true;clearTimers(run);void cancelRemote(run,!!run.sessionId);}
    if(!disposed)emit('idle');
  }
  function fail(run,error){
    if(session!==run)return;
    const report=active(run);cancel();
    if(report)onError(error?.message||'Local dictation could not complete.');
  }
  function accept(run,result){
    if(!active(run)){if(session===run)cancel();return false;}
    if(result?.local!==true||result.sessionId&&result.sessionId!==run.sessionId)throw new Error('The local recorder returned an invalid session.');
    if(result.state==='complete'){
      if(typeof result.text!=='string')throw new Error('The local recognizer returned an invalid transcript.');
      const merged=insertDictatedText({current:getDraft().value,original:run.draft.value,start:run.draft.start,end:run.draft.end,text:result.text});
      // Terminal responses from status, heartbeat and stop can arrive together.
      session=null;clearTimers(run);
      if(result.text.trim())setDraft(merged.value,merged.caret);
      emit('idle');
      onNotice(!result.text.trim()?'No speech was recognized. Try dictating again.':merged.appended?'Dictation appended after your latest edits. Review it, then press Enter to save.':'Dictation inserted here. Review it, then press Enter to save.');
      void cancelRemote(run,true);
      return false;
    }
    if(result.state==='cancelled'){
      session=null;clearTimers(run);emit('idle');
      if(result.code&&result.code!=='DICTATION_CANCELLED')onError(result.message||'Dictation stopped because the recorder connection was lost. Your typed text is unchanged.');
      else onNotice('Dictation cancelled. Your typed text is unchanged.');
      return false;
    }
    if(result.state==='error')throw new Error(result.message||result.error||'The local recorder stopped. Try dictating again.');
    if(result.state==='awaiting-consent'){
      fail(run,new Error('Reopen the updated reader to use the current inline dictation component.'));
      return false;
    }
    const elapsed=Math.max(0,Math.min(120,Number(result.elapsedSeconds)||0));
    const rank={'starting':0,'recording':1,'stopping':2,'transcribing':3}[result.state];
    if(rank===undefined)throw new Error('The local recorder returned an unknown state.');
    if(rank<run.rank||run.stopRequested&&rank<2)return true;
    run.rank=rank;
    if(result.state==='starting')emit('requesting','Starting local recorder…');
    else if(result.state==='recording')emit('listening',`Listening · ${Math.floor(elapsed/60)}:${String(Math.floor(elapsed%60)).padStart(2,'0')} · Enter to finish`,elapsed);
    else if(result.state==='stopping')emit('stopping','Finishing recording…');
    else emit('transcribing','Transcribing locally…');
    return true;
  }
  function schedulePoll(run){if(active(run))run.pollTimer=timers.setTimeout(()=>void poll(run),750);}
  async function poll(run){
    if(!active(run)){if(session===run)cancel();return;}
    try{
      const result=await invoke('pdf_dictation_status',{sessionId:run.sessionId});
      if(!accept(run,result))return;run.pollErrors=0;
    }catch(error){
      if(!active(run))return;
      if(++run.pollErrors>=2){fail(run,error);return;}
    }
    schedulePoll(run);
  }
  function scheduleHeartbeat(run){if(active(run))run.heartbeatTimer=timers.setTimeout(()=>void heartbeat(run),2000);}
  async function heartbeat(run){
    if(!active(run)){if(session===run)cancel();return;}
    try{if(!accept(run,await invoke('pdf_dictation_heartbeat',{sessionId:run.sessionId})))return;}
    catch(error){fail(run,error);return;}
    scheduleHeartbeat(run);
  }
  async function start(){
    if(disposed||session)return false;
    const binding=getBinding();if(!binding||!isBindingCurrent(binding))return false;
    const run={binding,draft:{...getDraft()},requestId:randomUUID(),sessionId:null,startSent:false,cancelled:false,stopRequested:false,rank:0,pollErrors:0};
    session=run;emit('requesting','Preparing local dictation…');
    try{
      if(typeof callTool!=='function')throw new Error('Local dictation is unavailable on this reader connection.');
      const info=await invoke('pdf_dictation_info',{},15000);
      if(!active(run)){if(session===run)cancel();return false;}
      runtime=info?.available&&info.local===true?'available':'unavailable';
      if(runtime!=='available')throw new Error(info?.reason||'Install the local speech recognition runtime before using dictation.');
      run.startSent=true;
      // Do not abort this RPC: its eventual session ID is needed for cleanup.
      const result=await invoke('pdf_dictation_start',{requestId:run.requestId},15000);
      if(typeof result?.sessionId!=='string'||!result.sessionId)throw new Error('The local recorder did not return a session identifier.');
      run.sessionId=result.sessionId;
      if(!active(run)){void cancelRemote(run,true);if(session===run)cancel();return false;}
      if(!accept(run,result))return false;
      schedulePoll(run);scheduleHeartbeat(run);return true;
    }catch(error){fail(run,error);return false;}
  }
  async function stop(){
    const run=session;if(!run||run.stopRequested||state!=='listening')return false;
    run.stopRequested=true;run.rank=2;emit('stopping','Finishing recording…');
    try{accept(run,await invoke('pdf_dictation_stop',{sessionId:run.sessionId}));return true;}
    catch(error){fail(run,error);return false;}
  }
  function toggle(){
    if(state==='listening')return stop();
    if(state!=='idle'){cancel();return Promise.resolve(false);}
    return start();
  }
  function dispose(){cancel();disposed=true;}
  return{start,stop,toggle,cancel,dispose,getState:()=>state,isActive:()=>state!=='idle',diagnostics:()=>({state,runtime,capture:'explicit-native-helper',local:true,automaticMicrophone:false})};
}
