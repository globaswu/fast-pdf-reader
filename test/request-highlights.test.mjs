import test from 'node:test';
import assert from 'node:assert/strict';
import {FEEDBACK_LIMITS} from '../src/feedback-data.mjs';
import {createRequestHighlights, projectRequestBox} from '../src/request-highlights.mjs';

const source = {documentId: 'fixture-revision', sourcePath: 'fixture.pdf', size: 200, modifiedMs: 100};
const box = (page = 1, pdfRect = [10, 20, 40, 80]) => ({page, pdfRect});
const request = (id = 'first', boxes = [box()], options = {}) => ({id, source: {...source},
  selection: {kind: 'text', boxes}, comment: '<img src=x onerror=alert(1)>', ...options});
const viewport = () => ({width: 100, height: 200,
  convertToViewportPoint: (x, y) => [x, 200 - y]});

class Element {
  constructor(ownerDocument, tagName = 'div') {
    this.ownerDocument = ownerDocument; this.tagName = tagName;
    this.children = []; this.parentNode = null; this.attributes = {}; this.style = {};
    this.className = ''; this.textContent = '';
  }
  get isConnected() { return this.root === true || !!this.parentNode?.isConnected; }
  append(...children) {
    for (const child of children) { child.remove(); this.children.push(child); child.parentNode = this; }
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceChildren(...children) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { throw new Error('Highlights must not measure DOM geometry.'); }
}

function fixture(t, pageCount = 5) {
  const frames = new Map(), allFrames = new Map(), listeners = new Map(), lookups = [];
  let nextFrame = 0, info = {...source};
  const dom = {
    createElement: tagName => new Element(dom, tagName),
    defaultView: {
      requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); allFrames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
  };
  const container = new Element(dom); container.root = true;
  const makePage = id => {
    const div = new Element(dom), canvas = new Element(dom, 'canvas'); div.append(canvas); container.append(div);
    return {id, div, canvas, viewport: viewport(), pdfPage: {},
      draw() { throw new Error('Highlights must not draw a PDF page.'); },
      reset() { throw new Error('Highlights must not reset a PDF page.'); }};
  };
  const pages = Array.from({length: pageCount}, (_, index) => makePage(index + 1));
  const pdfViewer = {container, getPageView(index) { lookups.push(index); return pages[index]; }};
  const eventBus = {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name, event = {}) { for (const callback of listeners.get(name) || []) callback(event); },
  };
  const controller = createRequestHighlights({pdfViewer, eventBus, getDocumentInfo: () => info});
  t.after(() => controller.dispose());
  const flush = () => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback();
  };
  const layer = index => pages[index].div.children.find(child => child.className === 'pdf-request-highlights');
  return {controller, pages, pdfViewer, eventBus, frames, allFrames, listeners, lookups, makePage, flush, layer,
    setInfo(next) { info = next; }};
}

async function loadPageViewport() {
  // Public-domain synthetic one-page PDF. No user files or raster rendering.
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /CropBox [10 20 110 220] /Resources << >> >>'];
  let pdf = '%PDF-1.7\n'; const offsets = [0];
  for (const [index, content] of objects.entries()) {
    offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${content}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({data: new TextEncoder().encode(pdf), isEvalSupported: false});
  try {
    const document = await loading.promise, page = await document.getPage(1);
    return page.getViewport({scale: 1}).constructor;
  } finally { await loading.destroy(); }
}

function closeTo(actual, expected) {
  assert.ok(actual);
  for (const key of Object.keys(expected)) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-10,
    `${key}: expected ${expected[key]}, received ${actual[key]}`);
}

test('projects real PDF.js crop origins, all right-angle rotations, zoom and user units', async () => {
  const PageViewport = await loadPageViewport();
  const expected = [
    {left: 10, top: 60, width: 30, height: 30},
    {left: 10, top: 10, width: 30, height: 30},
    {left: 60, top: 10, width: 30, height: 30},
    {left: 60, top: 60, width: 30, height: 30},
  ];
  for (const scale of [0.5, 1, 2.75]) for (const userUnit of [1, 2]) {
    for (const [index, rotation] of [0, 90, 180, 270].entries()) {
      const view = new PageViewport({viewBox: [10, 20, 110, 220], userUnit, scale, rotation});
      closeTo(projectRequestBox([20, 40, 50, 100], view), expected[index]);
    }
  }
  const view = new PageViewport({viewBox: [10, 20, 110, 220], userUnit: 1, scale: 2, rotation: 0});
  closeTo(projectRequestBox([-10, 0, 40, 60], view), {left: 0, top: 80, width: 30, height: 20});
  closeTo(projectRequestBox([-10, 0, 150, 300], view), {left: 0, top: 0, width: 100, height: 100});
  assert.equal(projectRequestBox([120, 240, 150, 300], view), null);
});

