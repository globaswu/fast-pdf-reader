import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createInlineDictation,insertDictatedText} from '../src/inline-dictation.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock(){
  let now=0,id=0;const jobs=new Map();
  return{setTimeout(fn,delay){const key=++id;jobs.set(key,{fn,time:now+delay});return key;},clearTimeout(key){jobs.delete(key);},
    async advance(ms){const until=now+ms;for(;;){const next=[...jobs].filter(([,j])=>j.time<=until).sort((a,b)=>a[1].time-b[1].time)[0];if(!next)break;now=next[1].time;jobs.delete(next[0]);next[1].fn();await tick();}now=until;await tick();},get count(){return jobs.size;}};
}
function fixture({info=async()=>({available:true,local:true,maxSeconds:120}),start,status:statusOverride,heartbeat,stop,cancel,value=''}={}){
  let binding={},draft={value,start:value.length,end:value.length},requestNumber=0,sessionNumber=0;
  let remote={sessionId:'session-1',state:'recording',elapsedSeconds:1,local:true};
  const calls=[],states=[],errors=[],notices=[],insertions=[],clock=fakeClock();
  const control=createInlineDictation({
    callTool:async(name,args,options)=>{
      calls.push({name,args,options});
      if(name==='pdf_dictation_info')return info();
      if(name==='pdf_dictation_start'){sessionNumber++;remote={...remote,sessionId:`session-${sessionNumber}`};return start?start(args):{sessionId:remote.sessionId,state:'starting',local:true};}
      if(name==='pdf_dictation_status')return statusOverride?statusOverride(args):{...remote};
      if(name==='pdf_dictation_heartbeat')return heartbeat?heartbeat(args):{...remote};
      if(name==='pdf_dictation_stop')return stop?stop(args):{sessionId:remote.sessionId,state:'stopping',local:true};
      if(name==='pdf_dictation_cancel')return cancel?cancel(args):{state:'cancelled',local:true};
      throw new Error(`Unexpected tool: ${name}`);
    },
    randomUUID:()=>`request-${++requestNumber}`,timers:clock,
    getDraft:()=>draft,setDraft:(value,caret)=>{draft={value,start:caret,end:caret};insertions.push(value);},getBinding:()=>binding,isBindingCurrent:b=>b===binding,
    onState:s=>states.push(s),onError:e=>errors.push(e),onNotice:n=>notices.push(n),
  });
  return{control,calls,states,errors,notices,insertions,clock,edit:value=>{draft={value,start:value.length,end:value.length};},setRemote:change=>{remote={...remote,...change};},changeBinding:()=>{binding={};},get draft(){return draft;}};
}
const named=(f,name)=>f.calls.filter(x=>x.name===`pdf_dictation_${name}`);
async function listen(f){assert.equal(await f.control.start(),true);await f.clock.advance(750);assert.equal(f.control.getState(),'listening');}

