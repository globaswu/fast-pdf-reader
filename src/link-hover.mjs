// Link overlays do not receive pointer events while text selection is enabled.
// Reuse the browser's existing annotation hit test for hover feedback only.
export function createLinkHover({container, eventBus, hitAnchor, pageOf, blocked = () => false}) {
  const doc = container.ownerDocument, win = doc.defaultView;
  const removers = [], busRemovers = [];
  const badge = doc.createElement('div');
  badge.id = 'pdf-link-destination';
  badge.hidden = true;
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-live', 'off');
  container.parentElement.append(badge);
  let disposed = false, frame = null, pending = null, generation = 0;
  let annotation = null, ownsAnnotationClass = false, ownsContainerClass = false;
  const listen = (target, name, callback, options) => {
    target.addEventListener(name, callback, options);
    removers.push(() => target.removeEventListener(name, callback, options));
  };
  const labelText = value => String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().slice(0, 2048);
  function destination(anchor) {
    const raw = anchor.getAttribute('href') || '';
    if (raw.startsWith('#') || anchor.classList.contains('internalLink') || anchor.closest('[data-internal-link]')) {
      const title = labelText(anchor.getAttribute('title'));
      if (title) return title;
      const page = raw.match(/(?:^#|&)page=(\d+)(?:&|$)/i)?.[1];
      return page ? `Go to page ${page}` : 'Internal PDF link';
    }
    return labelText(anchor.href || raw);
  }
  function hide() {
    if (annotation && ownsAnnotationClass) annotation.classList.remove('is-link-hovered');
    if (ownsContainerClass) container.classList.remove('link-hovering');
    annotation = null; ownsAnnotationClass = false; ownsContainerClass = false;
    badge.hidden = true;
    if (badge.textContent) badge.textContent = '';
  }
  function clear() {
    generation++;
    if (frame !== null) win.cancelAnimationFrame(frame);
    frame = null; pending = null; hide();
  }
  function show(anchor) {
    const next = anchor?.closest?.('.linkAnnotation');
    const label = anchor ? destination(anchor) : '';
    if (!next || !next.isConnected || !container.contains(next) || !label) { hide(); return; }
    if (annotation !== next) {
      hide(); annotation = next;
      ownsAnnotationClass = !annotation.classList.contains('is-link-hovered');
      annotation.classList.add('is-link-hovered');
      ownsContainerClass = !container.classList.contains('link-hovering');
      container.classList.add('link-hovering');
    }
    if (badge.textContent !== label) badge.textContent = label;
    badge.hidden = false;
  }
  function onPointer(event) {
    if (disposed) return;
    if (event.pointerType !== 'mouse' || event.buttons !== 0 || event.isPrimary === false || blocked()) {
      clear(); return;
    }
    const page = pageOf(event.target);
    if (!page?.isConnected || !container.contains(page) ||
        !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) { clear(); return; }
    pending = {page, x: event.clientX, y: event.clientY};
    if (frame !== null) return;
    const scheduledGeneration = generation;
    frame = win.requestAnimationFrame(() => {
      if (disposed || scheduledGeneration !== generation) return;
      frame = null;
      const point = pending; pending = null;
      if (!point?.page.isConnected || !container.contains(point.page) || blocked() || doc.hidden) {
        hide(); return;
      }
      // The injected hit test respects QuadPoints, clipping and occlusion.
      // There is no independent geometry cache, layout scan or idle loop.
      try { show(hitAnchor(point.x, point.y, point.page)); } catch { hide(); }
    });
  }
  function onSelection() { if (doc.getSelection?.()?.isCollapsed === false) clear(); }
  function onVisibility() { if (doc.hidden) clear(); }
  listen(container, 'pointermove', onPointer, {passive: true});
  listen(container, 'pointerover', onPointer, {passive: true});
  listen(container, 'pointerleave', clear, {passive: true});
  listen(doc, 'pointerdown', clear, {capture: true, passive: true});
  listen(doc, 'pointercancel', clear, {capture: true, passive: true});
  listen(container, 'scroll', clear, {passive: true});
  listen(win, 'blur', clear);
  listen(win, 'resize', clear, {passive: true});
  listen(doc, 'selectionchange', onSelection);
  listen(doc, 'visibilitychange', onVisibility);
  for (const name of ['pagesdestroy', 'pagesinit', 'documentloaded', 'scalechanging', 'rotationchanging', 'pagechanging', 'updateviewarea']) {
    eventBus.on(name, clear); busRemovers.push(() => eventBus.off(name, clear));
  }
  return {
    clear,
    dispose() {
      if (disposed) return;
      disposed = true; clear();
      for (const remove of [...removers, ...busRemovers]) remove();
      badge.remove();
    },
  };
}