test('supports the rectangle API and rejects unusable viewport geometry', () => {
  const view = {width: 100, height: 100, convertToViewportRectangle: () => [80, 90, 20, 10]};
  closeTo(projectRequestBox([0, 0, 1, 1], view), {left: 20, top: 10, width: 60, height: 80});
  for (const invalid of [null, {}, {...view, width: 0}, {...view, height: Infinity},
    {...view, convertToViewportRectangle: () => [0, 0, NaN, 10]},
    {...view, convertToViewportRectangle: () => { throw new Error('Unavailable'); }}]) {
    assert.equal(projectRequestBox([0, 0, 1, 1], invalid), null);
  }
  for (const rect of [null, [1, 2], [0, 0, Infinity, 2]]) assert.equal(projectRequestBox(rect, view), null);
  assert.equal(projectRequestBox([0, 0, 1, 1], {width: 100, height: 100}), null);
  assert.equal(projectRequestBox([0, 0, 0, 10], viewport()), null);
});

test('adds text and region boxes with one numeric marker per request/page, then removes and clears', t => {
  const f = fixture(t);
  const text = request('text', [box(), box(1, [45, 20, 65, 80]), box(2)]);
  const region = request('region', [box(1, [20, 90, 70, 150])],
    {selection: {kind: 'region', boxes: [box(1, [20, 90, 70, 150])]}});
  const originalCanvas = f.pages[0].canvas;
  f.controller.setRequests([text, region]); f.flush();
  assert.deepEqual(f.controller.diagnostics(), {requests: 2, matchingRequests: 2, mountedPages: 2,
    boxes: 4, markers: 3, scheduled: false, refreshes: 1, disposed: false});
  const layer = f.layer(0);
  assert.equal(layer.attributes['aria-hidden'], 'true');
  assert.equal(layer.style.pointerEvents, 'none');
  assert.equal(layer.style.position, 'absolute'); assert.equal(layer.style.inset, '0');
  const boxes = layer.children.filter(child => child.className.startsWith('pdf-request-highlight'));
  assert.equal(boxes[0].style.left, '10%'); assert.equal(boxes[0].style.top, '60%');
  assert.equal(boxes[0].style.width, '30%'); assert.equal(boxes[0].style.height, '30%');
  assert.equal(boxes[2].className, 'pdf-request-highlight is-region');
  assert.deepEqual(layer.children.filter(child => child.className === 'pdf-request-marker').map(child => child.textContent), ['1', '2']);
  assert.equal(f.layer(1).children[1].textContent, '1');
  assert.ok(layer.children.every(child => child.textContent === '' || /^[12]$/.test(child.textContent)));
  assert.equal(f.pages[0].div.children[0], originalCanvas);
  f.controller.setRequests([region]); f.flush();
  assert.equal(f.controller.diagnostics().boxes, 1); assert.equal(f.layer(1), undefined);
  assert.equal(f.layer(0).children[1].textContent, '1');
  f.controller.setRequests([]);
  assert.equal(f.layer(0), undefined); assert.equal(f.controller.diagnostics().mountedPages, 0);
});

