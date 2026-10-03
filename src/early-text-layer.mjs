// Selectable PDF text is independent of the graphics operator list. Keep the
// stock PDF.js TextLayer geometry and native viewer CSS, including rotations.
// This layer is transparent: it does not attempt to draw replacement glyphs.
export class EarlyTextLayerController {
  constructor({pdfViewer, eventBus, TextLayer, container = pdfViewer.container,
    normalizeUnicode = text => text, isSelectionPinned = () => false,
    radius = 2, maxCachePages = 24, maxCacheBytes = 8 * 1024 * 1024,
    concurrency = 2, copyPermission = 16, onProgress = () => {}}) {
    this.pdfViewer = pdfViewer; this.eventBus = eventBus; this.TextLayer = TextLayer;
    this.container = container; this.dom = container.ownerDocument;
    this.normalizeUnicode = normalizeUnicode; this.isSelectionPinned = isSelectionPinned;
    this.radius = Math.max(0, Math.min(4, Math.trunc(radius)));
    this.maxCachePages = Math.max(1, Math.trunc(maxCachePages));
    this.maxCacheBytes = Math.max(1, maxCacheBytes);
    this.concurrency = Math.max(1, Math.min(2, Math.trunc(concurrency)));
    this.copyPermission = copyPermission; this.onProgress = onProgress;
    this.cache = new Map(); this.layers = new Map(); this.pending = new Map();
    this.failed = new Set(); this.attempted = new Set(); this.listeners = []; this.generation = 0;
    this.document = null; this.permissionPromise = null; this.allowed = false; this.scheduled = false; this.disposed = false;
    this.metrics = {extractedPages: 0, renderedLayers: 0, cacheHits: 0, failures: 0, lastTextMs: null};
    const listen = (name, callback) => {
      eventBus.on(name, callback); this.listeners.push(() => eventBus.off(name, callback));
    };
    for (const name of ['pagesinit', 'pagechanging', 'updateviewarea', 'scalechanging', 'rotationchanging']) {
      listen(name, () => this.schedule());
    }
    listen('pagerender', event => {
      const view = this.pdfViewer.getPageView(event.pageNumber - 1);
      if (event.source === view) { this.attempted.delete(event.pageNumber); this.schedule(); }
    });
    listen('textlayerrendered', event => this.onNativeLayer(event));
    this.onSelection = () => this.schedule();
    this.onPointerUp = () => {
      for (const record of this.layers.values()) record.dragging = false;
      this.schedule();
    };
    this.dom.addEventListener('selectionchange', this.onSelection);
    this.dom.addEventListener('pointerup', this.onPointerUp);
    this.dom.addEventListener('pointercancel', this.onPointerUp);
  }

  async setDocument(document) {
    this.stop();
    if (!document || this.disposed) return;
    this.document = document;
    this.permissionPromise = Promise.resolve().then(() => document.getPermissions());
    const generation = this.generation;
    try {
      // Match the viewer's copy-permission gate before exposing another layer.
      const permissions = await this.permissionPromise;
      if (generation !== this.generation) return;
      this.allowed = permissions === null || permissions.includes(this.copyPermission);
      this.schedule();
    } catch (error) {
      if (generation === this.generation) this.reportFailure(error);
    }
  }

  async useExtractionDocument(document) {
    const previous = this.document, generation = this.generation;
    if (!document || !previous || this.disposed) return false;
    if (!Number.isSafeInteger(document.numPages) || document.numPages !== previous.numPages) {
      throw new Error('The text extraction document has a different page count.');
    }
    const previousFingerprint = previous.fingerprints?.[0], fingerprint = document.fingerprints?.[0];
    if (previousFingerprint && fingerprint && previousFingerprint !== fingerprint) {
      throw new Error('The text extraction document has a different fingerprint.');
    }
    // Reuse the original permission check so a busy graphics worker cannot
    // delay the independent text source with another identical request.
    const permissionPromise = document === previous ? this.permissionPromise :
      Promise.resolve().then(() => document.getPermissions());
    let permissions;
    try {
      permissions = await Promise.all([this.permissionPromise, permissionPromise]);
    } catch (error) {
      if (generation !== this.generation || this.document !== previous || this.disposed) return false;
      throw error;
    }
    if (generation !== this.generation || this.document !== previous || this.disposed) return false;
    if (permissions.some(value => value !== null && !value.includes(this.copyPermission))) {
      throw new Error('The text extraction document does not permit copying.');
    }
    if (document === previous) return true;
    // The caller supplies the same exact PDF bytes. Fingerprint/page checks
    // detect accidental document changes; a fingerprint is not a byte hash.
    // PDFPageProxy.getTextContent has no cancellation API. Epoch checks discard
    // its late results while the original document remains available to render.
    this.generation++;
    for (const [number, record] of this.layers) if (!record.ready) this.removeLayer(number);
    this.document = document; this.permissionPromise = permissionPromise; this.allowed = true; this.scheduled = false;
    this.pending.clear(); this.failed.clear(); this.attempted.clear();
    this.metrics.extractionSourceSwitches = (this.metrics.extractionSourceSwitches || 0) + 1;
    this.schedule(); this.onProgress(this.snapshot());
    return true;
  }

