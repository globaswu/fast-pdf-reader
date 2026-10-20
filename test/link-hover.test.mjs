import test from 'node:test';
import assert from 'node:assert/strict';
import {createLinkHover} from '../src/link-hover.mjs';

function fixture(t) {
  const all = [], bus = new Map(), frames = new Map(), cancelled = [], hits = [];
  let nextFrame = 1, blocked = false, selection = {isCollapsed: true};
  function node(kind, parent = null) {
    const classes = new Set(), attrs = new Map(), handlers = new Map();
    const value = {kind, parentElement: parent, isConnected: true, handlers, children: [], textContent: '', hidden: false,
      classList: {contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name)},
      contains(other) { for (let p = other; p; p = p.parentElement) if (p === this) return true; return false; },
      closest(selector) { for (let p = this; p; p = p.parentElement) {
        if (selector === '.page' && p.kind === 'page') return p;
        if (selector === '.linkAnnotation' && p.kind === 'annotation') return p;
      } return null; },
      getAttribute(name) { return attrs.get(name) ?? null; }, setAttribute(name, value) { attrs.set(name, value); },
      append(child) { child.parentElement = this; this.children.push(child); },
      remove() { this.isConnected = false; this.parentElement.children = this.parentElement.children.filter(child => child !== this); },
      addEventListener(name, callback, options) { if (!handlers.has(name)) handlers.set(name, new Map()); handlers.get(name).set(callback, options); },
      removeEventListener(name, callback) { handlers.get(name)?.delete(callback); },
      fire(name, values = {}) { const event = {target: this, pointerType: 'mouse', buttons: 0, isPrimary: true, clientX: 20, clientY: 30, ...values};
        for (const callback of handlers.get(name)?.keys() || []) callback(event); return event; },
    };
    all.push(value); return value;
  }
  const doc = node('document'), win = node('window'), panel = node('panel', doc), container = node('container', panel);
  const page = node('page', container), text = node('text', page), annotation = node('annotation', page), anchor = node('anchor', annotation);
  const secondAnnotation = node('annotation', page), secondAnchor = node('anchor', secondAnnotation);
  anchor.href = 'https://example.test/article?x=1&y=2'; anchor.setAttribute('href', anchor.href);
  secondAnchor.href = 'https://example.test/second'; secondAnchor.setAttribute('href', secondAnchor.href);
  let hit = anchor, failHit = false;
  container.ownerDocument = doc; doc.defaultView = win; doc.hidden = false;
  doc.createElement = () => node('badge'); doc.getSelection = () => selection;
  win.requestAnimationFrame = callback => { const id = nextFrame++; frames.set(id, callback); return id; };
  win.cancelAnimationFrame = id => { cancelled.push(frames.get(id)); frames.delete(id); };
  const eventBus = {on(name, callback) { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name).add(callback); },
    off(name, callback) { bus.get(name)?.delete(callback); }, dispatch(name) { for (const callback of bus.get(name) || []) callback(); }};
  const controller = createLinkHover({container, eventBus, blocked: () => blocked,
    pageOf: target => target.closest('.page'), hitAnchor(x, y, p) { hits.push([x, y, p]); if (failHit) throw new Error('Synthetic hit test failure.'); return hit; }});
  t.after(() => controller.dispose());
  const badge = panel.children.find(child => child.id === 'pdf-link-destination');
  const flush = () => { const work = [...frames.values()]; frames.clear(); work.forEach(callback => callback()); };
  const move = values => container.fire('pointermove', {target: text, ...values});
  return {doc, win, panel, container, page, text, annotation, anchor, secondAnnotation, secondAnchor, badge, all, bus, hits, frames, cancelled,
    controller, eventBus, flush, move, setHit(value) { hit = value; }, setBlocked(value) { blocked = value; },
    setSelection(value) { selection = value; }, setFailHit(value) { failHit = value; }};
}

