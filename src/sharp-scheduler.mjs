// Pure policies for the single retained PDFium worker. The controller sends only
// next()'s active job; unstarted jobs are recomputed from the latest viewport.

const MIB = 1024 * 1024;
const validPage = (page, count) => Number.isInteger(page) && page >= 1 && page <= count;
const normalizedRotation = rotation => ((rotation % 360) + 360) % 360;
const jobKey = job => `${job.pageNumber}:${job.width}:${job.rotation}`;

/** Visible pages precede prefetch; equal-distance neighbors favor travel. */
export function sharpPriority(pageCount, focus, direction = 1, radius = 2, visiblePages = []) {
  if (!validPage(focus, pageCount)) return [];
  const travel = direction < 0 ? -1 : 1;
  const result = [], seen = new Set();
  const add = page => {
    if (validPage(page, pageCount) && !seen.has(page)) { seen.add(page); result.push(page); }
  };
  add(focus);
  [...visiblePages].filter(page => validPage(page, pageCount)).sort((a, b) =>
    Math.abs(a - focus) - Math.abs(b - focus) || travel * (b - a)).forEach(add);
  const extent = Math.max(0, Math.min(pageCount, Math.floor(radius) || 0));
  for (let distance = 1; distance <= extent; distance++) {
    add(focus + travel * distance);
    add(focus - travel * distance);
  }
  return result;
}

/** Pixel tiers avoid a new raster for every small zoom/resize change. */
export function sharpTargetWidth(cssWidth, devicePixelRatio = 1) {
  const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 600;
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(1600, Math.max(1200, Math.ceil(width * ratio / 200) * 200));
}

/** A zoom fallback stays readable until a wider result arrives. */
export function choosePageAppearance(preview, sharp, rotation = 0) {
  const matches = item => item && normalizedRotation(item.rotation ?? 0) === normalizedRotation(rotation);
  const low = matches(preview) ? preview : null;
  const high = matches(sharp) ? sharp : null;
  if (!high) return low;
  if (!low) return high;
  return high.width >= low.width ? high : low;
}

export class SharpScheduler {
  constructor({ pageCount = 0, prefetchRadius = 2, isReady = () => false } = {}) {
    this.prefetchRadius = prefetchRadius;
    this.isReady = isReady;
    this.sequence = 0;
    this.generation = 0;
    this.reset(pageCount);
  }

  reset(pageCount = 0) {
    if (!Number.isInteger(pageCount) || pageCount < 0) throw new TypeError('Invalid page count.');
    this.generation++;
    this.pageCount = pageCount;
    this.focus = 1;
    this.direction = 1;
    this.width = 1200;
    this.rotation = 0;
    this.visiblePages = [];
    this.active = null;
    this.failed = new Set();
    this.deferred = new Set();
  }

  setViewport({ focus = this.focus, direction, visiblePages = this.visiblePages,
    width = this.width, rotation = this.rotation } = {}) {
    if (!validPage(focus, this.pageCount)) return false;
    if (!Number.isFinite(width) || width < 64 || width > 1600) throw new TypeError('Invalid sharp raster width.');
    if (!Number.isInteger(rotation) || rotation % 90) throw new TypeError('Rotation must be a multiple of 90 degrees.');
    const nextDirection = direction !== undefined ? (direction < 0 ? -1 : 1) :
      focus !== this.focus ? (focus > this.focus ? 1 : -1) : this.direction;
    const nextVisible = [...new Set(visiblePages)].filter(page => validPage(page, this.pageCount));
    if (focus !== this.focus || nextDirection !== this.direction || Math.round(width) !== this.width ||
        normalizedRotation(rotation) !== this.rotation || nextVisible.join(',') !== this.visiblePages.join(',')) this.deferred.clear();
    this.direction = nextDirection;
    this.focus = focus;
    this.visiblePages = nextVisible;
    this.width = Math.round(width);
    this.rotation = normalizedRotation(rotation);
    return true;
  }

  pending() {
    return sharpPriority(this.pageCount, this.focus, this.direction, this.prefetchRadius, this.visiblePages)
      .map(pageNumber => ({ pageNumber, width: this.width, rotation: this.rotation }))
      .filter(job => !this.isReady(job.pageNumber, job.width, job.rotation) &&
        !this.failed.has(jobKey(job)) && !this.deferred.has(jobKey(job)) &&
        (!this.active || jobKey(job) !== jobKey(this.active)));
  }

  next() {
    if (this.active) return null;
    const job = this.pending()[0];
    if (!job) return null;
    this.active = { ...job, id: ++this.sequence, generation: this.generation };
    return this.active;
  }

