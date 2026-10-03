import test from 'node:test';
import assert from 'node:assert/strict';
import { PagePreviewController } from '../src/preview-controller.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, plans = [{}], pageCount = 50, options = {}) {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  const previousSource = Object.getOwnPropertyDescriptor(globalThis, '__PREVIEW_WORKER_SOURCE__');
  const workers = [];
  class MockWorker {
    constructor() {
      this.plan = plans.shift() || {};
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(message);
      if (message.type === 'init') {
        queueMicrotask(() => this.reply({id: message.id, type: 'ready', pageCount: this.plan.pageCount || 1}));
      } else if (message.type === 'render' && !this.plan.holdRenders) {
        queueMicrotask(() => this.reply(this.renderResult(message)));
      }
    }
    renderResult(message) {
      if (this.plan.errorPage === message.pageNumber) return {id: message.id, type: 'error', message: 'Synthetic render failure'};
      return {id: message.id, type: 'rendered', pageNumber: message.pageNumber,
        buffer: new Uint8Array([message.pageNumber & 255, 1, 2, 3]).buffer,
        mime: 'image/png', width: message.width, height: Math.round(message.width*848/600), renderMs: 2, encodeMs: 1, wasmBytes: 100};
    }
    reply(result) { this.onmessage?.({data: result}); }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', {value: MockWorker, configurable: true});
  Object.defineProperty(globalThis, '__PREVIEW_WORKER_SOURCE__', {value: '// mock worker', configurable: true});
  const listeners = new Map();
  const eventBus = {
    on(name, callback) { (listeners.get(name) || listeners.set(name, new Set()).get(name)).add(callback); },
    off(name, callback) { listeners.get(name)?.delete(callback); },
    dispatch(name, event) { for (const listener of listeners.get(name) || []) listener(event); },
  };
  const pages = Array.from({length: pageCount}, (_, index) => ({id: index + 1, div: {style: {}, dataset: {}}}));
  const pdfViewer = {getPageView: index => pages[index]};
  const controller = new PagePreviewController({pdfViewer, eventBus, width:600,enableSharp:false,...options,getWasm: async () => new Uint8Array([0, 97, 115, 109])});
  t.after(() => {
    controller.dispose();
    if (previousWorker) Object.defineProperty(globalThis, 'Worker', previousWorker); else delete globalThis.Worker;
    if (previousSource) Object.defineProperty(globalThis, '__PREVIEW_WORKER_SOURCE__', previousSource); else delete globalThis.__PREVIEW_WORKER_SOURCE__;
  });
  const start = count => controller.start({pageCount: count, getBytes: async () => new Uint8Array([37, 80, 68, 70])});
  return {controller, workers, eventBus, pages, start};
}

test('prepares appearances once and releases worker after complete cache', async t => {
  const {controller, workers, start, pages} = fixture(t, [{pageCount: 3}]);
  await start(3);
  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().preparedPages, 3);
  assert.equal(controller.cache.items.size, 3);
  assert.equal(workers[0].terminated, true);
  assert.equal(controller.snapshot().workerActive, false);
  assert.ok(pages[0].div.style.backgroundImage.startsWith('url("blob:'));
  controller.setFocus(3);
  await turn();
  assert.equal(workers[0].messages.filter(message => message.type === 'render').length, 3);
});

test('sharp mode prepares readable foreground pages first and retains an idle decoder',async t=>{
  const {controller,workers,start}=fixture(t,[{pageCount:3}],50,{enableSharp:true,width:1200});
  await start(3);
  assert.equal(controller.snapshot().preparedPages,3);
  assert.equal(controller.snapshot().workerRendering,false);
  assert.equal(workers[0].terminated,false);
  assert.deepEqual(workers[0].messages.filter(item=>item.type==='render').map(item=>[item.pageNumber,item.width]),[[1,1200],[2,1200],[3,1200]]);
  controller.setFocus(3);await turn();
  assert.equal(workers[0].messages.filter(item=>item.type==='render').length,3);
});
test('wider sharp results upgrade already mounted backgrounds without dropping readable fallback',async t=>{
  const {controller,workers,start,pages}=fixture(t,[{pageCount:3}],50,{enableSharp:true,width:1200});
  await start(3);const prior=pages[0].div.style.backgroundImage;
  pages[0].viewport={width:1600};controller.onViewportChanged();await turn();await turn();
  assert.equal(controller.sharpCache.has(1,1600),true);
  assert.equal(pages[0].div.dataset.appearanceWidth,'1600');
  assert.notEqual(pages[0].div.style.backgroundImage,prior);
  assert.equal(controller.cache.has(1),true);
  assert.equal(workers[0].terminated,false);
});

