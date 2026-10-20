import {createLinkHover} from './link-hover.mjs';

// Link annotations are empty overlays above the selectable PDF text. Let the
// browser select that real text, then relay only an ordinary stationary click
// to PDF.js's original anchor. No PDF geometry or scrolling work is duplicated.
export function initializeLinkTextSelection({container, eventBus, createHover = createLinkHover}) {
  const doc = container.ownerDocument, win = doc.defaultView;
  const listeners = [], busListeners = [];
  const hadClass = container.classList.contains('link-text-selection');
  let gesture = null, relaying = false, disposed = false, tracking = false;
  const thresholdSquared = 4 * 4;
  const element = node => node?.nodeType === 3 ? node.parentElement : node;
  const pageOf = node => element(node)?.closest?.('.page');
  const targetAnchor = node => element(node)?.closest?.('.linkAnnotation > a[href]');
  const excluded = node => !!element(node)?.closest?.(
    'input, textarea, button, select, option, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="button"], .popupAnnotation, .popup, .annotationEditorLayer');
  const blocked = () => container.classList.contains('region-mode') || !!doc.querySelector('dialog[open]');
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    listeners.push(() => target.removeEventListener(name, callback, options));
  };
  const validAnchor = (anchor, page) => !!anchor?.isConnected && !!page?.isConnected &&
    container.contains(page) && pageOf(anchor) === page &&
    !!anchor.closest('.annotationLayer:not(.disabled)');

  function hitAnchor(x, y, page) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !page || !container.contains(page)) return null;
    const alreadyTesting = container.classList.contains('link-hit-test');
    try {
      // The browser applies clipPath/QuadPoints, page rotation and occlusion.
      // A bounding rectangle would incorrectly activate gaps in wrapped links.
      container.classList.add('link-hit-test');
      const hit = doc.elementFromPoint(x, y);
      if (!hit || excluded(hit)) return null;
      const anchor = targetAnchor(hit);
      return validAnchor(anchor, page) ? anchor : null;
    } catch {
      return null;
    } finally {
      if (!alreadyTesting) container.classList.remove('link-hit-test');
    }
  }

  function stopTracking() {
    if (!tracking) return;
    tracking = false;
    doc.removeEventListener('pointermove', onMove, true);
    doc.removeEventListener('pointerup', onUp, true);
  }
  function clear() { stopTracking(); gesture = null; }
  function cancel() {
    if (gesture) gesture.cancelled = true;
    stopTracking();
  }
  function noteMovement(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) { gesture.cancelled = true; return; }
    gesture.maxSquared = Math.max(gesture.maxSquared, dx * dx + dy * dy);
  }
  function onMove(event) { noteMovement(event); }
  function onUp(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    noteMovement(event); gesture.released = true; stopTracking();
  }
  function onDown(event) {
    clear();
    if (disposed || blocked() || excluded(event.target) || event.button !== 0 ||
        event.isPrimary === false || event.pointerType !== 'mouse' ||
        event.altKey || event.shiftKey) return;
    const page = pageOf(event.target);
    const anchor = hitAnchor(event.clientX, event.clientY, page);
    if (!anchor) return;
    gesture = {anchor, page, pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      maxSquared: 0, cancelled: false, released: false};
    tracking = true;
    doc.addEventListener('pointermove', onMove, {capture: true, passive: true});
    doc.addEventListener('pointerup', onUp, {capture: true, passive: true});
    // Do not cancel or capture this event: the real text layer must receive it.
  }
  function suppressAnchorClick(event) {
    if (!targetAnchor(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }
  function onClick(event) {
    // Native keyboard activation must retain PDF.js's own destination/actions.
    if (disposed || relaying || event.detail === 0) return;
    const completed = gesture; clear();
    if (!completed) return;
    const selection = doc.getSelection();
    if (completed.cancelled || !completed.released || completed.maxSquared > thresholdSquared ||
        event.button !== 0 || blocked() || excluded(event.target) ||
        (selection && !selection.isCollapsed) || pageOf(event.target) !== completed.page ||
        !validAnchor(completed.anchor, completed.page) ||
        hitAnchor(event.clientX, event.clientY, completed.page) !== completed.anchor) {
      suppressAnchorClick(event); return;
    }
    // If an existing caller already targeted the real anchor, allow it once.
    if (targetAnchor(event.target) === completed.anchor) return;
    event.preventDefault();
    relaying = true;
    try {
      completed.anchor.dispatchEvent(new win.MouseEvent('click', {
        bubbles: true, cancelable: true, composed: true, view: win, detail: 1, button: 0,
        clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      }));
    } finally { relaying = false; }
  }
  function onDragStart(event) {
    // Only block drag-out gestures that began on a PDF hyperlink; ordinary
    // text dragging elsewhere in the document keeps its normal behavior.
    if (!gesture || !container.contains(element(event.target))) return;
    event.preventDefault(); cancel();
  }
  function onPointerCancel(event) {
    if (gesture && event.pointerId === gesture.pointerId) cancel();
  }

  container.classList.add('link-text-selection');
  const hover = createHover({container,eventBus,hitAnchor,pageOf,blocked});
  listen(container, 'pointerdown', onDown, true);
  listen(container, 'click', onClick, true);
  listen(container, 'dragstart', onDragStart, true);
  listen(container, 'scroll', cancel, {passive: true});
  listen(doc, 'pointercancel', onPointerCancel, true);
  listen(win, 'blur', cancel);
  for (const name of ['pagesdestroy', 'pagesinit', 'documentloaded', 'scalechanging', 'rotationchanging', 'pagechanging', 'updateviewarea']) {
    eventBus.on(name, cancel); busListeners.push(() => eventBus.off(name, cancel));
  }
  return {
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true; clear();
      hover.dispose();
      for (const remove of [...listeners, ...busListeners]) remove();
      if (!hadClass) container.classList.remove('link-text-selection');
    },
  };
}
