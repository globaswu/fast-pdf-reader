import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedbackQueue} from '../src/feedback-queue.mjs';

const source={documentId:'revision-1',name:'sample.pdf',sourcePath:'C:\\example\\sample.pdf',size:12345,modifiedMs:99};
function request(id,revision=source){
  return {id,source:revision,selection:{kind:'text',text:`Exact selected passage ${id}.`,boxes:[{page:7,pdfRect:[12,40,98,51]}]},comment:`Requested edit ${id}.`};
}
function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
function fixture({supported=true,update=async()=>({})}={}){
  const writes=[];
  let messageCalls=0;
  const app={
    getHostCapabilities:()=>supported?{updateModelContext:{text:{},structuredContent:{}},experimental:{'openai/message':{draft:{}}}}:{},
    async updateModelContext(payload){writes.push(structuredClone(payload));return update(payload,writes.length);},
    sendMessage(){messageCalls++;throw new Error('Feedback must not invoke the composer or submit a message.');},
  };
  const queue=createFeedbackQueue({app,extensions:null});
  return {queue,writes,get messageCalls(){return messageCalls;}};
}
const ids=items=>items.map(item=>item.id);
const attachedIds=payload=>ids(payload.structuredContent.pdfChangeRequests.requests);
const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));

test('collecting comments is local even when context and composer capabilities are available',()=>{
  const f=fixture(),a=request('a'),b=request('b');
  f.queue.add(a);f.queue.add(b);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a','b']);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().contextAttached,false);
  assert.equal(f.writes.length,0);
  assert.equal(f.messageCalls,0);
});

test('explicit send attaches the entire ordered batch without using the composer',async()=>{
  const f=fixture();
  f.queue.add(request('a'));f.queue.add(request('b'));
  await f.queue.send();
  assert.equal(f.writes.length,1);
  assert.deepEqual(attachedIds(f.writes[0]),['a','b']);
  assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['a','b']);
  assert.equal(f.queue.snapshot().contextAttached,true);
  assert.equal(f.queue.snapshot().requests.length,2,'Host acknowledgment must not discard collected comments.');
  assert.equal(f.queue.snapshot().busy,false);
  assert.equal(f.messageCalls,0);
});

test('later collection waits for an explicit send and then replaces context with the full batch',async()=>{
  const f=fixture();
  f.queue.add(request('a'));await f.queue.send();
  f.queue.add(request('b'));
  assert.equal(f.writes.length,1);
  assert.equal(f.queue.snapshot().contextAttached,false);
  assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['a']);
  await f.queue.send();
  assert.deepEqual(attachedIds(f.writes[1]),['a','b']);
  assert.equal(f.queue.snapshot().contextAttached,true);
});

test('unsupported context preserves local comments and never falls back to sending a message',async()=>{
  const f=fixture({supported:false});
  f.queue.add(request('a'));
  await assert.rejects(f.queue.send(),/context|support|available|connection/i);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a']);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().busy,false);
  assert.equal(f.writes.length,0);
  assert.equal(f.messageCalls,0);
});

test('host rejection and transport failure retain comments and prior attachment state',async t=>{
  for(const failure of ['rejection','exception'])await t.test(failure,async()=>{
    const f=fixture({update:async(_payload,count)=>{
      if(count===1)return {};
      if(failure==='rejection')return {isError:true};
      throw new Error('Connection lost');
    }});
    f.queue.add(request('a'));await f.queue.send();
    f.queue.add(request('b'));
    await assert.rejects(f.queue.send());
    assert.deepEqual(ids(f.queue.snapshot().requests),['a','b']);
    assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['a']);
    assert.equal(f.queue.snapshot().contextAttached,false);
    assert.equal(f.queue.snapshot().busy,false);
    assert.equal(f.messageCalls,0);
  });
});

test('removing a locally collected comment leaves the existing host attachment untouched',async()=>{
  const f=fixture();
  f.queue.add(request('a'));await f.queue.send();f.queue.add(request('b'));
  await f.queue.remove('b');
  assert.equal(f.writes.length,1);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a']);
  assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['a']);
  assert.equal(f.queue.snapshot().contextAttached,true);
});

test('removing an attached comment never attaches other comments that are still local',async()=>{
  const f=fixture();
  f.queue.add(request('a'));await f.queue.send();f.queue.add(request('b'));
  await f.queue.remove('a');
  assert.equal(f.writes.length,2);
  assert.deepEqual(attachedIds(f.writes[1]),[]);
  assert.deepEqual(ids(f.queue.snapshot().requests),['b']);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().contextAttached,false);
});

