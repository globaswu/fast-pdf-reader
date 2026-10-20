import {FEEDBACK_LIMITS, sourceFingerprint, validPdfBox} from './feedback-data.mjs';

/** Project unrotated PDF coordinates into percentages of the current page content. */
export function projectRequestBox(pdfRect, viewport) {
  const width = viewport?.width, height = viewport?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      !Array.isArray(pdfRect) || pdfRect.length !== 4 || !pdfRect.every(Number.isFinite)) return null;
  let rect;
  try {
    if (typeof viewport.convertToViewportRectangle === 'function') {
      rect = viewport.convertToViewportRectangle(pdfRect);
    } else if (typeof viewport.convertToViewportPoint === 'function') {
      // PDF.js 6 uses point conversion in place of the former rectangle helper.
      rect = [...viewport.convertToViewportPoint(pdfRect[0], pdfRect[1]),
        ...viewport.convertToViewportPoint(pdfRect[2], pdfRect[3])];
    }
  } catch { return null; }
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite)) return null;
  const left = Math.max(0, Math.min(rect[0], rect[2]));
  const top = Math.max(0, Math.min(rect[1], rect[3]));
  const right = Math.min(width, Math.max(rect[0], rect[2]));
  const bottom = Math.min(height, Math.max(rect[1], rect[3]));
  if (right <= left || bottom <= top) return null;
  return {left: left / width * 100, top: top / height * 100,
    width: (right - left) / width * 100, height: (bottom - top) / height * 100};
}

function fingerprint(info) {
  try { return sourceFingerprint(info); } catch { return null; }
}

