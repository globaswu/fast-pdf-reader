import test from 'node:test';
import assert from 'node:assert/strict';
import { EarlyTextLayerController } from '../src/early-text-layer.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();

class Element {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument; this.children = []; this.dataset = {};
    this.attributes = {}; this.events = new Map(); this.parentNode = null; this.hidden = false;
    const classes = new Set();
    this.classList = {add: name => classes.add(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name)};
  }
  append(child) { child.remove(); this.children.push(child); child.parentNode = this; }
  insertBefore(child, before) {
    child.remove(); const index = this.children.indexOf(before);
    if (index < 0) this.children.push(child); else this.children.splice(index, 0, child);
    child.parentNode = this;
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.events.set(name, callback); }
  removeEventListener(name, callback) { if (this.events.get(name) === callback) this.events.delete(name); }
}

function fixture(t, options = {}) {
  let selection = {isCollapsed: true, rangeCount: 0};
  const dom = new Element();
  dom.createElement = () => new Element(dom);
  dom.getSelection = () => selection;
  const container = new Element(dom);
  const listeners = new Map();
  const eventBus = {
    on(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name, event = {}) { for (const listener of listeners.get(name) || []) listener(event); },
  };
  const requests = [], instances = [];
  const pages = Array.from({length: options.pageCount || 20}, (_, index) => {
    const id = index + 1;
    const pdfPage = {
      getTextContent: async params => {
        requests.push({number: id, params});
        if (options.text) return options.text(id, params);
        return {items: [{str: `Exact page ${id}: ﬁ x²`, transform: [12, 0, 0, 12, 10, 20], fontName: 'f1'}],
          styles: {f1: {fontFamily: 'serif'}}, lang: 'en'};
      },
      getOperatorList() { throw new Error('Text extraction must not request graphics'); },
      render() { throw new Error('Text extraction must not request a canvas'); },
    };
    const view = {id, div: new Element(dom), pdfPage, viewport: {scale: 1, rotation: 0, rawDims: {pageWidth: 595, pageHeight: 842}}};
    view.div.dataset.pageNumber = String(id); container.append(view.div);
    return view;
  });
  const document = {numPages: pages.length, getPage: async number => pages[number - 1].pdfPage,
    getPermissions: async () => options.permissions ?? null};
  class TextLayer {
    constructor(args) {
      Object.assign(this, args); this.updates = []; this.cancelled = false; instances.push(this);
      this.task = options.render?.(args);
    }
    async render() {
      if (this.task) await this.task;
      this.container.textContent = this.textContentSource.items.map(item => item.str || '').join('');
    }
    update({viewport}) { this.updates.push(viewport); }
    cancel() { this.cancelled = true; }
  }
  const pdfViewer = {container, currentPageNumber: 1, getPageView: index => pages[index]};
  const controller = new EarlyTextLayerController({pdfViewer, eventBus, TextLayer, radius: 0,
    ...options.controller, normalizeUnicode: value => value});
  t.after(() => controller.dispose());
  const start = async () => { await controller.setDocument(document); await turn(); };
  const native = number => {
    const view = pages[number - 1], div = new Element(dom);
    div.className = 'textLayer'; view.textLayer = {div}; view.div.append(div);
    eventBus.dispatch('textlayerrendered', {pageNumber: number, source: view});
    return div;
  };
  const select = numbers => {
    const divs = numbers.map(number => controller.layers.get(number)?.div).filter(Boolean);
    selection = {isCollapsed: false, rangeCount: 1,
      getRangeAt: () => ({intersectsNode: node => divs.includes(node)}), toString: () => 'Exact page 1: ﬁ x²'};
  };
  const clearSelection = async () => { selection = {isCollapsed: true, rangeCount: 0}; dom.events.get('selectionchange')(); await turn(); };
  return {controller, document, pages, eventBus, requests, instances, pdfViewer, start, native, select, clearSelection, dom, listeners};
}

test('builds selectable source text before any native graphics or text layer', async t => {
  const {start, controller, requests, instances, pages} = fixture(t);
  await start();
  assert.deepEqual(requests, [{number: 1, params: {includeMarkedContent: true, disableNormalization: true}}]);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].textContentSource.items[0].str, 'Exact page 1: ﬁ x²');
  const {div} = controller.layers.get(1);
  assert.equal(div.hidden, false);
  assert.equal(div.parentNode, pages[0].div);
  assert.equal(div.dataset.earlyTextLayer, 'true');
  assert.equal(div.attributes['oai-annotation-container-text'], '');
  assert.equal(pages[0].div.dataset.pageNumber, '1');
  assert.equal(pages[0].div.dataset.sourcePage, '1');
  assert.equal(pages[0].div.dataset.earlyTextReady, 'true');
});

