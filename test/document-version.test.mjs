import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentVersionMonitor} from '../src/document-version.mjs';

const revision = documentId => ({documentId, name:'sample.pdf', size:123});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve=yes; reject=no; }); return {promise, resolve, reject}; };
async function flush() { for (let turn=0; turn<12; turn++) await Promise.resolve(); }
function fixture(options = {}) {
  let time=0, sequence=0, calls=0, visible=true, response=revision('a');
  const timers=new Map(), changes=[];
  const monitor=createDocumentVersionMonitor({
    readInfo:() => { calls++; if (response instanceof Error) throw response; return typeof response === 'function' ? response() : response; },
    onChange:state => changes.push(state), isVisible:() => visible,
    now:() => time,
    setTimer:(callback, delay) => { const id=++sequence; timers.set(id,{callback,at:time+delay}); return id; },
    clearTimer:id => timers.delete(id), ...options,
  });
  async function advance(ms) {
    const target=time+ms;
    let count=0;
    while (true) {
      const next=[...timers].filter(([,timer]) => timer.at<=target).sort((a,b) => a[1].at-b[1].at)[0];
      if (!next) break;
      assert.ok(++count<=100, 'timer loop must remain bounded');
      time=next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
    }
    time=target; await flush();
  }
  return {monitor, timers, changes, advance, get calls(){return calls;}, get time(){return time;},
    respond(value){response=value;}, visible(value){visible=value;}};
}

test('unchanged metadata uses one five-second timer and leaves the document current', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true});
  assert.equal(f.calls,0); assert.equal(f.timers.size,1);
  await f.advance(4999); assert.equal(f.calls,0);
  await f.advance(1); assert.equal(f.calls,1);
  assert.deepEqual(f.monitor.snapshot(),{status:'current',latestInfo:revision('a'),canPoll:true,reason:null});
  await f.advance(15000); assert.equal(f.calls,4); assert.equal(f.timers.size,1);
  assert.ok(f.changes.every(state => state.status==='current'), 'ordinary polls must not briefly show a checking notice');
  f.monitor.dispose(); assert.equal(f.timers.size,0);
});

test('awaiting an ordinary metadata read does not change the current or confirmed-changed state', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true});
  for (const expected of ['current','changed']) {
    if (expected==='changed') {
      f.respond(revision('b')); await f.monitor.check(); await f.advance(1500);
    }
    const pending=deferred(), changes=f.changes.length;
    f.respond(() => pending.promise); const checking=f.monitor.check(); await flush();
    assert.equal(f.monitor.snapshot().status,expected); assert.equal(f.changes.length,changes);
    pending.resolve(revision(expected==='current' ? 'a' : 'b')); await checking;
    assert.ok(f.changes.slice(changes).every(state => state.status===expected));
  }
  f.monitor.dispose();
});

test('a changed revision requires two matching observations across the settle interval', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(revision('b'));
  await f.monitor.check();
  assert.equal(f.monitor.snapshot().status,'checking'); assert.equal(f.monitor.snapshot().latestInfo.documentId,'a');
  await f.advance(1499); assert.equal(f.calls,1);
  await f.advance(1); assert.equal(f.calls,2);
  assert.equal(f.monitor.snapshot().status,'changed'); assert.equal(f.monitor.snapshot().latestInfo.documentId,'b');
  await f.advance(5000); assert.equal(f.calls,3); assert.equal(f.timers.size,1);
  assert.equal(f.monitor.snapshot().status,'changed'); f.monitor.dispose();
});

test('continuous writes reset settling, and later candidates disable opening until confirmed', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(revision('b'));
  await f.monitor.check(); await f.advance(1000); f.respond(revision('c')); await f.monitor.notify();
  await f.advance(1499); assert.equal(f.monitor.snapshot().status,'checking');
  await f.advance(1); assert.equal(f.monitor.snapshot().latestInfo.documentId,'c');
  f.respond(revision('d')); const firstNotice=f.changes.length; await f.monitor.check();
  assert.equal(f.monitor.snapshot().latestInfo.documentId,'c');
  assert.ok(f.changes.slice(firstNotice).every(state => state.status==='checking'));
  await f.advance(1499); assert.equal(f.monitor.snapshot().status,'checking');
  await f.advance(1); assert.equal(f.monitor.snapshot().latestInfo.documentId,'d');
  assert.equal(f.monitor.snapshot().status,'changed');
  f.respond(revision('a')); await f.monitor.check(); assert.equal(f.monitor.snapshot().status,'current'); f.monitor.dispose();
});

test('a candidate that reverts to the loaded version does not produce a notice', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(revision('b'));
  await f.monitor.check(); f.respond(revision('a')); await f.advance(1500);
  assert.equal(f.monitor.snapshot().status,'current'); assert.equal(f.monitor.snapshot().latestInfo.documentId,'a');
  assert.ok(!f.changes.some(state => state.status==='changed')); f.monitor.dispose();
});

