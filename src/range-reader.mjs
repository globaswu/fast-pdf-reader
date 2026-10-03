// PDF byte delivery independent of PDF.js and the host bridge. A requested
// reader always receives exactly its requested interval; larger aligned bridge
// reads are shared by concurrent consumers and retained in a bounded LRU cache.
// This never writes a PDF or caches it persistently.
export class BlockRangeReader {
  constructor({ size, readChunk, blockSize = 1024 * 1024,
    maxCacheBytes = 16 * 1024 * 1024, concurrency = 3, readAheadBlocks = 0 } = {}) {
    if (!Number.isSafeInteger(size) || size <= 0 || typeof readChunk !== 'function' ||
        !Number.isSafeInteger(blockSize) || blockSize <= 0 ||
        !Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < blockSize ||
        !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 ||
        !Number.isInteger(readAheadBlocks) || readAheadBlocks < 0 || readAheadBlocks > 2) {
      throw new TypeError('Invalid local PDF range-reader configuration.');
    }
    Object.assign(this, { size, readChunk, blockSize, maxCacheBytes, concurrency, readAheadBlocks });
    this.cache = new Map(); this.jobs = new Map(); this.queue = [];
    this.cachedBytes = 0; this.active = 0; this.activeReadAhead = 0;
    this.aborted = false; this.sequence = 0; this.pumpQueued = false;
    this.controller = new AbortController();
    this.metrics = { bridgeRequests: 0, bytesRead: 0, cacheHits: 0,
      joinedReads: 0, demandReads: 0, readAheadReads: 0, evictions: 0,
      peakActiveReads: 0, discardedReadAhead: 0, errors: 0 };
  }

  #abortError() { const error = new Error('Local PDF byte reader was closed.'); error.name = 'AbortError'; return error; }
  #validate(begin, end) {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 ||
        end <= begin || end > this.size) throw new RangeError('Invalid local PDF byte range.');
  }

  async read(begin, end, { priority = 0, readAhead = true } = {}) {
    this.#validate(begin, end);
    if (this.aborted) throw this.#abortError();
    if (!Number.isFinite(priority)) throw new TypeError('Invalid local PDF read priority.');
    // A current demand supersedes queued speculative work, but never removes
    // another demanded PDF.js reader. Already-active host requests may finish;
    // abort() ensures their results cannot cross document generations.
    this.#dropQueuedReadAhead();
    const first = Math.floor(begin / this.blockSize) * this.blockSize;
    const starts = [];
    for (let start = first; start < end; start += this.blockSize) starts.push(start);
    const chunks = await Promise.all(starts.map(start => this.#block(start, true, priority)));
    if (this.aborted) throw this.#abortError();
    const result = new Uint8Array(end - begin);
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index];
      const from = Math.max(begin, start), to = Math.min(end, start + chunks[index].byteLength);
      result.set(chunks[index].subarray(from - start, to - start), from - begin);
    }
    if (readAhead) {
      for (let count = 1; count <= this.readAheadBlocks; count++) {
        const start = starts.at(-1) + count * this.blockSize;
        if (start < this.size) this.#block(start, false, -Infinity).catch(() => {});
      }
    }
    return result;
  }

  #dropQueuedReadAhead() {
    const retained = [];
    for (const job of this.queue) {
      if (job.demand) retained.push(job);
      else {
        this.jobs.delete(job.begin); this.metrics.discardedReadAhead++;
        job.reject(this.#abortError());
      }
    }
    this.queue = retained;
  }

  #block(begin, demand, priority) {
    const cached = this.cache.get(begin);
    if (cached) {
      this.cache.delete(begin); this.cache.set(begin, cached);
      this.metrics.cacheHits++;
      return Promise.resolve(cached);
    }
    const existing = this.jobs.get(begin);
    if (existing) {
      this.metrics.joinedReads++;
      existing.demand ||= demand; existing.priority = Math.max(existing.priority, priority);
      this.#schedulePump();
      return existing.promise;
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    // Speculative reads have no caller awaiting them. Mark every job as handled
    // immediately; demanded callers still receive the original rejecting promise.
    promise.catch(() => {});
    const job = { begin, end: Math.min(this.size, begin + this.blockSize), demand,
      priority, sequence: this.sequence++, promise, resolve, reject };
    this.jobs.set(begin, job); this.queue.push(job); this.#schedulePump();
    return promise;
  }

  #schedulePump() {
    if (this.aborted || this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => { this.pumpQueued = false; this.#pump(); });
  }

  #pump() {
    while (!this.aborted && this.active < this.concurrency && this.queue.length) {
      this.queue.sort((a, b) => Number(b.demand) - Number(a.demand) ||
        b.priority - a.priority || a.sequence - b.sequence);
      const next = this.queue[0];
      // Reserve all but one slot for real PDF.js demand; prefetch never fills
      // the bridge with a speculative backlog that delays a sudden page jump.
      if (!next.demand && this.activeReadAhead >= 1) return;
      this.queue.shift(); this.active++;
      const speculativeAtStart = !next.demand;
      if (speculativeAtStart) this.activeReadAhead++;
      this.metrics.bridgeRequests++;
      this.metrics[speculativeAtStart ? 'readAheadReads' : 'demandReads']++;
      this.metrics.peakActiveReads = Math.max(this.metrics.peakActiveReads, this.active);
      Promise.resolve().then(() => this.readChunk(next.begin, next.end, this.controller.signal))
        .then(data => {
          if (this.aborted) return;
          if (!(data instanceof Uint8Array) || data.byteLength !== next.end - next.begin) {
            throw new Error('Local PDF bridge returned an invalid byte range.');
          }
          this.metrics.bytesRead += data.byteLength;
          this.cache.set(next.begin, data); this.cachedBytes += data.byteLength;
          while (this.cachedBytes > this.maxCacheBytes) {
            const oldest = this.cache.keys().next().value;
            this.cachedBytes -= this.cache.get(oldest).byteLength;
            this.cache.delete(oldest); this.metrics.evictions++;
          }
          if (this.jobs.get(next.begin) === next) this.jobs.delete(next.begin);
          next.resolve(data);
        })
        .catch(error => {
          if (this.jobs.get(next.begin) === next) this.jobs.delete(next.begin);
          if (!this.aborted) { this.metrics.errors++; next.reject(error); }
        })
        .finally(() => {
          if (this.jobs.get(next.begin) === next) this.jobs.delete(next.begin);
          this.active--;
          if (speculativeAtStart) this.activeReadAhead--;
          this.#schedulePump();
        });
    }
  }

  snapshot() {
    return { ...this.metrics, cachedBytes: this.cachedBytes, cachedBlocks: this.cache.size,
      queuedReads: this.queue.length, activeReads: this.active, activeReadAhead: this.activeReadAhead,
      maxCacheBytes: this.maxCacheBytes, blockSize: this.blockSize, aborted: this.aborted };
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true; this.controller.abort();
    for (const job of this.jobs.values()) job.reject(this.#abortError());
    this.queue.length = 0; this.jobs.clear(); this.cache.clear(); this.cachedBytes = 0;
  }
}
