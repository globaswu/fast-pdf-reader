import test from 'node:test';
import assert from 'node:assert/strict';
import { SharpScheduler, SharpCache, sharpPriority, sharpTargetWidth, choosePageAppearance } from '../src/sharp-scheduler.mjs';

test('sharp work starts at focus, then visible pages, then directional neighbors', () => {
  assert.deepEqual(sharpPriority(30, 10, 1, 2, [9, 10, 11, 9, 0]), [10, 11, 9, 12, 8]);
  assert.deepEqual(sharpPriority(30, 10, -1, 2, [9, 10, 11]), [10, 9, 11, 8, 12]);
  assert.deepEqual(sharpPriority(3, 1, -1, 3), [1, 2, 3]);
  assert.deepEqual(sharpPriority(3, 0), []);
});

test('moving viewport immediately chooses fresh foreground work and never interrupts an active call', () => {
  const ready = new Map();
  const scheduler = new SharpScheduler({ pageCount: 100, isReady: (page, width) => ready.get(page) >= width });
  scheduler.setViewport({ focus: 10 });
  const active = scheduler.next();
  assert.equal(active.pageNumber, 10);
  scheduler.setViewport({ focus: 30 });
  assert.equal(scheduler.next(), null);
  assert.equal(scheduler.active, active);
  ready.set(10, active.width);
  scheduler.complete(active);
  assert.equal(scheduler.next().pageNumber, 30);
  // No timer, quiet period, or scroll-end signal is required.
});

test('direction reversal drops unstarted forward work and warms the new direction first', () => {
  const ready = new Set([20]);
  const scheduler = new SharpScheduler({ pageCount: 50, isReady: page => ready.has(page) });
  scheduler.setViewport({ focus: 20, direction: 1 });
  assert.deepEqual(scheduler.pending().map(job => job.pageNumber), [21, 19, 22, 18]);
  scheduler.setViewport({ focus: 20, direction: -1 });
  assert.equal(scheduler.next().pageNumber, 19);
});

test('zoom requests wider pixels while retaining a lower sharp image as fallback', () => {
  const cache = new SharpCache();
  const scheduler = new SharpScheduler({ pageCount: 1, isReady: (...args) => cache.has(...args) });
  const low = { width: 600, bytes: 4, url: 'preview' };
  const first = scheduler.next();
  cache.set(1, { width: 1200, bytes: 8, url: 'sharp' });
  scheduler.complete(first);
  assert.equal(scheduler.next(), null);
  scheduler.setViewport({ width: 1600 });
  assert.equal(scheduler.next().width, 1600);
  assert.equal(choosePageAppearance(low, cache.peek(1)).url, 'sharp');
  assert.equal(cache.set(1, { width: 600, bytes: 4, url: 'late-low' }), false);
  assert.equal(cache.peek(1).url, 'sharp');
  assert.equal(sharpTargetWidth(601, 2), 1400);
  assert.equal(sharpTargetWidth(1000, 2), 1600);
  assert.equal(sharpTargetWidth(500, 1), 1200);
});

test('completed narrow work after zoom does not satisfy the wider request', () => {
  const cache = new SharpCache();
  const scheduler = new SharpScheduler({ pageCount: 1, isReady: (...args) => cache.has(...args) });
  const old = scheduler.next();
  scheduler.setViewport({ width: 1600 });
  cache.set(1, { width: old.width, bytes: 4 });
  assert.equal(scheduler.complete(old), true);
  assert.equal(scheduler.next().width, 1600);
});

test('failed candidates do not spin and document replacement rejects stale completion', () => {
  const scheduler = new SharpScheduler({ pageCount: 1 });
  const first = scheduler.next();
  scheduler.fail(first);
  assert.equal(scheduler.next(), null);
  scheduler.reset(1);
  const current = scheduler.next();
  assert.equal(scheduler.complete(first), false);
  assert.equal(scheduler.active, current);
  assert.equal(scheduler.complete(current), true);
});

test('cache pressure defers a page only until the viewport actually changes', () => {
  const scheduler = new SharpScheduler({ pageCount: 2, prefetchRadius: 0 });
  scheduler.defer(scheduler.next());
  assert.equal(scheduler.next(), null);
  scheduler.setViewport({ focus: 1 });
  assert.equal(scheduler.next(), null);
  scheduler.setViewport({ focus: 2 });
  const other = scheduler.next();
  scheduler.defer(other);
  scheduler.setViewport({ focus: 1 });
  assert.equal(scheduler.next().pageNumber, 1);
});

