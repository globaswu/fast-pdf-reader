import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeLinkTextSelection} from '../src/link-text-selection.mjs';

function fixture(t) {
  const all = [], calls = [], bus = new Map();
  function node(kind, parent = null) {
    const classes = new Set(), handlers = new Map();
    const value = {kind, parentElement: parent, isConnected: true, handlers, nodeType: 1,
      classList: {contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name)},
      contains(other) { for (let p = other; p; p = p.parentElement) if (p === this) return true; return false; },
      closest(selector) {
        for (let p = this; p; p = p.parentElement) {
          if (selector === '.page' && p.kind === 'page') return p;
          if (selector === '.linkAnnotation > a[href]' && p.kind === 'anchor') return p;
          if (selector === '.annotationLayer:not(.disabled)' && p.kind === 'annotations' && !p.classList.contains('disabled')) return p;
          if (selector.startsWith('input,') && p.kind === 'excluded') return p;
        }
        return null;
      },
      addEventListener(name, callback) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(callback); },
      removeEventListener(name, callback) { handlers.get(name)?.delete(callback); },
      fire(name, values = {}) {
        const event = {type: name, target: this, button: 0, isPrimary: true, pointerType: 'mouse', pointerId: 1,
          clientX: 20, clientY: 30, detail: 1, defaultPrevented: false, stopped: false,
          preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...values};
        for (const listener of handlers.get(name) || []) { listener(event); if (event.stopped) break; }
        return event;
      },
    };
    all.push(value); return value;
  }
  const doc = node('document'), win = node('window'), container = node('container', doc);
  const page = node('page', container), text = node('text', page), annotations = node('annotations', page);
  const anchor = node('anchor', annotations), otherAnchor = node('anchor', annotations), excluded = node('excluded', page);
  const secondPage = node('page', container), otherText = node('text', secondPage);
  let hit = anchor, selection = {isCollapsed: true}, dialogOpen = false, failHit = false;
  container.ownerDocument = doc; doc.defaultView = win;
  doc.querySelector = selector => selector === 'dialog[open]' && dialogOpen ? {} : null;
  doc.getSelection = () => selection;
  doc.elementFromPoint = (x, y) => {
    calls.push([x, y]); assert.ok(container.classList.contains('link-hit-test'));
    if (failHit) throw new Error('Synthetic hit-test failure.');
    return hit;
  };
  win.MouseEvent = class { constructor(type, options) { Object.assign(this, {type}, options); } };
  anchor.dispatched = [];
  anchor.dispatchEvent = event => {
    anchor.dispatched.push(event);
    container.fire('click', {...event, target: anchor});
    return true;
  };
  const eventBus = {on(name, callback) { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name).add(callback); },
    off(name, callback) { bus.get(name)?.delete(callback); },
    dispatch(name) { for (const listener of bus.get(name) || []) listener({}); }};
  const controller = initializeLinkTextSelection({container, eventBus, createHover:()=>({clear(){},dispose(){}})});
  t.after(() => controller.dispose());
  const down = values => container.fire('pointerdown', {target: text, ...values});
  const move = values => doc.fire('pointermove', {target: text, ...values});
  const up = values => doc.fire('pointerup', {target: text, ...values});
  const click = values => container.fire('click', {target: text, ...values});
  return {doc, win, container, page, text, annotations, anchor, otherAnchor, excluded, otherText, eventBus,
    controller, calls, all, bus, down, move, up, click,
    setHit(value) { hit = value; }, setSelection(value) { selection = value; },
    setDialog(value) { dialogOpen = value; }, setHitFailure(value) { failHit = value; }};
}

test('stationary primary click relays exactly once to the original anchor without blocking text pointer events', t => {
  const ui = fixture(t);
  const down = ui.down(), move = ui.move({clientX: 22}), up = ui.up({clientX: 22});
  assert.equal(down.defaultPrevented, false); assert.equal(move.defaultPrevented, false); assert.equal(up.defaultPrevented, false);
  ui.click({clientX: 22});
  assert.equal(ui.anchor.dispatched.length, 1);
  assert.equal(ui.anchor.dispatched[0].detail, 1);
  assert.equal(ui.container.classList.contains('link-hit-test'), false);
  assert.equal(ui.calls.length, 2);
});

test('a hyperlink drag selects natively and cannot activate even after returning to its origin', t => {
  const ui = fixture(t); ui.down(); ui.move({clientX: 45}); ui.move({clientX: 20}); ui.up();
  const click = ui.click();
  assert.equal(ui.anchor.dispatched.length, 0); assert.equal(click.defaultPrevented, false);
  assert.equal(ui.calls.length, 1, 'Pointer movement must not hit-test or measure geometry.');
});

test('maximum displacement of four pixels is tolerated but larger final displacement is a drag', t => {
  const ui = fixture(t); ui.down(); ui.up({clientX: 24}); ui.click({clientX: 24});
  assert.equal(ui.anchor.dispatched.length, 1);
  ui.down(); ui.up({clientX: 25}); ui.click({clientX: 25}); assert.equal(ui.anchor.dispatched.length, 1);
});

test('noncollapsed real selection suppresses activation, including subthreshold glyph selections', t => {
  const ui = fixture(t); ui.down(); ui.up(); ui.setSelection({isCollapsed: false}); ui.click();
  assert.equal(ui.anchor.dispatched.length, 0);
});

test('keyboard activation passes through unchanged without consuming a pointer selection', t => {
  const ui = fixture(t); ui.down();
  const key = ui.click({target: ui.anchor, detail: 0});
  assert.equal(key.defaultPrevented, false); assert.equal(key.stopped, false); assert.equal(ui.anchor.dispatched.length, 0);
  ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 1);
});