test('honors PDF copy permissions before extracting or exposing text', async t => {
  const {start, requests, controller} = fixture(t, {permissions: [4, 32]});
  await start();
  assert.equal(requests.length, 0);
  assert.equal(controller.snapshot().allowed, false);
  assert.equal(controller.layers.size, 0);
});

test('native readiness removes duplicate text and ignores old-page events', async t => {
  const {start, controller, native, eventBus, pages} = fixture(t);
  await start();
  const early = controller.layers.get(1).div;
  eventBus.dispatch('textlayerrendered', {pageNumber: 1, source: {id: 1}});
  assert.equal(controller.layers.size, 1);
  const div = native(1);
  assert.equal(controller.layers.size, 0);
  assert.equal(early.parentNode, null);
  assert.equal(div.parentNode, pages[0].div);
  assert.equal(pages[0].div.dataset.earlyTextReady, undefined);
});

test('handoff preserves selected DOM and restores native layer after selection release', async t => {
  const {start, controller, native, select, clearSelection, pages} = fixture(t);
  await start(); select([1]);
  const early = controller.layers.get(1).div;
  const div = native(1);
  assert.equal(early.parentNode, pages[0].div);
  assert.equal(div.parentNode, null, 'native text is detached, not merely hidden');
  assert.equal(controller.snapshot().heldSelections, 1);
  await clearSelection();
  assert.equal(early.parentNode, null);
  assert.equal(div.parentNode, pages[0].div);
  assert.equal(controller.layers.size, 0);
});

test('a feedback-pinned range survives focus moving away from the browser selection', async t => {
  let pinned = true;
  const {start, controller, native, select, clearSelection, eventBus} = fixture(t,
    {controller: {isSelectionPinned: () => pinned}});
  await start(); select([1]); native(1);
  await clearSelection();
  assert.equal(controller.layers.size, 1);
  pinned = false; eventBus.dispatch('updateviewarea'); await turn();
  assert.equal(controller.layers.size, 0);
});

test('feedback can pin its saved range before the first native handoff', async t => {
  let pinnedDiv = null;
  const f = fixture(t, {controller: {isSelectionPinned: div => div === pinnedDiv}});
  await f.start(); f.select([1]);
  pinnedDiv = f.controller.layers.get(1).div;
  await f.clearSelection();
  const native = f.native(1);
  assert.equal(native.parentNode, null);
  assert.equal(pinnedDiv.parentNode, f.pages[0].div);
  pinnedDiv = null;
  f.eventBus.dispatch('updateviewarea'); await turn();
  assert.equal(native.parentNode, f.pages[0].div);
  assert.equal(f.controller.layers.size, 0);
});

test('copy uses actual selected Unicode and the same normalization hook as PDF.js', async t => {
  const {start, controller, select} = fixture(t);
  await start(); select([1]);
  let copied;
  controller.layers.get(1).div.events.get('copy')({
    clipboardData: {setData: (mime, text) => { copied = {mime, text}; }},
    preventDefault() {}, stopPropagation() {},
  });
  assert.deepEqual(copied, {mime: 'text/plain', text: 'Exact page 1: ﬁ x²'});
});

test('rotation, zoom, and native page resets use the current native viewport', async t => {
  const {start, controller, pages, eventBus, requests} = fixture(t);
  await start();
  const record = controller.layers.get(1);
  record.div.remove();
  pages[0].viewport = {scale: 2, rotation: 90, rawDims: {pageWidth: 595, pageHeight: 842}};
  eventBus.dispatch('rotationchanging'); eventBus.dispatch('scalechanging'); await turn();
  assert.equal(record.div.parentNode, pages[0].div);
  assert.equal(record.layer.updates.at(-1), pages[0].viewport);
  assert.equal(requests.length, 1);
});

test('does not mount against placeholder geometry from a different page size', async t => {
  const f = fixture(t);
  const actual = f.pages[0].pdfPage;
  f.document.getPage = async () => actual;
  f.pages[0].pdfPage = null;
  await f.start();
  assert.equal(f.controller.layers.size, 0);
  assert.equal(f.controller.cache.size, 1);
  f.pages[0].pdfPage = actual;
  f.pages[0].viewport = {scale: 1.5, rotation: 270, rawDims: {pageWidth: 300, pageHeight: 500}};
  f.eventBus.dispatch('pagerender', {source: f.pages[0], pageNumber: 1}); await turn();
  assert.equal(f.instances[0].viewport, f.pages[0].viewport);
  assert.equal(f.requests.length, 1);
});