  schedule() {
    if (this.scheduled || !this.document || !this.allowed || this.disposed) return;
    this.scheduled = true;
    const generation = this.generation;
    queueMicrotask(() => {
      if (generation !== this.generation) return;
      this.scheduled = false;
      this.sync();
    });
  }

  desiredPages() {
    const count = this.document?.numPages || 0;
    const focus = Math.min(count, Math.max(1, this.pdfViewer.currentPageNumber || 1));
    const pages = count ? [focus] : [];
    for (let offset = 1; offset <= this.radius; offset++) {
      if (focus + offset <= count) pages.push(focus + offset);
      if (focus - offset >= 1) pages.push(focus - offset);
    }
    return pages;
  }

  hasSelection(record) {
    if (record.dragging) return true;
    const selection = this.dom.getSelection();
    if (!selection || selection.isCollapsed) return false;
    for (let index = 0; index < selection.rangeCount; index++) {
      try { if (selection.getRangeAt(index).intersectsNode(record.div)) return true; }
      catch { /* A native page reset may already have detached this range. */ }
    }
    return false;
  }

  protected(record) {
    if (this.hasSelection(record)) return true;
    // The feedback owner may hold a cloned Range even before the first native
    // handoff. Its callback must test this particular layer, not a global flag.
    if (!this.isSelectionPinned(record.div)) return false;
    const selection = this.dom.getSelection();
    // A newly selected passage elsewhere in the PDF supersedes the previous
    // held range. A feedback dialog may instead have a collapsed/outside range.
    if (selection && !selection.isCollapsed) {
      for (let index = 0; index < selection.rangeCount; index++) {
        try { if (selection.getRangeAt(index).intersectsNode(this.container)) return false; }
        catch { /* The page may have been removed by the native viewer. */ }
      }
    }
    return true;
  }

  nativeLayer(view) {
    const div = view?.textLayer?.div;
    return div?.parentNode === view.div && !div.hidden ? div : null;
  }

  sync() {
    if (!this.document || !this.allowed || this.disposed) return;
    const desired = this.desiredPages(), wanted = new Set(desired);
    for (const number of this.attempted) if (!wanted.has(number)) this.attempted.delete(number);
    for (const [number, record] of this.layers) {
      const view = this.pdfViewer.getPageView(number - 1);
      if (view !== record.view) { this.removeLayer(number); continue; }
      if (record.handoff && !this.protected(record)) { this.removeLayer(number); continue; }
      if (!wanted.has(number) && !this.protected(record)) { this.removeLayer(number); continue; }
      record.div.classList.toggle('selecting', this.hasSelection(record));
      if (view.pdfPage && record.ready) {
        // PDFPageView.reset removes unowned DOM children. Restore a cached
        // layer after that reset, using the current native page viewport.
        record.layer.update({viewport: view.viewport});
        if (record.div.parentNode !== view.div && !this.nativeLayer(view)) view.div.append(record.div);
      }
    }
    for (const number of desired) {
      const view = this.pdfViewer.getPageView(number - 1);
      if (!view || this.nativeLayer(view) || this.layers.has(number) || this.failed.has(number)) continue;
      const cached = this.cache.get(number);
      if (cached) {
        this.cache.delete(number); this.cache.set(number, cached);
        if (view.pdfPage) { this.metrics.cacheHits++; void this.mount(number, cached.content); }
      } else if (!this.pending.has(number) && !this.attempted.has(number) && this.pending.size < this.concurrency) {
        this.extract(number);
      }
    }
  }

  extract(number) {
    const document = this.document, generation = this.generation;
    this.attempted.add(number);
    const token = {}; this.pending.set(number, token);
    void (async () => {
      const page = await document.getPage(number);
      if (generation !== this.generation) return;
      const started = performance.now();
      const content = await page.getTextContent({includeMarkedContent: true, disableNormalization: true});
      if (generation !== this.generation) return;
      this.metrics.lastTextMs = performance.now() - started;
      this.metrics.extractedPages++;
      this.cacheContent(number, content);
      if (this.desiredPages().includes(number)) await this.mount(number, content);
    })().catch(error => {
      if (generation === this.generation) { this.failed.add(number); this.reportFailure(error); }
    }).finally(() => {
      if (this.pending.get(number) !== token) return;
      this.pending.delete(number); this.schedule(); this.onProgress(this.snapshot());
    });
  }

