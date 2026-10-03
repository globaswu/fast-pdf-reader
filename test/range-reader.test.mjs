import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockRangeReader } from '../src/range-reader.mjs';

const bytes = size => Uint8Array.from({length:size}, (_, index) => index % 251);
const tick = () => new Promise(resolve => setImmediate(resolve));
const make = (options = {}) => {
  const source = bytes(options.size || 64), calls = [];
  const reader = new BlockRangeReader({ size: source.length, blockSize: 16,
    maxCacheBytes: 32, readAheadBlocks: 0,
    readChunk: async (begin,end) => { calls.push([begin,end]); return source.slice(begin,end); }, ...options });
  return { reader, source, calls };
};

test('aligned blocks deliver exact unaligned demand and clipped final block', async () => {
  const h=make({size:51});
  assert.deepEqual(await h.reader.read(13,51),h.source.slice(13,51));
  assert.deepEqual(h.calls,[[0,16],[16,32],[32,48],[48,51]]);
  assert.ok(h.reader.snapshot().cachedBytes<=32);
});

test('overlapping demand joins one bridge request and returns independent arrays', async () => {
  const h=make();
  const [a,b]=await Promise.all([h.reader.read(0,8),h.reader.read(4,12)]);
  assert.deepEqual(a,h.source.slice(0,8));assert.deepEqual(b,h.source.slice(4,12));
  a[4]=255;
  assert.equal(b[0],4);assert.deepEqual(h.calls,[[0,16]]);
  assert.equal(h.reader.snapshot().joinedReads,1);
});

test('cache merges four adjacent worker reads into one bridge read', async () => {
  const h=make();
  for(let begin=0;begin<16;begin+=4)assert.deepEqual(await h.reader.read(begin,begin+4),h.source.slice(begin,begin+4));
  assert.equal(h.calls.length,1);assert.equal(h.reader.snapshot().cacheHits,3);
});

test('cache stays bounded and evicts least recently used blocks', async () => {
  const h=make();
  await h.reader.read(0,16);await h.reader.read(16,32);await h.reader.read(0,8);
  await h.reader.read(32,48);await h.reader.read(16,20);
  assert.deepEqual(h.calls,[[0,16],[16,32],[32,48],[16,32]]);
  assert.equal(h.reader.snapshot().cachedBytes,32);
  assert.equal(h.reader.snapshot().evictions,2);
});

test('bounded read-ahead does not recursively read the whole document', async () => {
  const h=make({readAheadBlocks:1});
  await h.reader.read(0,8);await tick();
  assert.deepEqual(h.calls,[[0,16],[16,32]]);
  await h.reader.read(16,24,{readAhead:false});await tick();
  assert.equal(h.calls.length,2);assert.equal(h.reader.snapshot().readAheadReads,1);
});

test('current demand is served before queued low-priority demand without dropping either', async () => {
  const source=bytes(64),calls=[],releases=[];
  const h=make({concurrency:1,readChunk:(begin,end)=>{calls.push([begin,end]);return new Promise(resolve=>releases.push(()=>resolve(source.slice(begin,end))));}});
  const first=h.reader.read(0,8);await tick();
  const old=h.reader.read(16,24,{priority:0});
  const current=h.reader.read(32,40,{priority:10});
  releases.shift()();await tick();
  assert.deepEqual(calls,[[0,16],[32,48]]);
  releases.shift()();await tick();releases.shift()();
  await Promise.all([first,old,current]);assert.equal(calls.length,3);
});

test('at most one speculative read runs and real demand uses remaining capacity', async () => {
  const source=bytes(96),calls=[],releases=[];
  const h=make({size:96,readAheadBlocks:2,concurrency:3,readChunk:(begin,end)=>{calls.push([begin,end]);return new Promise(resolve=>releases.push({begin,done:()=>resolve(source.slice(begin,end))}));}});
  const first=h.reader.read(0,8);await tick();releases.shift().done();await first;await tick();
  assert.deepEqual(calls,[[0,16],[16,32]]);assert.equal(h.reader.snapshot().activeReadAhead,1);
  const jumped=h.reader.read(64,72,{readAhead:false});await tick();
  assert.deepEqual(calls,[[0,16],[16,32],[64,80]]);
  assert.equal(h.reader.snapshot().discardedReadAhead,1);
  for(const release of releases)release.done();await jumped;await tick();
  assert.equal(h.reader.snapshot().activeReads,0);
});

test('abort rejects queued and active demand and late data cannot repopulate cache', async () => {
  const source=bytes(64);let finish;
  const h=make({concurrency:1,readChunk:(begin,end,signal)=>new Promise(resolve=>{assert.equal(signal.aborted,false);finish=()=>resolve(source.slice(begin,end));})});
  const first=h.reader.read(0,8),second=h.reader.read(16,24);
  const rejected=Promise.all([assert.rejects(first,{name:'AbortError'}),assert.rejects(second,{name:'AbortError'})]);
  await tick();h.reader.abort();finish();await rejected;await tick();
  assert.equal(h.reader.snapshot().cachedBytes,0);assert.equal(h.reader.snapshot().queuedReads,0);
  await assert.rejects(h.reader.read(32,40),{name:'AbortError'});
});

test('failed bridge read can be retried and is never cached', async () => {
  let attempts=0;const source=bytes(64);
  const h=make({readChunk:async(begin,end)=>{if(++attempts===1)throw new Error('fixture failure');return source.slice(begin,end);}});
  await assert.rejects(h.reader.read(0,8),/fixture failure/);
  assert.equal(h.reader.snapshot().cachedBytes,0);
  assert.deepEqual(await h.reader.read(0,8),source.slice(0,8));
});

test('invalid ranges and corrupt bridge lengths fail closed', async () => {
  const h=make();
  for(const pair of [[-1,8],[8,8],[0,65],[0,NaN],[0.5,8]])await assert.rejects(h.reader.read(...pair),RangeError);
  const bad=make({readChunk:async()=>new Uint8Array(2)});
  await assert.rejects(bad.reader.read(0,8),/invalid byte range/);
  assert.equal(bad.reader.snapshot().cachedBytes,0);
  assert.throws(()=>new BlockRangeReader({size:12,readChunk:()=>{},blockSize:16,maxCacheBytes:8}));
});
