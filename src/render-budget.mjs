// Pure policies and opt-in diagnostics. No renderer replacement, document scans,
// scroll interception, persistent RAF loop, or scroll-end rendering delay.

/** RGBA surface estimate, not an assertion about total browser/GPU memory. */
export function canvasSurfaceBytes(canvas) {
  const { width, height } = canvas || {};
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0) return 0;
  const result = width * height * 4;
  return Number.isSafeInteger(result) ? result : Number.MAX_SAFE_INTEGER;
}

/**
 * Call on render completion or manual inspection, not on every scroll/frame.
 * Includes PDF.js detail/temporary canvases attached to each cached page.
 * Detached work surfaces, decoded images, fonts and compositor copies are not
 * represented; process memory must be measured separately.
 */
export function snapshotCanvasSurfaces(pageViews) {
  const seen = new Set();
  const pages = [];
  for (const view of pageViews || []) {
    let bytes = 0, canvases = 0;
    const candidates = new Set([view.canvas, ...(view.div?.querySelectorAll('canvas') || [])]);
    for (const canvas of candidates) {
      if (!canvas || seen.has(canvas)) continue;
      seen.add(canvas);
      bytes += canvasSurfaceBytes(canvas);
      canvases++;
    }
    pages.push({ id: view.id, bytes, canvases });
  }
  return { pages, bytes: pages.reduce((sum, page) => sum + page.bytes, 0), canvases: seen.size };
}

/**
 * Plan eviction of off-screen surfaces in least-recently-used order. Visible
 * pages and selection/feedback-pinned pages must be passed in protectedPageIds.
 * This is a soft surface target: protected content is never destroyed to force
 * the number below the target. The caller owns safe PDF.js reset/destroy calls.
 */
export function planCanvasEvictions({ pages, protectedPageIds = [], maxBytes }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a nonnegative safe integer.');
  const protectedIds = new Set(protectedPageIds), ids = new Set();
  const ordered = pages.map((page, index) => {
    if (ids.has(page.id)) throw new TypeError('Page identifiers must be unique.');
    if (!Number.isSafeInteger(page.bytes) || page.bytes < 0) throw new TypeError('Page byte estimates must be nonnegative safe integers.');
    ids.add(page.id);
    return { ...page, order: Number.isFinite(page.lastUsed) ? page.lastUsed : index };
  });
  let retainedBytes = ordered.reduce((sum, page) => sum + page.bytes, 0);
  const evictPageIds = [];
  for (const page of ordered.filter(page => !protectedIds.has(page.id)).sort((a, b) => a.order - b.order)) {
    if (retainedBytes <= maxBytes) break;
    if (!page.bytes) continue;
    evictPageIds.push(page.id);
    retainedBytes -= page.bytes;
  }
  return { evictPageIds, retainedBytes, targetBytes: maxBytes, exceedsTarget: retainedBytes > maxBytes };
}

/**
 * Bounded, active-input-only frame-callback diagnostics. noteInput() starts the
 * sampler; absent new input it stops after a short observation tail. It never
 * schedules or delays rendering. Frame callback intervals are NOT measured
 * presentation FPS, input-to-pixel latency, or proof of smooth scrolling.
 */
export function createMotionDiagnostics({
  now = () => performance.now(),
  requestFrame = callback => requestAnimationFrame(callback),
  cancelFrame = id => cancelAnimationFrame(id),
  observationTailMs = 150,
  sampleCapacity = 2048,
} = {}) {
  if (!(Number.isFinite(observationTailMs) && observationTailMs >= 0)) throw new TypeError('Invalid observation tail.');
  if (!Number.isSafeInteger(sampleCapacity) || sampleCapacity < 1) throw new TypeError('Invalid sample capacity.');
  const samples = new Float64Array(sampleCapacity);
  let writeIndex = 0, sampleCount = 0, frameId = null, previousFrame = null;
  let lastInput = -Infinity, startedAt = null, disposed = false;
  let inputEvents = 0, bursts = 0, intervalCount = 0, intervalTotalMs = 0, maxIntervalMs = 0;
  let longTasks = 0, longTaskMs = 0, firstInputAt = null;
  const windows = [];
  function tick(timestamp) {
    frameId = null;
    if (disposed) return;
    if (previousFrame !== null) {
      const delta = timestamp - previousFrame;
      if (Number.isFinite(delta) && delta >= 0) {
        samples[writeIndex] = delta; writeIndex = (writeIndex + 1) % sampleCapacity;
        sampleCount = Math.min(sampleCount + 1, sampleCapacity);
        intervalCount++; intervalTotalMs += delta; maxIntervalMs = Math.max(maxIntervalMs, delta);
      }
    }
    if (timestamp >= lastInput + observationTailMs) {
      previousFrame = null; startedAt = null; return;
    }
    previousFrame = timestamp;
    frameId = requestFrame(tick);
  }
  function noteInput() {
    if (disposed) return;
    lastInput = now(); inputEvents++;
    firstInputAt ??= lastInput;
    if (startedAt === null) {
      startedAt = lastInput; bursts++; previousFrame = null;
      windows.push({ start: lastInput, end: lastInput + observationTailMs });
      if (windows.length > 16) windows.shift();
    } else windows.at(-1).end = lastInput + observationTailMs;
    if (frameId === null) frameId = requestFrame(tick);
  }
  function recordLongTask(startTime, duration) {
    if (disposed || !Number.isFinite(startTime) || !Number.isFinite(duration) || duration <= 0) return;
    if (windows.some(window => startTime < window.end && startTime + duration > window.start)) {
      longTasks++; longTaskMs += duration;
    }
  }
  function snapshot() {
    const sorted = Array.from(samples.subarray(0, sampleCount)).sort((a, b) => a - b);
    const quantile = fraction => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : null;
    return {
      inputEvents, bursts, active: frameId !== null, firstInputAt,
      frameCallbackIntervals: intervalCount,
      meanCallbackIntervalMs: intervalCount ? intervalTotalMs / intervalCount : null,
      p50RecentCallbackIntervalMs: quantile(0.5), p95RecentCallbackIntervalMs: quantile(0.95),
      maxCallbackIntervalMs: intervalCount ? maxIntervalMs : null,
      retainedIntervalSamples: sampleCount, longTasks, longTaskMs,
      interpretation: 'Active-input callback scheduling only; not pixel-presentation or end-to-end latency.',
    };
  }
  function dispose() {
    disposed = true;
    if (frameId !== null) cancelFrame(frameId);
    frameId = null; previousFrame = null; startedAt = null;
  }
  return { noteInput, recordLongTask, snapshot, dispose };
}