test('request concurrency is bounded and stale document work cannot mount', async t => {
  const jobs = [];
  const f = fixture(t, {controller: {radius: 2}, text: () => { const job = deferred(); jobs.push(job); return job.promise; }});
  await f.start();
  assert.equal(f.requests.length, 2);
  assert.equal(f.controller.snapshot().pendingPages, 2);
  f.controller.stop();
  for (const job of jobs) job.resolve({items: [], styles: {}});
  await turn();
  assert.equal(f.controller.layers.size, 0);
  assert.equal(f.controller.cache.size, 0);
});

test('bounded neighbors and LRU cache do not extract the whole document', async t => {
  const f = fixture(t, {controller: {radius: 1, maxCachePages: 3}});
  await f.start(); await turn();
  assert.deepEqual(f.requests.map(item => item.number), [1, 2]);
  f.pdfViewer.currentPageNumber = 10;
  f.eventBus.dispatch('pagechanging'); await turn(); await turn();
  assert.deepEqual([...f.controller.layers.keys()].sort((a, b) => a - b), [9, 10, 11]);
  assert.ok(f.controller.cache.size <= 3);
  assert.equal(f.requests.length, 5);
  f.pdfViewer.currentPageNumber = 9;
  f.eventBus.dispatch('pagechanging'); await turn(); await turn();
  assert.equal(f.requests.filter(item => item.number === 9).length, 1);
  assert.ok(f.controller.cache.size <= 3);
});

test('tiny cache and unavailable page geometry cannot create an extraction retry loop', async t => {
  const f = fixture(t, {controller: {radius: 1, maxCacheBytes: 1}});
  const actual = f.pages.map(view => view.pdfPage);
  f.document.getPage = async number => actual[number - 1];
  f.pages.forEach(view => { view.pdfPage = null; });
  await f.start(); await turn();
  assert.equal(f.requests.length, 2);
  assert.equal(f.controller.cache.size, 0);
  f.eventBus.dispatch('updateviewarea'); await turn();
  assert.equal(f.requests.length, 2);
});

test('failed extraction and rendering do not spin or replace native behavior', async t => {
  const f = fixture(t, {text: async () => { throw new Error('Malformed text'); }});
  await f.start();
  f.eventBus.dispatch('updateviewarea'); await turn();
  assert.equal(f.requests.length, 1);
  assert.equal(f.controller.snapshot().failures, 1);
  assert.equal(f.controller.layers.size, 0);
});

test('stop cancels unfinished text DOM and releases all event subscriptions', async t => {
  const job = deferred();
  const f = fixture(t, {render: () => job.promise});
  await f.start();
  assert.equal(f.instances.length, 1);
  f.controller.dispose();
  assert.equal(f.instances[0].cancelled, true);
  assert.equal(f.controller.layers.size, 0);
  assert.equal([...f.listeners.values()].reduce((sum, set) => sum + set.size, 0), 0);
  assert.equal(f.dom.events.size, 0);
  job.resolve(); await turn();
  assert.equal(f.pages[0].div.dataset.earlyTextReady, undefined);
});

test('same-byte source switch preserves ready pinned layers, native handoff, and cached content', async t => {
  let pinnedDiv = null;
  const f = fixture(t, {controller: {isSelectionPinned: div => div === pinnedDiv}});
  f.document.fingerprints = ['same-pdf'];
  await f.start(); f.select([1]);
  const record = f.controller.layers.get(1), cached = f.controller.cache.get(1);
  pinnedDiv = record.div;
  const native = f.native(1); await f.clearSelection();
  const newRequests = [];
  const source = {...f.document, getPage: async number => ({getTextContent: async () => {
    newRequests.push(number); return {items: [{str: `New worker page ${number}`}], styles: {}};
  }})};
  assert.equal(await f.controller.useExtractionDocument(source), true);
  await turn();
  assert.equal(f.controller.document, source);
  assert.equal(f.controller.layers.get(1), record);
  assert.equal(f.controller.cache.get(1), cached);
  assert.equal(record.div.parentNode, f.pages[0].div);
  assert.equal(record.handoff, native);
  assert.equal(native.parentNode, null);
  f.pdfViewer.currentPageNumber = 2;
  f.eventBus.dispatch('pagechanging'); await turn();
  assert.deepEqual(newRequests, [2]);
  assert.equal(f.instances.at(-1).viewport, f.pages[1].viewport);
  assert.equal(f.controller.layers.get(1), record, 'the pinned original page survives navigation');
});

