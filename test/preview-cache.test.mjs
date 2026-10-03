import test from 'node:test';
import assert from 'node:assert/strict';
import {PreviewCache,previewPriority} from '../src/preview-cache.mjs';
test('preview priority starts at current page and favors direction without invalid or duplicate pages',()=>{
  assert.deepEqual(previewPriority(10,5,1,2),[5,6,4,7,3]);
  assert.deepEqual(previewPriority(10,1,-1,2),[1,2,3]);
});
test('compressed appearances survive independent canvas lifecycles and obey byte limit',()=>{
  const evicted=[];const cache=new PreviewCache({maxBytes:10,onEvict:id=>evicted.push(id)});
  cache.set(1,{bytes:4});cache.set(2,{bytes:4});cache.set(3,{bytes:4},new Set([1]));
  assert.deepEqual(evicted,[2]);assert.equal(cache.has(1),true);assert.equal(cache.bytes,8);
  assert.equal(cache.set(4,{bytes:11}),false);assert.equal(cache.bytes,8);
  cache.clear();assert.equal(cache.bytes,0);
});
