import test from 'node:test';
import assert from 'node:assert/strict';
import {closePdfWorker} from '../src/worker-lifecycle.mjs';

test('overlapping teardown shares one acknowledgement before terminating', async () => {
  let acknowledge, calls=0, terminated=0;
  const worker={terminate(){terminated++;}};
  const task={destroy(){calls++;return new Promise(resolve=>{acknowledge=resolve;});}};
  const first=closePdfWorker(task,worker), second=closePdfWorker(task,worker);
  assert.equal(first,second);await Promise.resolve();
  assert.equal(calls,1);assert.equal(terminated,0);
  acknowledge();await first;assert.equal(terminated,1);
});

test('an unresponsive old worker cannot hang reopening forever', async () => {
  let terminated=0;
  await closePdfWorker({destroy:()=>new Promise(()=>{})},{terminate(){terminated++;}},{timeoutMs:5});
  assert.equal(terminated,1);
});

test('rejected teardown terminates only its own worker once', async () => {
  let terminated=0, unrelated=0;
  const worker={terminate(){terminated++;}}, other={terminate(){unrelated++;}};
  await closePdfWorker({destroy:()=>Promise.reject(new Error('already failed'))},worker);
  await closePdfWorker(null,worker);
  assert.equal(terminated,1);assert.equal(unrelated,0);assert.ok(other);
});