test('a page failure does not block other pages or create an endless retry loop', async t => {
  const {controller, workers, start} = fixture(t, [{pageCount: 3, errorPage: 2}]);
  await start(3);
  assert.equal(controller.snapshot().state, 'partial');
  assert.equal(controller.snapshot().failures, 1);
  assert.equal(controller.cache.has(1), true);
  assert.equal(controller.cache.has(3), true);
  controller.setFocus(2);
  await turn();
  assert.equal(workers[0].messages.filter(message => message.type === 'render').length, 3);
});

test('bounded cache evictions regenerate only missing near pages and terminate each sweep', async t => {
  const {controller, workers, start} = fixture(t, [{pageCount: 35}]);
  controller.cache.maxBytes = 80; // Twenty four-byte mock appearances.
  await start(35);
  assert.equal(controller.snapshot().preparedPages, 35);
  assert.ok(controller.cache.bytes <= 80);
  assert.equal(workers[0].messages.filter(message => message.type === 'render').length, 35);
  controller.setFocus(20);
  await turn();
  const requestsAfterRefill = workers[0].messages.filter(message => message.type === 'render').length;
  assert.ok(requestsAfterRefill > 35 && requestsAfterRefill <= 52);
  assert.ok(controller.cache.bytes <= 80);
  for (let page = 12; page <= 28; page++) assert.equal(controller.cache.has(page), true);
  assert.equal(controller.pumping, false);
  controller.setFocus(20);
  await turn();
  assert.equal(workers[0].messages.filter(message => message.type === 'render').length, requestsAfterRefill);
});

test('document change rejects queued work and prevents stale appearance mounting', async t => {
  const {controller, workers, start, pages} = fixture(t, [{pageCount: 1, holdRenders: true}, {pageCount: 1}]);
  const oldRun = start(1);
  await turn();
  const oldWorker = workers[0];
  const oldRender = oldWorker.messages.find(message => message.type === 'render');
  await start(1);
  const currentBackground = pages[0].div.style.backgroundImage;
  oldWorker.reply(oldWorker.renderResult(oldRender));
  await oldRun;
  assert.equal(controller.snapshot().state, 'ready');
  assert.equal(controller.snapshot().preparedPages, 1);
  assert.equal(pages[0].div.style.backgroundImage, currentBackground);
});

test('stop while bytes load never starts a worker for the abandoned document', async t => {
  const {controller, workers} = fixture(t);
  let supply;
  const run = controller.start({pageCount: 1, getBytes: () => new Promise(resolve => { supply = resolve; })});
  controller.stop();
  supply(new Uint8Array([37, 80, 68, 70]));
  await run;
  assert.equal(workers.length, 0);
  assert.equal(controller.snapshot().state, 'idle');
});

test('late error from an old worker cannot terminate the current document worker', async t => {
  const {controller, workers, start} = fixture(t, [{pageCount: 1}, {pageCount: 1, holdRenders: true}]);
  await start(1);
  const oldWorker = workers[0];
  const currentRun = start(1);
  await turn();
  const currentWorker = workers[1];
  oldWorker.onerror(new Error('Queued old-document error'));
  await turn();
  assert.equal(currentWorker.terminated, false);
  assert.equal(controller.worker, currentWorker);
  const render = currentWorker.messages.find(message => message.type === 'render');
  currentWorker.reply(currentWorker.renderResult(render));
  await currentRun;
});

test('detail redraw keeps the already rendered base-page canvas visible', t => {
  const {eventBus, pages} = fixture(t);
  const currentPage = pages[0];
  currentPage.div.dataset.sharpReady = 'true';
  eventBus.dispatch('pagerender', {pageNumber: 1, source: {id: 1, pageView: currentPage}});
  assert.equal(currentPage.div.dataset.sharpReady, 'true');
});

test('render completion from an old page object cannot reveal a new unfinished canvas', t => {
  const {eventBus, pages} = fixture(t);
  eventBus.dispatch('pagerendered', {pageNumber: 1, source: {id: 1, div: {}}, error: null, isDetailView: false});
  assert.equal(pages[0].div.dataset.sharpReady, undefined);
  eventBus.dispatch('pagerendered', {pageNumber: 1, source: pages[0], error: null, isDetailView: false});
  assert.equal(pages[0].div.dataset.sharpReady, 'true');
  eventBus.dispatch('pagerender', {pageNumber: 1, source: pages[0]});
  assert.equal(pages[0].div.dataset.sharpReady, undefined);
});

test('dispose removes event subscriptions and revokes mounted appearances', async t => {
  const {controller, eventBus, start, pages} = fixture(t, [{pageCount: 1}]);
  await start(1);
  controller.dispose();
  assert.equal(pages[0].div.style.backgroundImage, '');
  assert.equal(pages[0].div.dataset.previewReady, undefined);
  assert.equal(controller.pending.size, 0);
  eventBus.dispatch('pagerendered', {pageNumber: 1, source: pages[0], error: null});
  assert.equal(pages[0].div.dataset.sharpReady, undefined);
});
