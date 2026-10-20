/** Observe revisions without reopening the displayed PDF or reading its bytes. */
export function createDocumentVersionMonitor({
  readInfo, onChange = () => {}, isVisible = () => true,
  intervalMs = 5000, settleMs = 1500, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  const interval = Number.isFinite(intervalMs) ? Math.max(1, intervalMs) : 5000;
  const settle = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 1500;
  let documentInfo = null, wantsPoll = false, candidate = null;
  let epoch = 0, timer = null, active = null, disposed = false;
  let state = {status:'current', latestInfo:null, canPoll:false, reason:null};

  const snapshot = () => ({...state, latestInfo:state.latestInfo ? {...state.latestInfo} : null});
  function publish(changes) {
    state = {...state, ...changes};
    onChange(snapshot());
  }
  function cancelTimer() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }
  function schedule(delay = interval) {
    cancelTimer();
    if (disposed || !documentInfo || !state.canPoll) return;
    const scheduledEpoch = epoch;
    timer = setTimer(() => {
      timer = null;
      if (scheduledEpoch === epoch) void check();
    }, Math.max(1, delay));
  }
  function setDocument(info, {poll = false} = {}) {
    if (disposed) return snapshot();
    cancelTimer();
    epoch++;
    documentInfo = info ? {...info} : null;
    wantsPoll = Boolean(info && poll);
    candidate = null;
    publish({status:'current', latestInfo:documentInfo, canPoll:wantsPoll, reason:null});
    schedule();
    return snapshot();
  }
  function check() {
    if (disposed || !documentInfo || !state.canPoll) return Promise.resolve(snapshot());
    cancelTimer();
    if (!isVisible()) {
      schedule();
      return Promise.resolve(snapshot());
    }
    const requestEpoch = epoch;
    if (active) {
      // Wait for an old document's read as well: host reads never overlap.
      return active.epoch === requestEpoch ? active.promise : active.promise.then(
        () => requestEpoch === epoch ? check() : snapshot(),
      );
    }
    const job = {epoch:requestEpoch, promise:null};
    active = job;
    job.promise = Promise.resolve().then(async () => {
      if (disposed || requestEpoch !== epoch) return;
      try {
        const info = await readInfo();
        if (disposed || requestEpoch !== epoch) return;
        if (!info || typeof info.documentId !== 'string' || !info.documentId) {
          throw new Error('Invalid PDF metadata.');
        }
        if (info.documentId === documentInfo.documentId) {
          candidate = null;
          publish({status:'current', latestInfo:{...info}, reason:null});
        } else if (info.documentId === state.latestInfo?.documentId) {
          candidate = null;
          publish({status:'changed', latestInfo:{...info}, reason:null});
        } else {
          const observedAt = now();
          if (candidate?.documentId !== info.documentId) {
            candidate = {documentId:info.documentId, since:observedAt};
          } else if (observedAt - candidate.since >= settle) {
            candidate = null;
            publish({status:'changed', latestInfo:{...info}, reason:null});
            return;
          }
          // Only observed changes affect the notice. A still newer candidate
          // also disables opening until its metadata has settled.
          publish({status:'checking', reason:null});
        }
      } catch (error) {
        if (disposed || requestEpoch !== epoch) return;
        candidate = null;
        publish({
          status:'unavailable',
          canPoll:error?.code === 'PDF_ACCESS_DENIED' ? false : state.canPoll,
          reason:error?.message || String(error),
        });
      }
    }).finally(() => {
      if (active === job) active = null;
      if (!disposed && requestEpoch === epoch) {
        schedule(candidate ? Math.max(1, settle - (now() - candidate.since)) : interval);
      }
    }).then(snapshot);
    return job.promise;
  }
  function notify() {
    if (disposed || !documentInfo) return Promise.resolve(snapshot());
    if (wantsPoll) return check();
    publish({status:'changed', reason:null});
    return Promise.resolve(snapshot());
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    epoch++;
    cancelTimer();
    candidate = null;
    documentInfo = null;
    state = {status:'current', latestInfo:null, canPoll:false, reason:null};
  }
  return {setDocument, check, notify, dispose, snapshot};
}