test('passive hover coalesces to one browser hit test per animation frame without idle work', t => {
  const ui = fixture(t); ui.move(); ui.move({clientX: 24}); ui.move({clientX: 32});
  assert.equal(ui.hits.length, 0); assert.equal(ui.frames.size, 1); ui.flush();
  assert.deepEqual(ui.hits[0], [32, 30, ui.page]); assert.equal(ui.hits.length, 1); assert.equal(ui.frames.size, 0);
  assert.equal(ui.annotation.classList.contains('is-link-hovered'), true);
  assert.equal(ui.container.classList.contains('link-hovering'), true);
  assert.equal(ui.badge.hidden, false); assert.equal(ui.badge.textContent, ui.anchor.href);
  ui.flush(); assert.equal(ui.hits.length, 1);
  for (const name of ['pointermove', 'pointerover']) for (const options of ui.container.handlers.get(name).values()) assert.equal(options.passive, true);
});

test('pointerover triggers initial hover and moving between annotations removes old highlight', t => {
  const ui = fixture(t); ui.container.fire('pointerover', {target: ui.text}); ui.flush();
  ui.setHit(ui.secondAnchor); ui.move(); ui.flush();
  assert.equal(ui.annotation.classList.contains('is-link-hovered'), false);
  assert.equal(ui.secondAnnotation.classList.contains('is-link-hovered'), true);
  assert.equal(ui.badge.textContent, ui.secondAnchor.href);
});

test('dragging, non-mouse pointers, blocked dialogs and invalid points never hit-test', t => {
  const ui = fixture(t);
  for (const values of [{buttons: 1}, {buttons: 2}, {pointerType: 'touch'}, {pointerType: 'pen'}, {isPrimary: false},
    {clientX: NaN}, {clientY: Infinity}, {target: ui.container}]) { ui.move(values); ui.flush(); }
  ui.setBlocked(true); ui.move(); ui.flush(); assert.equal(ui.hits.length, 0);
  ui.setBlocked(false); ui.move(); ui.setBlocked(true); ui.flush(); assert.equal(ui.hits.length, 0);
});

test('pointerdown clears immediately and stale cancelled frames cannot restore hover', t => {
  const ui = fixture(t); ui.move(); ui.flush(); ui.move();
  ui.doc.fire('pointerdown', {button: 2, buttons: 2});
  assert.equal(ui.badge.hidden, true); assert.equal(ui.frames.size, 0);
  assert.equal(ui.annotation.classList.contains('is-link-hovered'), false);
  for (const callback of ui.cancelled) callback?.();
  assert.equal(ui.badge.hidden, true); assert.equal(ui.hits.length, 1);
  ui.move({buttons: 1}); ui.flush(); assert.equal(ui.hits.length, 1);
  ui.move(); ui.flush(); assert.equal(ui.badge.hidden, false);
});

test('leave, scroll, blur, cancellation, resize and viewer lifecycle clear hover and queued work', t => {
  const ui = fixture(t);
  const events = [() => ui.container.fire('pointerleave'), () => ui.container.fire('scroll'), () => ui.win.fire('blur'),
    () => ui.win.fire('resize'), () => ui.doc.fire('pointercancel'),
    ...['pagesdestroy', 'pagesinit', 'documentloaded', 'scalechanging', 'rotationchanging', 'pagechanging', 'updateviewarea'].map(name => () => ui.eventBus.dispatch(name))];
  for (const clear of events) { ui.move(); ui.flush(); ui.move(); clear();
    assert.equal(ui.badge.hidden, true); assert.equal(ui.frames.size, 0); assert.equal(ui.container.classList.contains('link-hovering'), false); }
});

test('noncollapsed selection and document visibility hide current hover', t => {
  const ui = fixture(t); ui.move(); ui.flush(); ui.doc.fire('selectionchange'); assert.equal(ui.badge.hidden, false);
  ui.setSelection({isCollapsed: false}); ui.doc.fire('selectionchange'); assert.equal(ui.badge.hidden, true);
  ui.move(); ui.flush(); ui.doc.hidden = true; ui.doc.fire('visibilitychange'); assert.equal(ui.badge.hidden, true);
  ui.move(); ui.flush(); assert.equal(ui.badge.hidden, true);
});