test('matches all source identity fields and clears a changed revision before the next animation frame', t => {
  const f = fixture(t);
  const mismatches = [{documentId: 'other'}, {sourcePath: 'other.pdf'}, {size: 201}, {modifiedMs: 101}];
  f.controller.setRequests([...mismatches.map((change, i) => request(String(i), [box()], {source: {...source, ...change}})), request('matching')]);
  f.flush();
  assert.equal(f.controller.diagnostics().matchingRequests, 1);
  assert.equal(f.layer(0).children[1].textContent, '5');
  f.setInfo({...source, modifiedMs: 102}); f.controller.refresh();
  assert.equal(f.layer(0), undefined);
  f.flush(); assert.equal(f.controller.diagnostics().boxes, 0);
  f.controller.setRequests([request('new', [box()], {source: {...source, modifiedMs: 102}})]);
  f.flush(); assert.equal(f.controller.diagnostics().boxes, 1);
  f.setInfo(null); f.controller.refresh();
  assert.equal(f.layer(0), undefined); f.flush(); assert.equal(f.controller.diagnostics().matchingRequests, 0);
});

test('draft selection has an unnumbered top-right marker without changing saved request appearance', t => {
  const f = fixture(t);
  f.controller.setRequests([request('saved'), request('draft', [box(1, [45, 90, 70, 150]), box(1)], {preview: true})]);
  f.flush();
  const children = f.layer(0).children;
  assert.equal(children[0].className, 'pdf-request-highlight');
  assert.equal(children[1].className, 'pdf-request-marker');
  assert.equal(children[1].textContent, '1');
  assert.equal(children[1].style.left, '10%');
  assert.equal(children[1].style.transform, 'translate(-25%, -50%)');
  assert.equal(children[2].className, 'pdf-request-highlight is-draft');
  assert.equal(children[3].className, 'pdf-request-marker is-draft');
  assert.equal(children[3].textContent, '');
  assert.equal(children[3].style.left, '70%');
  assert.equal(children[3].style.top, '25%');
  assert.equal(children[3].style.transform, 'translate(-25%, -70%)');
  assert.equal(children[4].className, 'pdf-request-highlight is-draft');
  assert.equal(f.controller.diagnostics().markers, 2);
  f.controller.setRequests([request('draft', [box()], {preview: true}), request('saved'), request('saved-2')]);
  f.flush();
  assert.deepEqual(f.layer(0).children.filter(child => child.className === 'pdf-request-marker')
    .map(child => child.textContent), ['1', '2']);
});

test('draft replacements and removal refresh only the passive overlay', t => {
  const f = fixture(t);
  f.controller.setRequests([request('inline-draft', [box()], {preview: true})]); f.flush();
  const layer = f.layer(0), draftBox = layer.children[0];
  f.controller.setRequests([request('inline-draft', [box()])]); f.flush();
  assert.notEqual(layer.children[0], draftBox);
  assert.equal(layer.children[0].className, 'pdf-request-highlight');
  assert.equal(layer.children[1].className, 'pdf-request-marker');
  assert.equal(layer.children[1].textContent, '1');
  f.controller.setRequests([request('inline-draft', [box()], {preview: true})]); f.flush();
  assert.equal(layer.children[0].className, 'pdf-request-highlight is-draft');
  assert.equal(layer.children[1].textContent, '');
  f.controller.setRequests([request('inline-draft', [box(2)], {preview: true})]); f.flush();
  assert.equal(f.layer(0), undefined);
  assert.equal(f.layer(1).children[0].className, 'pdf-request-highlight is-draft');
  f.controller.setRequests([]);
  assert.equal(f.layer(1), undefined);
  assert.equal(f.controller.diagnostics().mountedPages, 0);
});