test('clear stays local for unattached comments and clears context for attached comments',async()=>{
  const f=fixture();
  f.queue.add(request('a'));await f.queue.clear();
  assert.equal(f.writes.length,0);
  assert.deepEqual(f.queue.snapshot().requests,[]);
  f.queue.add(request('b'));await f.queue.send();await f.queue.clear();
  assert.equal(f.writes.length,2);
  assert.deepEqual(attachedIds(f.writes[1]),[]);
  assert.deepEqual(f.queue.snapshot().requests,[]);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().contextAttached,false);
});

test('host consumption clears the attachment flag while keeping collected comments available',async()=>{
  const f=fixture();
  f.queue.add(request('a'));await f.queue.send();
  f.queue.syncHostContext(null);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a']);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().contextAttached,false);
  assert.equal(f.writes.length,1);
});

test('a pending context handoff blocks duplicate sends and other queue mutations',async()=>{
  const pending=deferred(),f=fixture({update:()=>pending.promise});
  f.queue.add(request('a'));
  const first=f.queue.send();
  assert.equal(f.queue.snapshot().busy,true);
  await assert.rejects(f.queue.send(),/Wait|finish/i);
  assert.throws(()=>f.queue.add(request('b')),/Wait|finish/i);
  await assert.rejects(f.queue.remove('a'),/Wait|finish/i);
  await assert.rejects(f.queue.clear(),/Wait|finish/i);
  await nextTurn();
  assert.equal(f.writes.length,1);
  pending.resolve({});await first;
  assert.equal(f.queue.snapshot().busy,false);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a']);
  assert.equal(f.messageCalls,0);
});

test('reset empties local state immediately and serializes obsolete write, clear, then new batch',async()=>{
  const operations=[deferred(),deferred(),deferred()];
  const f=fixture({update:(_payload,count)=>operations[count-1].promise});
  f.queue.add(request('old'));
  const oldSend=f.queue.send();
  await nextTurn();
  assert.equal(f.writes.length,1);
  const reset=f.queue.reset();
  assert.deepEqual(f.queue.snapshot().requests,[]);
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  const replacement={...source,documentId:'revision-2',modifiedMs:100};
  f.queue.add(request('new',replacement));
  const newSend=f.queue.send();
  await nextTurn();
  assert.equal(f.writes.length,1,'The new document must wait for old-context cleanup.');
  operations[0].resolve({});await oldSend;await nextTurn();
  assert.equal(f.writes.length,2);
  assert.deepEqual(attachedIds(f.writes[1]),[]);
  assert.deepEqual(ids(f.queue.snapshot().requests),['new'],'The old response must not restore the old queue.');
  assert.deepEqual(f.queue.snapshot().attachedRequests,[]);
  assert.equal(f.queue.snapshot().busy,true,'The old operation must not release the new operation busy state.');
  operations[1].resolve({});await reset;await nextTurn();
  assert.equal(f.writes.length,3);
  assert.deepEqual(attachedIds(f.writes[2]),['new']);
  operations[2].resolve({});await newSend;
  assert.deepEqual(ids(f.queue.snapshot().requests),['new']);
  assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['new']);
  assert.equal(f.queue.snapshot().contextAttached,true);
  assert.equal(f.queue.snapshot().busy,false);
  assert.equal(f.messageCalls,0);
});

test('failed removal retains both local comments and the last acknowledged attachment',async()=>{
  const f=fixture({update:async(_payload,count)=>{
    if(count>1)throw new Error('Connection lost');
    return {};
  }});
  f.queue.add(request('a'));await f.queue.send();f.queue.add(request('b'));
  await assert.rejects(f.queue.remove('a'),/Connection lost/);
  assert.deepEqual(ids(f.queue.snapshot().requests),['a','b']);
  assert.deepEqual(ids(f.queue.snapshot().attachedRequests),['a']);
  assert.equal(f.queue.snapshot().busy,false);
});

test('a failed context clear cannot poison later sends after a document reset',async()=>{
  const f=fixture({update:async(_payload,count)=>{
    if(count===2)throw new Error('Cleanup failed');
    return {};
  }});
  f.queue.add(request('old'));await f.queue.send();
  await assert.rejects(f.queue.reset(),/Cleanup failed/);
  assert.deepEqual(f.queue.snapshot().requests,[]);
  f.queue.add(request('new',{...source,documentId:'revision-2'}));
  await f.queue.send();
  assert.deepEqual(f.writes.map(attachedIds),[['old'],[],['new']]);
  assert.equal(f.queue.snapshot().contextAttached,true);
  assert.equal(f.messageCalls,0);
});