test('browser-reported wrapped gaps, occlusion, detached pages and failed hit tests remove feedback', t => {
  const ui = fixture(t); ui.move(); ui.flush(); ui.setHit(null); ui.move(); ui.flush(); assert.equal(ui.badge.hidden, true);
  ui.setHit(ui.anchor); ui.move(); ui.flush(); ui.setFailHit(true); ui.move(); ui.flush(); assert.equal(ui.badge.hidden, true);
  ui.setFailHit(false); ui.move(); ui.page.isConnected = false; ui.flush(); assert.equal(ui.badge.hidden, true);
  ui.page.isConnected = true; ui.move(); ui.annotation.isConnected = false; ui.flush(); assert.equal(ui.badge.hidden, true);
});

test('external destination uses actual href as inert plain text, not title or markup', t => {
  const ui = fixture(t); ui.anchor.href = 'https://example.test/<img src=x onerror=alert(1)>?x=1&y=2';
  ui.anchor.setAttribute('title', 'Trusted-looking title'); ui.move(); ui.flush();
  assert.equal(ui.badge.textContent, ui.anchor.href); assert.equal(ui.badge.children.length, 0);
  assert.equal(ui.anchor.getAttribute('title'), 'Trusted-looking title');
});

test('internal destinations show a readable title or page label instead of encoded navigation data', t => {
  const ui = fixture(t); ui.anchor.setAttribute('href', '#%5B%7B%22num%22%3A123%7D%5D');
  ui.anchor.setAttribute('title', 'Go to section 3.1'); ui.move(); ui.flush(); assert.equal(ui.badge.textContent, 'Go to section 3.1');
  ui.anchor.setAttribute('title', ''); ui.move(); ui.flush(); assert.equal(ui.badge.textContent, 'Internal PDF link');
  ui.anchor.setAttribute('href', '#page=42&zoom=100'); ui.move(); ui.flush(); assert.equal(ui.badge.textContent, 'Go to page 42');
  ui.anchor.setAttribute('href', 'https://example.test/viewer#opaque'); ui.anchor.classList.add('internalLink');
  ui.move(); ui.flush(); assert.equal(ui.badge.textContent, 'Internal PDF link');
});

test('display labels strip bidi and control characters and bound extremely long destinations', t => {
  const ui = fixture(t); ui.anchor.href = 'https://example.test/\u202e\u2066abc\u0000\n'; ui.move(); ui.flush();
  assert.equal(ui.badge.textContent, 'https://example.test/abc');
  ui.anchor.href = 'https://example.test/' + 'a'.repeat(3000); ui.move(); ui.flush(); assert.equal(ui.badge.textContent.length, 2048);
});

test('dispose removes owned classes, badge, frames and every listener idempotently', t => {
  const ui = fixture(t); ui.move(); ui.flush(); ui.move(); ui.controller.dispose(); ui.controller.dispose();
  assert.equal(ui.frames.size, 0); assert.equal(ui.badge.isConnected, false);
  assert.equal(ui.annotation.classList.contains('is-link-hovered'), false); assert.equal(ui.container.classList.contains('link-hovering'), false);
  for (const item of ui.all) for (const callbacks of item.handlers.values()) assert.equal(callbacks.size, 0);
  for (const callbacks of ui.bus.values()) assert.equal(callbacks.size, 0);
  const hits = ui.hits.length; ui.move(); ui.flush(); assert.equal(ui.hits.length, hits);
});

test('pre-existing class ownership is preserved without changing anchor attributes', t => {
  const ui = fixture(t); ui.container.classList.add('link-hovering'); ui.annotation.classList.add('is-link-hovered');
  ui.move(); ui.flush(); ui.controller.clear();
  assert.equal(ui.container.classList.contains('link-hovering'), true); assert.equal(ui.annotation.classList.contains('is-link-hovered'), true);
  assert.equal(ui.anchor.getAttribute('href'), ui.anchor.href); assert.equal(ui.anchor.getAttribute('title'), null);
});