test('no microphone or tool invocation occurs before explicit start',async()=>{
  const f=fixture();await f.clock.advance(10000);assert.equal(f.calls.length,0);assert.equal(f.control.getState(),'idle');assert.equal(f.clock.count,0);
});
test('native dictation inserts only completed text into the same draft and requires separate save',async()=>{
  const f=fixture({value:'Please'});await listen(f);assert.equal(f.insertions.length,0);await f.control.stop();
  assert.equal(f.control.getState(),'stopping');f.setRemote({state:'transcribing'});await f.clock.advance(750);assert.equal(f.control.getState(),'transcribing');
  f.setRemote({state:'complete',text:'spoken words'});await f.clock.advance(750);
  assert.equal(f.draft.value,'Please spoken words');assert.equal(f.control.getState(),'idle');assert.equal(f.clock.count,0);
  assert.ok(f.calls.every(c=>c.options.timeout<=15000));assert.deepEqual(named(f,'cancel').at(-1).args,{sessionId:'session-1'});
});
test('legacy recorder consent state is cancelled with an update instruction, not another popup',async()=>{
  const f=fixture({start:async()=>({sessionId:'session-1',state:'awaiting-consent',local:true})});
  await f.control.start();assert.equal(f.control.getState(),'idle');
  assert.equal(await f.control.stop(),false);assert.equal(named(f,'stop').length,0);
  assert.deepEqual(named(f,'cancel')[0].args,{sessionId:'session-1'});
  assert.match(f.errors[0],/Reopen the updated reader/);assert.equal(f.clock.count,0);
  assert.ok(!f.states.some(value=>value.state==='awaiting-consent'));
});
test('cancelling while runtime check is pending never sends start',async()=>{
  const pending=deferred(),f=fixture({info:()=>pending.promise});const starting=f.control.start();f.control.cancel();
  pending.resolve({available:true,local:true});await starting;assert.equal(named(f,'start').length,0);assert.equal(f.clock.count,0);
});
test('pending start is cancelled by request ID, and late session reply is independently cancelled',async()=>{
  const pending=deferred(),f=fixture({start:()=>pending.promise});const starting=f.control.start();await tick();f.control.cancel();
  assert.deepEqual(named(f,'cancel')[0].args,{requestId:'request-1'});
  assert.equal(named(f,'start')[0].options.signal,undefined,'Never abort away the late session ID.');
  pending.resolve({sessionId:'late-session',state:'starting',local:true});await starting;
  assert.deepEqual(named(f,'cancel')[1].args,{sessionId:'late-session'});assert.equal(f.clock.count,0);assert.equal(f.insertions.length,0);
});
test('one recording and no overlapping status requests',async()=>{
  const pending=deferred(),f=fixture({status:()=>pending.promise});await f.control.start();assert.equal(await f.control.start(),false);
  await f.clock.advance(1900);assert.equal(named(f,'status').length,1);assert.equal(named(f,'start').length,1);
  pending.resolve({sessionId:'session-1',state:'recording',local:true});await tick();f.control.cancel();
});
test('heartbeats renew the native lease at two-second intervals',async()=>{
  const f=fixture();await f.control.start();await f.clock.advance(6000);
  assert.equal(named(f,'heartbeat').length,3);assert.ok(named(f,'heartbeat').every(c=>c.options.timeout===5000));
  f.control.cancel();const previous=f.calls.length;await f.clock.advance(20000);assert.equal(f.calls.length,previous);assert.equal(f.clock.count,0);
});
test('repeated stop is deduplicated and stale recording status never regresses stopping',async()=>{
  const pending=deferred(),f=fixture({stop:()=>pending.promise});await listen(f);const stopping=f.control.stop();
  assert.equal(await f.control.stop(),false);await f.clock.advance(750);assert.equal(f.control.getState(),'stopping');
  pending.resolve({sessionId:'session-1',state:'transcribing',local:true});await stopping;
  await f.clock.advance(750);assert.equal(f.control.getState(),'transcribing');f.control.cancel();
});
test('automatic duration-limit transcription is accepted without a manual stop RPC',async()=>{
  const f=fixture();await listen(f);f.setRemote({state:'transcribing',elapsedSeconds:120});await f.clock.advance(750);
  assert.equal(f.control.getState(),'transcribing');assert.equal(named(f,'stop').length,0);
  f.setRemote({state:'complete',text:'Automatic result'});await f.clock.advance(750);assert.equal(f.draft.value,'Automatic result');
});
test('cancellation, disposal, and changed binding reject stale completion',async t=>{
  for(const mode of ['cancel','dispose','source'])await t.test(mode,async()=>{
    const pending=deferred(),f=fixture({status:()=>pending.promise});await f.control.start();await f.clock.advance(750);
    if(mode==='source')f.changeBinding();else f.control[mode]();pending.resolve({sessionId:'session-1',state:'complete',text:'stale',local:true});await tick();
    assert.equal(f.insertions.length,0);assert.equal(f.errors.length,0);assert.equal(f.control.getState(),'idle');assert.equal(f.clock.count,0);
  });
});
test('old completion after a new session starts cannot modify its draft or state',async()=>{
  const pending=deferred();let reads=0;const f=fixture({status:async args=>++reads===1?pending.promise:{sessionId:args.sessionId,state:'recording',local:true}});
  await f.control.start();await f.clock.advance(750);f.control.cancel();await f.control.start();await f.clock.advance(750);
  assert.equal(f.control.getState(),'listening');pending.resolve({sessionId:'session-1',state:'complete',text:'old',local:true});await tick();
  assert.equal(f.insertions.length,0);assert.equal(f.control.getState(),'listening');f.control.cancel();
});
test('simultaneous terminal poll and heartbeat insert only once',async()=>{
  const statusResult=deferred(),beatResult=deferred(),f=fixture({status:()=>statusResult.promise,heartbeat:()=>beatResult.promise});
  await f.control.start();await f.clock.advance(2000);const done={sessionId:'session-1',state:'complete',text:'one result',local:true};
  statusResult.resolve(done);beatResult.resolve(done);await tick();assert.equal(f.insertions.length,1);assert.equal(f.clock.count,0);
});
test('typed edits survive and completed transcript appends without truncation',async()=>{
  const f=fixture({value:'Original'});await listen(f);f.edit('Revised draft.');const text='x'.repeat(2200);
  f.setRemote({state:'complete',text});await f.clock.advance(750);
  assert.equal(f.draft.value,`Revised draft. ${text}`);assert.match(f.notices.at(-1),/latest edits/);
});
test('empty recognition preserves typed text and reports no speech',async()=>{
  const f=fixture({value:'Keep this'});await listen(f);f.setRemote({state:'complete',text:'',empty:true});await f.clock.advance(750);
  assert.equal(f.draft.value,'Keep this');assert.equal(f.insertions.length,0);assert.match(f.notices.at(-1),/No speech/);
});
test('missing runtime never starts the native microphone',async()=>{
  const f=fixture({info:async()=>({available:false,local:true,reason:'Runtime missing.'})});await f.control.start();
  assert.equal(named(f,'start').length,0);assert.deepEqual(f.errors,['Runtime missing.']);assert.equal(f.control.diagnostics().runtime,'unavailable');
});
test('two polling failures cancel the session and retain the draft',async()=>{
  const f=fixture({value:'Keep me',status:async()=>{throw new Error('Recorder connection lost.');}});await f.control.start();await f.clock.advance(1500);
  assert.equal(named(f,'status').length,2);assert.equal(f.control.getState(),'idle');assert.equal(f.draft.value,'Keep me');assert.equal(f.errors.length,1);assert.equal(f.clock.count,0);
});
test('heartbeat failure stops renewing capture and requests native cleanup',async()=>{
  const f=fixture({heartbeat:async()=>{throw new Error('Lease unavailable.');}});await f.control.start();await f.clock.advance(2000);
  assert.equal(f.control.getState(),'idle');assert.match(f.errors[0],/Lease/);assert.equal(named(f,'cancel').length,1);assert.equal(f.clock.count,0);
});
test('native cancellation or error never replaces the typed draft',async t=>{
  for(const state of ['cancelled','error'])await t.test(state,async()=>{
    const f=fixture({value:'Keep me'});await f.control.start();f.setRemote({state,message:'Microphone disconnected.'});await f.clock.advance(state==='error'?1500:750);
    assert.equal(f.draft.value,'Keep me');assert.equal(f.control.getState(),'idle');assert.equal(f.clock.count,0);
  });
});
test('expired native lease is explained rather than reported as a user cancellation',async()=>{
  const f=fixture({value:'Keep me'});await listen(f);
  f.setRemote({state:'cancelled',code:'DICTATION_LEASE_EXPIRED',message:'Recording stopped because the reader connection was lost.'});await f.clock.advance(750);
  assert.equal(f.draft.value,'Keep me');assert.match(f.errors[0],/connection was lost/);assert.equal(f.clock.count,0);
});
test('non-local or mismatched session responses are rejected',async t=>{
  for(const bad of [{local:false},{sessionId:'another-session'}])await t.test(JSON.stringify(bad),async()=>{
    const f=fixture();await f.control.start();f.setRemote({state:'complete',text:'bad',...bad});await f.clock.advance(1500);
    assert.equal(f.insertions.length,0);assert.equal(f.errors.length,1);assert.equal(f.control.getState(),'idle');
  });
});
test('insertion respects the snapshot cursor range and punctuation',()=>{
  assert.deepEqual(insertDictatedText({current:'A old phrase.',original:'A old phrase.',start:2,end:12,text:'new wording'}),{value:'A new wording.',caret:13,appended:false});
});
test('feedback integration is inline-only, cancels on lifecycle boundaries, and guards Enter',()=>{
  const source=readFileSync(new URL('../src/feedback.mjs',import.meta.url),'utf8');
  assert.ok(!source.includes('requestInComposer'));assert.ok(!source.includes('comments.attachSelection'));
  assert.match(source,/value=value;input\.focus\(\);input\.setSelectionRange/);
  assert.match(source,/visibilityState==='hidden'\)dictation\.cancel/);assert.match(source,/'pagehide',\(\)=>dictation\.cancel/);
  assert.match(source,/dictation\.getState\(\)==='listening'\)void dictation\.stop\(\);else if\(!dictation\.isActive\(\)\)/);
  assert.match(source,/dictation\.isActive\(\)\)return/);assert.match(source,/nothing was truncated/);
  assert.match(source,/'feedback-dictation-cancel'\),'click',\(\)=>\{dictation\.cancel\(\);/);
  assert.match(source,/'feedback-dictation-cancel'\)\.hidden=!voiceActive/);
  assert.match(source,/'feedback-voice'\)\.hidden=voiceActive&&dictation\.getState\(\)!=='listening'/);
  assert.ok(!/On first use|permission window|click Start in/i.test(source));
});
