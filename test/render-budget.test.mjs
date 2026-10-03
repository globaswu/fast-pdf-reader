import test from 'node:test';
import assert from 'node:assert/strict';
import { canvasSurfaceBytes, snapshotCanvasSurfaces, planCanvasEvictions, createMotionDiagnostics } from '../src/render-budget.mjs';

test('RGBA surface estimate handles released and invalid canvases', () => {
  assert.equal(canvasSurfaceBytes({ width: 1200, height: 1600 }), 7680000);
  assert.equal(canvasSurfaceBytes({ width: 0, height: 0 }), 0);
  assert.equal(canvasSurfaceBytes({ width: -1, height: 9 }), 0);
  assert.equal(canvasSurfaceBytes(null), 0);
});

test('surface snapshot includes detail canvas and does not double count base canvas', () => {
  const base = { width: 10, height: 10 }, detail = { width: 4, height: 4 };
  const result = snapshotCanvasSurfaces([{ id: 4, canvas: base, div: { querySelectorAll: () => [base, detail] } }]);
  assert.deepEqual(result, { pages: [{ id: 4, bytes: 464, canvases: 2 }], bytes: 464, canvases: 2 });
});

test('eviction is least recently used and protects visible or selected pages', () => {
  const result = planCanvasEvictions({ pages: [
    { id: 1, bytes: 40, lastUsed: 4 }, { id: 2, bytes: 40, lastUsed: 1 },
    { id: 3, bytes: 40, lastUsed: 3 }, { id: 4, bytes: 40, lastUsed: 0 },
  ], protectedPageIds: [4], maxBytes: 80 });
  assert.deepEqual(result, { evictPageIds: [2, 3], retainedBytes: 80, targetBytes: 80, exceedsTarget: false });
});

test('visible pages are retained even when they exceed the soft target', () => {
  assert.deepEqual(planCanvasEvictions({ pages: [{ id: 1, bytes: 100 }, { id: 2, bytes: 50 }], protectedPageIds: [1], maxBytes: 60 }),
    { evictPageIds: [2], retainedBytes: 100, targetBytes: 60, exceedsTarget: true });
  assert.throws(() => planCanvasEvictions({ pages: [{ id: 1, bytes: 10 }, { id: 1, bytes: 10 }], maxBytes: 60 }));
});

function harness(options = {}) {
  let clock = 0, nextId = 1;
  const scheduled = new Map();
  const diagnostics = createMotionDiagnostics({ now: () => clock,
    requestFrame: callback => { const id = nextId++; scheduled.set(id, callback); return id; },
    cancelFrame: id => scheduled.delete(id), ...options });
  return { diagnostics, scheduled, advance(ms) { clock += ms; const callbacks = [...scheduled.values()]; scheduled.clear(); callbacks.forEach(callback => callback(clock)); }, setTime(ms) { clock = ms; } };
}

test('motion sampler schedules nothing while idle and stops itself after input', () => {
  const h = harness({ observationTailMs: 40 });
  assert.equal(h.scheduled.size, 0);
  h.diagnostics.noteInput(); h.diagnostics.noteInput();
  assert.equal(h.scheduled.size, 1);
  h.advance(16); h.advance(16); h.advance(16);
  assert.equal(h.scheduled.size, 0);
  const result = h.diagnostics.snapshot();
  assert.equal(result.active, false);
  assert.equal(result.inputEvents, 2);
  assert.equal(result.bursts, 1);
  assert.equal(result.frameCallbackIntervals, 2);
  assert.equal(result.meanCallbackIntervalMs, 16);
});

test('continuous input extends only the diagnostics window and storage stays bounded', () => {
  const h = harness({ observationTailMs: 40, sampleCapacity: 3 });
  h.diagnostics.noteInput();
  for (let i = 0; i < 10; i++) { h.advance(16); h.diagnostics.noteInput(); }
  assert.equal(h.scheduled.size, 1);
  assert.equal(h.diagnostics.snapshot().retainedIntervalSamples, 3);
  h.advance(50);
  assert.equal(h.scheduled.size, 0);
});

test('frame timing never includes idle gaps between input bursts', () => {
  const h = harness({ observationTailMs: 20 });
  h.diagnostics.noteInput(); h.advance(10); h.advance(15);
  h.setTime(10000); h.diagnostics.noteInput(); h.advance(10); h.advance(15);
  assert.equal(h.diagnostics.snapshot().maxCallbackIntervalMs, 15);
  assert.equal(h.diagnostics.snapshot().bursts, 2);
});

test('only long tasks intersecting observed input windows are counted', () => {
  const h = harness({ observationTailMs: 40 });
  h.diagnostics.recordLongTask(0, 100);
  assert.equal(h.diagnostics.snapshot().longTasks, 0);
  h.setTime(200); h.diagnostics.noteInput(); h.advance(50);
  h.diagnostics.recordLongTask(190, 60);
  h.diagnostics.recordLongTask(400, 80);
  assert.equal(h.diagnostics.snapshot().longTasks, 1);
  assert.equal(h.diagnostics.snapshot().longTaskMs, 60);
});

test('disposal cancels outstanding callback and later input cannot reschedule', () => {
  const h = harness(); h.diagnostics.noteInput();
  h.diagnostics.dispose(); h.diagnostics.noteInput();
  assert.equal(h.scheduled.size, 0);
  assert.equal(h.diagnostics.snapshot().active, false);
});