  complete(job) {
    if (!job || !this.active || job.id !== this.active.id || job.generation !== this.generation) return false;
    // A neighbor may be accepted, then evicted to admit another neighbor.
    // Render each tier once per viewport so cache pressure cannot create an
    // idle re-render loop. Actual viewport changes clear this bounded set.
    this.deferred.add(jobKey(job));
    this.active = null;
    return true;
  }

  fail(job) {
    if (!this.complete(job)) return false;
    this.failed.add(jobKey(job));
    return true;
  }

  // Cache pressure is temporary: a later viewport may protect this page and
  // release other pages. Retry on a real viewport change, never in a hot loop.
  defer(job) {
    if (!this.complete(job)) return false;
    this.deferred.add(jobKey(job));
    return true;
  }

  snapshot() {
    return { active: this.active && { ...this.active }, queuedPages: this.pending().map(job => job.pageNumber),
      focus: this.focus, direction: this.direction, width: this.width, generation: this.generation };
  }
}

/**
 * One encoded sharp image per page, independent from the 128 MiB preview cache.
 * The 64 MiB target is soft only for explicitly protected visible/selected
 * pages. Decoded image, worker heap and GPU memory are outside this accounting.
 */
export class SharpCache {
  constructor({ maxBytes = 64 * MIB, onEvict = () => {} } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('Invalid sharp cache budget.');
    this.maxBytes = maxBytes;
    this.onEvict = onEvict;
    this.items = new Map();
    this.bytes = 0;
  }

  peek(pageNumber) { return this.items.get(pageNumber); }
  get(pageNumber) {
    const item = this.peek(pageNumber);
    if (item) { this.items.delete(pageNumber); this.items.set(pageNumber, item); }
    return item;
  }
  has(pageNumber, width = 0, rotation = 0) {
    const item = this.peek(pageNumber);
    // requestedWidth records the completed worker request when its pixel budget
    // caps an extreme-aspect page below that width. It prevents endless retries.
    return !!item && Math.max(item.width, item.requestedWidth ?? 0) >= width &&
      normalizedRotation(item.rotation ?? 0) === normalizedRotation(rotation);
  }

  // False leaves ownership of the unused candidate with the caller, which must
  // revoke its URL. It may mean an equal/better cached image already exists.
  set(pageNumber, item, protectedIds = new Set()) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || !Number.isSafeInteger(item?.bytes) || item.bytes < 0 ||
        !Number.isFinite(item.width) || item.width <= 0) throw new TypeError('Invalid sharp cache item.');
    const protectedPages = new Set(protectedIds);
    const old = this.peek(pageNumber);
    if (old && normalizedRotation(old.rotation ?? 0) === normalizedRotation(item.rotation ?? 0) && old.width >= item.width) {
      // Preserve the higher-quality URL while remembering a completed capped
      // request. The controller still owns/revokes the rejected candidate URL.
      old.requestedWidth = Math.max(old.requestedWidth ?? old.width, item.requestedWidth ?? item.width);
      return false;
    }
    if (item.bytes > this.maxBytes && !protectedPages.has(pageNumber)) return false;
    let nextBytes = this.bytes - (old?.bytes ?? 0) + item.bytes;
    const victims = [];
    for (const [id, candidate] of this.items) {
      if (nextBytes <= this.maxBytes) break;
      if (id === pageNumber || protectedPages.has(id)) continue;
      victims.push(id);
      nextBytes -= candidate.bytes;
    }
    // Do not evict existing content for a candidate that still cannot fit.
    if (nextBytes > this.maxBytes && !protectedPages.has(pageNumber)) return false;
    for (const id of victims) this.delete(id);
    this.delete(pageNumber);
    this.items.set(pageNumber, item);
    this.bytes += item.bytes;
    return true;
  }

  trim(protectedIds = new Set()) {
    const protectedPages = new Set(protectedIds);
    for (const id of [...this.items.keys()]) {
      if (this.bytes <= this.maxBytes) break;
      if (!protectedPages.has(id)) this.delete(id);
    }
  }

  delete(pageNumber) {
    const item = this.peek(pageNumber);
    if (!item) return false;
    this.items.delete(pageNumber);
    this.bytes -= item.bytes;
    this.onEvict(pageNumber, item);
    return true;
  }
  clear() { for (const id of [...this.items.keys()]) this.delete(id); }
  snapshot() {
    return { sharpPages: this.items.size, sharpEncodedBytes: this.bytes,
      maxSharpEncodedBytes: this.maxBytes, sharpExceedsTarget: this.bytes > this.maxBytes };
  }
}