test('source switch discards old pending extraction without deleting the new request token', async t => {
  const oldText = deferred(), newText = deferred();
  const f = fixture(t, {text: () => oldText.promise});
  await f.start();
  const source = {...f.document, getPage: async () => ({getTextContent: () => newText.promise})};
  await f.controller.useExtractionDocument(source); await turn();
  assert.equal(f.controller.pending.size, 1);
  oldText.resolve({items: [{str: 'stale'}], styles: {}}); await turn();
  assert.equal(f.controller.pending.size, 1);
  assert.equal(f.controller.layers.size, 0);
  assert.equal(f.controller.cache.size, 0);
  newText.resolve({items: [{str: 'current'}], styles: {}}); await turn();
  assert.equal(f.controller.layers.get(1).div.textContent, 'current');
  assert.equal(f.controller.cache.get(1).content.items[0].str, 'current');
  assert.equal(f.controller.pending.size, 0);
});

test('source switch cancels unfinished TextLayers and remounts their cached content', async t => {
  const rendering = deferred();
  let count = 0;
  const f = fixture(t, {render: () => ++count === 1 ? rendering.promise : null});
  await f.start();
  const unfinished = f.controller.layers.get(1);
  const source = {...f.document, getPage: async () => { throw new Error('Cached text should be reused'); }};
  await f.controller.useExtractionDocument(source); await turn();
  const current = f.controller.layers.get(1);
  assert.equal(unfinished.layer.cancelled, true);
  assert.equal(unfinished.div.parentNode, null);
  assert.notEqual(current, unfinished);
  assert.equal(current.ready, true);
  rendering.resolve(); await turn();
  assert.equal(f.controller.layers.get(1), current);
  assert.equal(f.controller.snapshot().failures, 0);
});

test('source switch rejects different fingerprint, page count, and denied copy permissions without mutation', async t => {
  const f = fixture(t);
  f.document.fingerprints = ['original'];
  await f.start();
  const record = f.controller.layers.get(1), epoch = f.controller.generation;
  await assert.rejects(f.controller.useExtractionDocument({...f.document, fingerprints: ['different']}), /fingerprint/);
  await assert.rejects(f.controller.useExtractionDocument({...f.document, numPages: 99}), /page count/);
  await assert.rejects(f.controller.useExtractionDocument({...f.document, getPermissions: async () => [4]}), /copying/);
  assert.equal(f.controller.document, f.document);
  assert.equal(f.controller.generation, epoch);
  assert.equal(f.controller.layers.get(1), record);
  assert.equal(record.div.parentNode, f.pages[0].div);
});

test('source switch cannot bypass original permissions through a permissive second proxy', async t => {
  const f = fixture(t, {permissions: [4]});
  let originalChecks = 0;
  f.document.getPermissions = async () => { originalChecks++; return [4]; };
  await f.start();
  await assert.rejects(f.controller.useExtractionDocument({...f.document, getPermissions: async () => null}), /copying/);
  await assert.rejects(f.controller.useExtractionDocument(f.document), /copying/);
  assert.equal(originalChecks, 1);
  assert.equal(f.controller.document, f.document);
  assert.equal(f.controller.allowed, false);
  assert.equal(f.requests.length, 0);
});

test('source switch reuses verified permissions when the original worker becomes busy', async t => {
  const f = fixture(t);
  let originalChecks = 0, sourceChecks = 0;
  f.document.getPermissions = async () => {
    originalChecks++;
    if (originalChecks > 1) throw new Error('The original worker must not be queried again');
    return null;
  };
  await f.start();
  assert.equal(await f.controller.useExtractionDocument(f.document), true);
  const source = {...f.document, getPermissions: async () => {
    sourceChecks++;
    if (sourceChecks > 1) throw new Error('The same extraction source must not be queried again');
    return null;
  }};
  assert.equal(await f.controller.useExtractionDocument(source), true);
  assert.equal(await f.controller.useExtractionDocument(source), true);
  assert.equal(originalChecks, 1);
  assert.equal(sourceChecks, 1);
  assert.equal(f.controller.allowed, true);
  assert.equal(f.controller.document, source);
});

test('delayed source permission result cannot revive a stopped or replaced document', async t => {
  const gate = deferred();
  const f = fixture(t);
  await f.start();
  const switchResult = f.controller.useExtractionDocument({...f.document, getPermissions: () => gate.promise});
  f.controller.stop();
  gate.resolve(null);
  assert.equal(await switchResult, false);
  await turn();
  assert.equal(f.controller.document, null);
  assert.equal(f.controller.allowed, false);
  assert.equal(f.controller.layers.size, 0);
});