test('missing, incomplete, or temporarily invalid files retry and recover with fresh settling', async () => {
  for (const problem of [Object.assign(new Error('File not found'),{code:'PDF_NOT_FOUND'}),new Error('PDF header incomplete'),{}]) {
    const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(revision('b'));
    await f.monitor.check(); f.respond(problem); await f.advance(1500);
    assert.equal(f.monitor.snapshot().status,'unavailable'); assert.equal(f.monitor.snapshot().canPoll,true);
    assert.equal(f.monitor.snapshot().latestInfo.documentId,'a'); assert.ok(f.monitor.snapshot().reason);
    const calls=f.calls; f.respond(revision('b')); await f.advance(4999); assert.equal(f.calls,calls);
    await f.advance(1); assert.equal(f.monitor.snapshot().status,'checking');
    await f.advance(1500); assert.equal(f.monitor.snapshot().status,'changed'); assert.equal(f.timers.size,1);
    f.monitor.dispose();
  }
});

test('concurrent checks and host notifications share one metadata read', async () => {
  const f=fixture(), pending=deferred(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(() => pending.promise);
  const first=f.monitor.check(), second=f.monitor.check(), notification=f.monitor.notify();
  assert.equal(first,second); assert.equal(first,notification); await flush(); assert.equal(f.calls,1);
  await f.advance(20000); assert.equal(f.calls,1); assert.equal(f.timers.size,0);
  pending.resolve(revision('a')); await first; assert.equal(f.timers.size,1); f.monitor.dispose();
});

test('an old document read cannot publish after a switch and the next read waits for it', async () => {
  const f=fixture(), old=deferred(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(() => old.promise);
  const first=f.monitor.check(); await flush(); f.monitor.setDocument(revision('x'),{poll:true});
  f.respond(revision('x')); const second=f.monitor.check(); await flush(); assert.equal(f.calls,1);
  old.resolve(revision('b')); await Promise.all([first,second]);
  assert.equal(f.calls,2); assert.equal(f.monitor.snapshot().status,'current');
  assert.equal(f.monitor.snapshot().latestInfo.documentId,'x'); assert.equal(f.timers.size,1);
  assert.ok(!f.changes.some(state => state.latestInfo?.documentId==='b')); f.monitor.dispose();
});

test('null reset and disposal discard outstanding reads without recreating timers', async () => {
  for (const reset of [monitor => monitor.setDocument(null),monitor => monitor.dispose()]) {
    const f=fixture(), pending=deferred(); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(() => pending.promise);
    const checking=f.monitor.check(); await flush(); reset(f.monitor); const changes=f.changes.length;
    pending.resolve(revision('b')); await checking;
    assert.equal(f.changes.length,changes); assert.equal(f.timers.size,0);
    assert.deepEqual(f.monitor.snapshot(),{status:'current',latestInfo:null,canPoll:false,reason:null});
    await f.monitor.notify(); assert.equal(f.calls,1); f.monitor.dispose();
  }
});

test('hidden documents skip reads and a focus check probes immediately when visible', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true}); f.visible(false);
  await f.advance(20000); await f.monitor.check(); await f.monitor.notify();
  assert.equal(f.calls,0); assert.equal(f.timers.size,1);
  f.visible(true); f.respond(revision('b')); await f.monitor.check(); assert.equal(f.calls,1);
  await f.advance(1500); assert.equal(f.monitor.snapshot().status,'changed'); f.monitor.dispose();
});

test('explicit access denial stops automatic and notification reads until a new document is set', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a'),{poll:true});
  f.respond(Object.assign(new Error('Permission denied'),{code:'PDF_ACCESS_DENIED'})); await f.monitor.check();
  assert.equal(f.monitor.snapshot().status,'unavailable'); assert.equal(f.monitor.snapshot().canPoll,false);
  assert.equal(f.timers.size,0); await f.advance(60000); await f.monitor.check(); await f.monitor.notify();
  assert.equal(f.calls,1); assert.equal(f.monitor.snapshot().status,'unavailable');
  f.respond(revision('a')); f.monitor.setDocument(revision('a'),{poll:true}); await f.advance(5000);
  assert.equal(f.calls,2); assert.equal(f.monitor.snapshot().status,'current'); f.monitor.dispose();
});

test('resource notifications mark changed without metadata polling', async () => {
  const f=fixture(); f.monitor.setDocument(revision('a')); await f.advance(60000); await f.monitor.check();
  assert.equal(f.calls,0); assert.equal(f.monitor.snapshot().status,'current');
  await f.monitor.notify(); assert.equal(f.monitor.snapshot().status,'changed');
  assert.equal(f.monitor.snapshot().canPoll,false); assert.equal(f.monitor.snapshot().latestInfo.documentId,'a');
  assert.equal(f.calls,0); assert.equal(f.timers.size,0);
  f.monitor.setDocument(revision('b')); assert.equal(f.monitor.snapshot().status,'current'); f.monitor.dispose();
});

test('zero settling still requires a second observation without a tight timer loop', async () => {
  const f=fixture({settleMs:0}); f.monitor.setDocument(revision('a'),{poll:true}); f.respond(revision('b'));
  await f.monitor.check(); assert.equal(f.monitor.snapshot().status,'checking');
  await f.advance(0); assert.equal(f.calls,1); await f.advance(1);
  assert.equal(f.calls,2); assert.equal(f.monitor.snapshot().status,'changed'); f.monitor.dispose();
});