test('allows exactly one extra draft while retaining the twenty-saved-request bound and validation', t => {
  const f = fixture(t);
  const saved = Array.from({length: FEEDBACK_LIMITS.requests}, (_, i) => request(String(i)));
  f.controller.setRequests([...saved, request('draft', [box()], {preview: true})]); f.flush();
  assert.equal(f.controller.diagnostics().requests, FEEDBACK_LIMITS.requests + 1);
  assert.equal(f.controller.diagnostics().boxes, FEEDBACK_LIMITS.requests + 1);
  assert.equal(f.layer(0).children.filter(child => child.className === 'pdf-request-marker').length, FEEDBACK_LIMITS.requests);
  assert.equal(f.layer(0).children.filter(child => child.className === 'pdf-request-marker is-draft').length, 1);
  f.controller.setRequests([...saved, request('extra-saved')]); f.flush();
  assert.equal(f.controller.diagnostics().requests, FEEDBACK_LIMITS.requests);
  f.controller.setRequests([request('draft-one', [box()], {preview: true}), request('draft-two', [box(2)], {preview: true}), ...saved]); f.flush();
  assert.equal(f.controller.diagnostics().requests, FEEDBACK_LIMITS.requests);
  assert.equal(f.layer(1), undefined);
  assert.equal(f.layer(0).children.filter(child => child.className === 'pdf-request-marker is-draft').length, 1);
  for (const invalidDraft of [request('draft', [box(0)], {preview: true}),
    request('draft', [box()], {preview: true, source: {name: 'no identity'}}),
    request('draft', Array(FEEDBACK_LIMITS.boxes + 1).fill(box()), {preview: true})]) {
    f.controller.setRequests([...saved, invalidDraft]); f.flush();
    assert.equal(f.controller.diagnostics().requests, FEEDBACK_LIMITS.requests);
    assert.equal(f.layer(0).children.filter(child => child.className.includes('is-draft')).length, 0);
  }
  f.controller.setRequests([request('not-a-draft', [box()], {preview: 'true'})]); f.flush();
  assert.equal(f.layer(0).children[0].className, 'pdf-request-highlight');
  assert.equal(f.layer(0).children[1].textContent, '1');
});

test('checks source again inside the scheduled frame and snapshots caller-owned geometry', t => {
  const f = fixture(t), saved = request();
  f.controller.setRequests([saved]);
  saved.selection.boxes[0].pdfRect[0] = 90;
  saved.source.modifiedMs = 500;
  f.flush(); assert.equal(f.layer(0).children[0].style.left, '10%');
  f.controller.refresh(); f.setInfo({...source, documentId: 'replacement'}); f.flush();
  assert.equal(f.layer(0), undefined);
});

test('restores its layer after native resets and replaces it when the page view is remounted', t => {
  const f = fixture(t); f.controller.setRequests([request()]); f.flush();
  const oldLayer = f.layer(0), oldChildren = [...oldLayer.children], oldView = f.pages[0]; oldLayer.remove();
  f.eventBus.dispatch('pagerender', {source: oldView, pageNumber: 1}); f.flush();
  assert.equal(f.layer(0), oldLayer);
  assert.deepEqual(f.layer(0).children, oldChildren);
  assert.equal(f.layer(0).children[0], oldChildren[0]);
  oldView.div.remove(); f.pages[0] = f.makePage(1);
  f.eventBus.dispatch('pagerendered', {source: oldView, pageNumber: 1});
  assert.equal(f.frames.size, 0);
  f.eventBus.dispatch('pagerender', {source: f.pages[0], pageNumber: 1}); f.flush();
  assert.notEqual(f.layer(0), oldLayer); assert.equal(oldLayer.parentNode, null);
  assert.equal(f.controller.diagnostics().mountedPages, 1);
});

test('skips detached, placeholder and missing-viewport pages and restores them when ready', t => {
  const f = fixture(t); const savedViewport = f.pages[2].viewport;
  f.pages[0].div.remove(); f.pages[1].pdfPage = null; f.pages[2].viewport = null;
  f.controller.setRequests([request('three', [box(1), box(2), box(3)])]); f.flush();
  assert.equal(f.controller.diagnostics().mountedPages, 0);
  f.pdfViewer.container.append(f.pages[0].div); f.pages[1].pdfPage = {}; f.pages[2].viewport = savedViewport;
  f.eventBus.dispatch('pagesinit', {source: f.pdfViewer}); f.flush();
  assert.equal(f.controller.diagnostics().mountedPages, 3);
  f.pages[0].div.remove(); f.controller.refresh(); f.flush();
  assert.equal(f.controller.diagnostics().mountedPages, 2);
});