  cacheContent(number, content) {
    // UTF-16 serialized size is an accounting estimate, not a heap-size claim.
    const bytes = JSON.stringify(content).length * 2;
    this.cache.delete(number);
    if (bytes > this.maxCacheBytes) return;
    this.cache.set(number, {content, bytes});
    let total = [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0);
    while (this.cache.size > this.maxCachePages || total > this.maxCacheBytes) {
      const oldest = this.cache.keys().next().value;
      total -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
    }
  }

  async mount(number, content) {
    const view = this.pdfViewer.getPageView(number - 1);
    // Placeholder views borrow page 1's dimensions until their own PDFPage
    // arrives. Never position another page's selectable text against that box.
    if (!view?.pdfPage || view.pdfPage.isPureXfa || this.nativeLayer(view) || this.layers.has(number)) return;
    const generation = this.generation;
    const div = this.dom.createElement('div');
    div.className = 'textLayer'; div.dataset.earlyTextLayer = 'true';
    div.setAttribute('oai-annotation-container-text', ''); div.tabIndex = 0; div.hidden = true;
    view.div.dataset.sourcePage = String(number);
    const layer = new this.TextLayer({textContentSource: content, container: div, viewport: view.viewport});
    const record = {view, div, layer, ready: false, dragging: false, selectionHeld: false, handoff: null};
    this.layers.set(number, record); view.div.append(div);
    div.addEventListener('pointerdown', () => { record.dragging = true; div.classList.add('selecting'); });
    div.addEventListener('copy', event => {
      if (!event.clipboardData) return;
      const text = this.dom.getSelection()?.toString() || '';
      event.clipboardData.setData('text/plain', this.normalizeUnicode(text).replaceAll('\0', ''));
      event.preventDefault(); event.stopPropagation();
    });
    try {
      await layer.render();
      if (generation !== this.generation || this.layers.get(number) !== record) return;
      if (this.nativeLayer(view)) { this.removeLayer(number); return; }
      layer.update({viewport: view.viewport});
      const end = this.dom.createElement('div'); end.className = 'endOfContent'; div.append(end);
      record.ready = true; div.hidden = false;
      this.metrics.renderedLayers++;
      view.div.dataset.earlyTextReady = 'true';
      if (this.desiredPages().includes(number) && div.parentNode !== view.div) view.div.append(div);
      this.onProgress(this.snapshot());
    } catch (error) {
      if (generation !== this.generation || this.layers.get(number) !== record) return;
      this.removeLayer(number); this.failed.add(number); this.reportFailure(error);
    }
  }

  onNativeLayer({pageNumber, source, error}) {
    const view = this.pdfViewer.getPageView(pageNumber - 1);
    if (error || source !== view) return;
    const record = this.layers.get(pageNumber), native = this.nativeLayer(view);
    native?.setAttribute('oai-annotation-container-text', '');
    if (!record || !native) return;
    if (record.ready && this.protected(record)) {
      record.selectionHeld = true;
      // Hiding duplicate text still duplicates Range.toString across pages.
      // Temporarily detach it so existing DOM ranges and copied text survive.
      record.handoff = native; native.remove();
    } else this.removeLayer(pageNumber);
  }

  removeLayer(number, restoreNative = true) {
    const record = this.layers.get(number);
    if (!record) return;
    this.layers.delete(number);
    if (!record.ready) record.layer.cancel();
    const {view, handoff, div} = record;
    if (restoreNative && handoff && view.textLayer?.div === handoff && !handoff.parentNode) {
      view.div.insertBefore(handoff, div.parentNode === view.div ? div : null);
    }
    div.remove(); delete view.div.dataset.earlyTextReady;
  }

  reportFailure(error) {
    this.metrics.failures++; this.metrics.lastError = error?.message || String(error);
    this.onProgress(this.snapshot());
  }

  snapshot() {
    return {...this.metrics, allowed: this.allowed, cachedPages: this.cache.size,
      cachedBytes: [...this.cache.values()].reduce((sum, item) => sum + item.bytes, 0),
      mountedPages: this.layers.size, readyPages: [...this.layers.values()].filter(item => item.ready).length,
      pendingPages: this.pending.size, heldSelections: [...this.layers.values()].filter(item => item.handoff).length};
  }

  stop() {
    this.generation++; this.document = null; this.permissionPromise = null; this.allowed = false; this.scheduled = false;
    for (const number of this.layers.keys()) this.removeLayer(number);
    this.pending.clear(); this.cache.clear(); this.failed.clear(); this.attempted.clear();
  }

  dispose() {
    this.stop(); this.disposed = true;
    for (const remove of this.listeners) remove(); this.listeners.length = 0;
    this.dom.removeEventListener('selectionchange', this.onSelection);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
  }
}
