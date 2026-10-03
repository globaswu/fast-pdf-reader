// PDF.js waits for a worker acknowledgement during destroy(). Share cleanup
// between overlapping stale/open paths and bound the wait for a failed worker.
const closing = new WeakMap();
export function closePdfWorker(task, worker, {timeoutMs = 1000} = {}) {
  if (!worker) { void task?.destroy().catch(() => {}); return Promise.resolve(); }
  if (closing.has(worker)) return closing.get(worker);
  const promise = (async () => {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => task?.destroy()).catch(() => {}),
        new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); worker.terminate(); }
  })();
  closing.set(worker, promise);
  return promise;
}