/** A bounded, passive overlay. The feedback owner retains the authoritative queue. */
export function createRequestHighlights({pdfViewer, eventBus, getDocumentInfo}) {
  const dom = pdfViewer.container.ownerDocument, win = dom.defaultView;
  const layers = new Map(), requestPages = new Map(), listeners = [];
  let requests = [], currentSource = null, frame = null, disposed = false, refreshes = 0;

  function removeLayer(page) {
    layers.get(page)?.element.remove();
    layers.delete(page);
  }

  function updateSource() {
    let next;
    try { next = fingerprint(getDocumentInfo()); } catch { next = null; }
    if (next !== currentSource) {
      for (const page of layers.keys()) removeLayer(page);
      currentSource = next;
    }
  }

  function desiredPages() {
    const pages = new Map();
    if (!currentSource) return pages;
    for (const request of requests) {
      if (request.fingerprint !== currentSource) continue;
      for (const box of request.boxes) {
        if (!pages.has(box.page)) pages.set(box.page, []);
        pages.get(box.page).push({request, pdfRect: box.pdfRect});
      }
    }
    return pages;
  }

  function sync() {
    if (disposed) return;
    updateSource();
    refreshes++;
    const pages = desiredPages();
    for (const page of layers.keys()) if (!pages.has(page)) removeLayer(page);
    for (const [page, boxes] of pages) {
      const view = pdfViewer.getPageView(page - 1);
      // Placeholder views borrow page 1's viewport until their own PDFPage loads.
      if (!view?.pdfPage || !view.div?.isConnected || !view.viewport) {
        removeLayer(page);
        continue;
      }
      const projected = boxes.map(box => ({...box, rect: projectRequestBox(box.pdfRect, view.viewport)}))
        .filter(box => box.rect);
      if (!projected.length) { removeLayer(page); continue; }
      const signature = JSON.stringify(projected.map(({request, rect}) => [request.queueIndex, request.kind, request.preview,
        rect.left, rect.top, rect.width, rect.height]));
      let record = layers.get(page);
      if (record?.view !== view) { removeLayer(page); record = null; }
      if (!record) {
        const element = dom.createElement('div');
        element.className = 'pdf-request-highlights';
        element.setAttribute('aria-hidden', 'true');
        // The page's padding box is its canvas content box (PDF.js uses no padding).
        // Percentages follow CSS scaling and rounding without measuring on scroll.
        Object.assign(element.style, {position: 'absolute', inset: '0', pointerEvents: 'none'});
        record = {view, element, signature: null, boxes: 0, markers: 0};
        layers.set(page, record);
      }
      if (record.signature === signature) {
        if (record.element.parentNode !== view.div) view.div.append(record.element);
        continue;
      }
      const children = [], marked = new Set();
      for (const {request, rect} of projected) {
        const element = dom.createElement('div');
        element.className = 'pdf-request-highlight' + (request.kind === 'region' ? ' is-region' : '') +
          (request.preview ? ' is-draft' : '');
        Object.assign(element.style, {left: `${rect.left}%`, top: `${rect.top}%`,
          width: `${rect.width}%`, height: `${rect.height}%`});
        children.push(element);
        if (!marked.has(request.queueIndex)) {
          marked.add(request.queueIndex);
          const marker = dom.createElement('span');
          marker.className = 'pdf-request-marker' + (request.preview ? ' is-draft' : '');
          marker.textContent = request.preview ? '' : String(request.queueIndex + 1);
          Object.assign(marker.style, {left: `${request.preview ? rect.left + rect.width : rect.left}%`,
            top: `${rect.top}%`, transform: request.preview ? 'translate(-25%, -70%)' : 'translate(-25%, -50%)'});
          children.push(marker);
        }
      }
      record.element.replaceChildren(...children);
      record.signature = signature; record.boxes = projected.length; record.markers = marked.size;
      // PDFPageView.reset removes unowned children. Restore only our own layer.
      if (record.element.parentNode !== view.div) view.div.append(record.element);
    }
  }

  function refresh() {
    if (disposed) return;
    updateSource();
    if (frame || (!requests.length && !layers.size)) return;
    const pending = {};
    frame = pending;
    pending.id = win.requestAnimationFrame(() => {
      if (disposed || frame !== pending) return;
      frame = null;
      sync();
    });
  }

  function setRequests(queue) {
    if (disposed) return;
    requests = [];
    requestPages.clear();
    const ids = new Set();
    let savedIndex = 0, previewSeen = false;
    // An ephemeral draft does not consume a saved request slot or its numbering.
    // Only one extra entry is inspected, keeping untrusted input work bounded.
    if (Array.isArray(queue)) for (const request of queue.slice(0, FEEDBACK_LIMITS.requests + 1)) {
      const preview = request?.preview === true;
      let queueIndex;
      if (preview) {
        if (previewSeen) continue;
        previewSeen = true;
        queueIndex = FEEDBACK_LIMITS.requests;
      } else {
        queueIndex = savedIndex++;
        if (queueIndex >= FEEDBACK_LIMITS.requests) continue;
      }
      const selection = request?.selection, source = fingerprint(request?.source);
      if (typeof request?.id !== 'string' || !request.id || ids.has(request.id) || !source ||
          !['text', 'region'].includes(selection?.kind) || !Array.isArray(selection.boxes) ||
          !selection.boxes.length || selection.boxes.length > FEEDBACK_LIMITS.boxes ||
          !selection.boxes.every(validPdfBox)) continue;
      ids.add(request.id);
      requests.push({queueIndex, preview, fingerprint: source, kind: selection.kind,
        boxes: selection.boxes.map(box => ({page: box.page, pdfRect: [...box.pdfRect]}))});
      if (!requestPages.has(source)) requestPages.set(source, new Set());
      for (const box of selection.boxes) requestPages.get(source).add(box.page);
    }
    // Clearing is immediate, including when a previously scheduled RAF is stale.
    if (!requests.length) for (const page of layers.keys()) removeLayer(page);
    refresh();
  }

  function listen(name, listener) {
    eventBus.on(name, listener);
    listeners.push(() => eventBus.off(name, listener));
  }
  for (const name of ['pagesinit', 'scalechanging', 'rotationchanging']) {
    listen(name, event => { if (event?.source === pdfViewer) refresh(); });
  }
  for (const name of ['pagerender', 'pagerendered']) {
    listen(name, event => {
      if (!Number.isInteger(event?.pageNumber) || event.pageNumber < 1 || !requests.length) return;
      const view = pdfViewer.getPageView(event.pageNumber - 1);
      if (!view || event.source !== view) return;
      updateSource();
      if (requestPages.get(currentSource)?.has(event.pageNumber)) refresh();
    });
  }

  return {
    setRequests,
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (frame) win.cancelAnimationFrame(frame.id);
      frame = null;
      for (const remove of listeners) remove();
      for (const page of layers.keys()) removeLayer(page);
      requests = []; requestPages.clear(); currentSource = null;
    },
    diagnostics() {
      return {requests: requests.length, matchingRequests: currentSource ? requests.filter(request => request.fingerprint === currentSource).length : 0,
        mountedPages: layers.size, boxes: [...layers.values()].reduce((sum, record) => sum + record.boxes, 0),
        markers: [...layers.values()].reduce((sum, record) => sum + record.markers, 0), scheduled: !!frame, refreshes, disposed};
    },
  };
}