test('coalesces viewer changes, ignores foreign events, and never installs scroll listeners', t => {
  const f = fixture(t, 1000); f.controller.setRequests([request('last', [box(999)])]);
  for (const name of ['pagesinit', 'scalechanging', 'rotationchanging']) f.eventBus.dispatch(name, {source: f.pdfViewer});
  f.controller.refresh(); assert.equal(f.frames.size, 1); f.flush();
  assert.deepEqual(f.lookups, [998]); assert.equal(f.frames.size, 0);
  assert.deepEqual([...f.listeners.keys()].sort(), ['pagerender', 'pagerendered', 'pagesinit', 'rotationchanging', 'scalechanging']);
  for (const name of f.listeners.keys()) f.eventBus.dispatch(name, {source: {}, pageNumber: 999});
  assert.equal(f.frames.size, 0);
  f.pages[998].viewport = {width: 200, height: 100, convertToViewportPoint: (x, y) => [y, x]};
  f.eventBus.dispatch('rotationchanging', {source: f.pdfViewer}); f.flush();
  assert.equal(f.layer(998).children[0].style.left, '10%');
  assert.equal(f.layer(998).children[0].style.top, '10%');
  f.pages[998].viewport = {width: 400, height: 200, convertToViewportPoint: (x, y) => [2 * y, 2 * x]};
  f.eventBus.dispatch('scalechanging', {source: f.pdfViewer}); f.flush();
  assert.equal(f.layer(998).children[0].style.left, '10%');
  assert.equal(f.layer(998).children[0].style.top, '10%');
  assert.equal(f.frames.size, 0);
});

test('ignores unrelated render completions and reuses unchanged geometry and queue numbering', t => {
  const f = fixture(t);
  f.controller.setRequests([request('first'), request('foreign', [box(2)], {source: {...source, documentId: 'other'}})]);
  f.flush(); const layer = f.layer(0), highlight = layer.children[0], marker = layer.children[1];
  for (const name of ['pagerender', 'pagerendered']) {
    for (const pageNumber of [2, 3, 4, 5]) f.eventBus.dispatch(name, {source: f.pages[pageNumber - 1], pageNumber});
  }
  assert.equal(f.frames.size, 0); assert.equal(f.controller.diagnostics().refreshes, 1);
  f.eventBus.dispatch('pagerendered', {source: f.pages[0], pageNumber: 1}); f.flush();
  assert.equal(layer.children[0], highlight); assert.equal(layer.children[1], marker);
  f.controller.setRequests([request('first')]); f.flush();
  assert.equal(layer.children[0], highlight); assert.equal(layer.children[1], marker);
  f.controller.setRequests([request('invisible', [box(2)]), request('first')]); f.flush();
  assert.equal(layer.children[1].textContent, '2'); assert.notEqual(layer.children[1], marker);
});

test('bounds untrusted queue geometry and ignores invalid entries', t => {
  const f = fixture(t);
  const invalid = [null, request('empty', []), request('bad-page', [box(0)]),
    request('nan', [box(1, [0, 0, NaN, 10])]), request('many', Array(FEEDBACK_LIMITS.boxes + 1).fill(box())),
    request('no-source', [box()], {source: {name: 'no identity'}})];
  f.controller.setRequests(invalid); f.flush(); assert.equal(f.controller.diagnostics().boxes, 0);
  f.controller.setRequests(Array.from({length: FEEDBACK_LIMITS.requests + 3}, (_, i) => request(String(i))));
  f.flush(); assert.equal(f.controller.diagnostics().boxes, FEEDBACK_LIMITS.requests);
  f.controller.setRequests([request('same'), request('same')]); f.flush();
  assert.equal(f.controller.diagnostics().boxes, 1);
  f.controller.setRequests([request('max-boxes', Array.from({length: FEEDBACK_LIMITS.boxes}, () => box()))]); f.flush();
  assert.equal(f.controller.diagnostics().boxes, FEEDBACK_LIMITS.boxes);
});

test('dispose removes only owned layers and makes late RAF callbacks and methods harmless', t => {
  const f = fixture(t); f.controller.setRequests([request()]); f.flush();
  f.controller.refresh(); const late = [...f.frames.values()][0];
  f.controller.dispose(); f.controller.dispose(); late();
  f.controller.setRequests([request('late')]); f.controller.refresh(); f.flush();
  assert.equal(f.frames.size, 0); assert.equal(f.layer(0), undefined);
  assert.equal(f.pages[0].div.children[0], f.pages[0].canvas);
  assert.ok([...f.listeners.values()].every(callbacks => callbacks.size === 0));
  assert.deepEqual(f.controller.diagnostics(), {requests: 0, matchingRequests: 0, mountedPages: 0,
    boxes: 0, markers: 0, scheduled: false, refreshes: 1, disposed: true});
});