test('real original-anchor clicks are not relayed twice', t => {
  const ui = fixture(t); ui.down(); ui.up(); const event = ui.click({target: ui.anchor});
  assert.equal(event.defaultPrevented, false); assert.equal(ui.anchor.dispatched.length, 0);
});

test('stationary Ctrl and Meta primary clicks preserve modifiers for the existing link handler', t => {
  const ui = fixture(t);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    ui.down({[modifier]: true}); ui.up({[modifier]: true}); ui.click({[modifier]: true});
    assert.equal(ui.anchor.dispatched.at(-1)[modifier], true);
  }
  assert.equal(ui.anchor.dispatched.length, 2);
});

test('post-drag native anchor clicks are stopped before downstream navigation handlers', t => {
  const ui = fixture(t); let navigation = 0;
  ui.container.addEventListener('click', () => navigation++);
  ui.down(); ui.move({clientX: 50}); ui.up(); const event = ui.click({target: ui.anchor});
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true); assert.equal(navigation, 0);
});

test('browser hit-test delegates clipped-link gaps and occlusion instead of guessing rectangles', t => {
  const ui = fixture(t);
  ui.setHit(ui.text); ui.down(); ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
  ui.setHit(ui.excluded); ui.down(); ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
  ui.setHit(ui.anchor); ui.down(); ui.setHit(ui.text); ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
});

test('click must end on the same anchor and PDF page', t => {
  const ui = fixture(t); ui.down(); ui.setHit(ui.otherAnchor); ui.up(); ui.click();
  assert.equal(ui.anchor.dispatched.length, 0);
  ui.setHit(ui.anchor); ui.down(); ui.up(); ui.click({target: ui.otherText}); assert.equal(ui.anchor.dispatched.length, 0);
});

test('detached anchors, detached pages and disabled annotation layers cannot activate', t => {
  const ui = fixture(t);
  ui.down(); ui.up(); ui.anchor.isConnected = false; ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
  ui.anchor.isConnected = true; ui.down(); ui.up(); ui.page.isConnected = false; ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
  ui.page.isConnected = true; ui.annotations.classList.add('disabled'); ui.down(); ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
});

test('hit-test temporary class is restored on failure and pre-existing class ownership is preserved', t => {
  const ui = fixture(t); ui.setHitFailure(true); ui.down();
  assert.equal(ui.container.classList.contains('link-hit-test'), false);
  ui.container.classList.add('link-hit-test'); ui.down();
  assert.equal(ui.container.classList.contains('link-hit-test'), true);
  ui.container.classList.remove('link-hit-test');
});

test('region mode, dialogs, editable controls and non-primary pointer gestures are not intercepted', t => {
  const ui = fixture(t);
  ui.container.classList.add('region-mode'); ui.down(); ui.container.classList.remove('region-mode');
  ui.setDialog(true); ui.down(); ui.setDialog(false);
  ui.down({target: ui.excluded});
  for (const values of [{button: 1}, {isPrimary: false}, {pointerType: 'touch'}, {pointerType: 'pen'},
    {altKey: true}, {shiftKey: true}]) ui.down(values);
  assert.equal(ui.calls.length, 0); assert.equal(ui.anchor.dispatched.length, 0);
});

test('cancellation, blur, scrolling and viewer lifecycle events invalidate only activation', t => {
  const ui = fixture(t);
  const cancellations = [() => ui.doc.fire('pointercancel'), () => ui.win.fire('blur'),
    () => ui.container.fire('scroll'), ...['pagesdestroy', 'pagesinit', 'documentloaded', 'scalechanging',
      'rotationchanging', 'pagechanging', 'updateviewarea'].map(name => () => ui.eventBus.dispatch(name))];
  for (const cancel of cancellations) {
    ui.down(); cancel(); ui.up(); const click = ui.click();
    assert.equal(click.defaultPrevented, false); assert.equal(ui.anchor.dispatched.length, 0);
  }
});

test('unrelated pointer movement and pointer cancellation do not affect the active pointer', t => {
  const ui = fixture(t); ui.down(); ui.move({pointerId: 2, clientX: 300});
  ui.doc.fire('pointercancel', {pointerId: 2}); ui.doc.fire('pointerup', {pointerId: 2}); ui.up(); ui.click();
  assert.equal(ui.anchor.dispatched.length, 1);
});

test('only hyperlink-origin drag-out is cancelled and ordinary text dragging remains available', t => {
  const ui = fixture(t); const ordinary = ui.container.fire('dragstart', {target: ui.text});
  assert.equal(ordinary.defaultPrevented, false);
  ui.down(); const linked = ui.container.fire('dragstart', {target: ui.text});
  assert.equal(linked.defaultPrevented, true); ui.up(); ui.click(); assert.equal(ui.anchor.dispatched.length, 0);
});

test('dispose removes all listeners, active gesture tracking and its own CSS class idempotently', t => {
  const ui = fixture(t); ui.down(); assert.ok(ui.doc.handlers.get('pointermove')?.size);
  ui.controller.dispose(); ui.controller.dispose();
  assert.equal(ui.container.classList.contains('link-text-selection'), false);
  for (const item of ui.all) for (const handlers of item.handlers.values()) assert.equal(handlers.size, 0);
  for (const callbacks of ui.bus.values()) assert.equal(callbacks.size, 0);
  const calls = ui.calls.length; ui.down(); ui.up(); ui.click(); assert.equal(ui.calls.length, calls);
});