test('pixel-budget capped pages satisfy their completed requested tier without repeated renders', () => {
  const cache = new SharpCache();
  cache.set(1, { width: 800, requestedWidth: 1200, bytes: 4, url: 'first' });
  assert.equal(cache.has(1, 1200), true);
  assert.equal(cache.has(1, 1600), false);
  assert.equal(cache.set(1, { width: 800, requestedWidth: 1600, bytes: 4, url: 'second' }), false);
  assert.equal(cache.has(1, 1600), true);
  assert.equal(cache.peek(1).url, 'first');
});

test('accepted neighbors evicted by cache pressure do not rerender in an idle loop', () => {
  const cache = new SharpCache({maxBytes:16});
  const scheduler = new SharpScheduler({pageCount:5,isReady:(...args)=>cache.has(...args)});
  scheduler.setViewport({focus:3});
  const rendered=[];
  for(let attempt=0;attempt<10;attempt++) {
    const job=scheduler.next();if(!job)break;
    rendered.push(job.pageNumber);
    cache.set(job.pageNumber,{width:job.width,bytes:4},new Set([3]));
    scheduler.complete(job);
  }
  assert.deepEqual(rendered,[3,4,2,5,1]);
  assert.equal(scheduler.next(),null);
  scheduler.setViewport({focus:3});assert.equal(scheduler.next(),null);
  scheduler.setViewport({focus:4});assert.equal(scheduler.next().pageNumber,4);
});

test('cache eviction protects selected pages and obeys the encoded target otherwise', () => {
  const evicted = [];
  const cache = new SharpCache({ maxBytes: 10, onEvict: id => evicted.push(id) });
  cache.set(1, { width: 1200, bytes: 4 });
  cache.set(2, { width: 1200, bytes: 4 });
  cache.set(3, { width: 1200, bytes: 4 }, new Set([1]));
  assert.deepEqual(evicted, [2]);
  assert.equal(cache.has(1, 1200), true);
  assert.equal(cache.bytes, 8);
  cache.get(1);
  cache.set(4, { width: 1200, bytes: 4 });
  assert.deepEqual(evicted, [2, 3]);
  assert.equal(cache.bytes, 8);
});

test('soft limit preserves all protected content, then trims after protection ends', () => {
  const cache = new SharpCache({ maxBytes: 10 });
  cache.set(1, { width: 1200, bytes: 8 }, new Set([1]));
  cache.set(2, { width: 1200, bytes: 8 }, new Set([1, 2]));
  assert.equal(cache.bytes, 16);
  assert.equal(cache.snapshot().sharpExceedsTarget, true);
  assert.equal(cache.set(3, { width: 1200, bytes: 4 }, new Set([1, 2])), false);
  assert.equal(cache.items.size, 2);
  cache.trim(new Set([2]));
  assert.equal(cache.has(2), true);
  assert.equal(cache.bytes, 8);
});

test('a rejected upgrade preserves the old image and does not evict other pages', () => {
  const cache = new SharpCache({ maxBytes: 10 });
  cache.set(1, { width: 1200, bytes: 3 });
  cache.set(2, { width: 1200, bytes: 6 });
  assert.equal(cache.set(1, { width: 1600, bytes: 8 }, new Set([2])), false);
  assert.equal(cache.peek(1).width, 1200);
  assert.equal(cache.bytes, 9);
});

test('rotation mismatch invalidates a cached appearance without accepting stale jobs', () => {
  const cache = new SharpCache();
  cache.set(1, { width: 1600, bytes: 8, rotation: 0 });
  assert.equal(cache.has(1, 1200, 90), false);
  assert.equal(choosePageAppearance({ width: 600 }, cache.peek(1), 90), null);
  assert.equal(cache.set(1, { width: 1200, bytes: 4, rotation: 90 }), true);
  assert.equal(cache.has(1, 1200, 450), true);
  assert.throws(() => new SharpScheduler({ pageCount: 1 }).setViewport({ rotation: 45 }), /90 degrees/);
});

test('invalid byte estimates cannot corrupt the cache accounting', () => {
  const cache = new SharpCache();
  assert.throws(() => cache.set(1, { width: 1200, bytes: NaN }), /Invalid/);
  assert.throws(() => cache.set(1, { width: 1200, bytes: -1 }), /Invalid/);
  assert.equal(cache.bytes, 0);
});
