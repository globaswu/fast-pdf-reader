// Audio stays in this page and the local transcription tool; no browser speech service.
export const DICTATION_SAMPLE_RATE = 16000;
export const DICTATION_MAX_SECONDS = 120;

// Piecewise-constant area resampling gives every source sample its proper weight,
// including non-integral input rates. State is retained across worklet blocks.
export class StreamingPcm16Encoder {
  constructor(inputRate, { targetRate = 16000, chunkSamples = 4096,
    maxSamples = 1920000, onChunk = () => {} } = {}) {
    if (!Number.isFinite(inputRate) || inputRate < 1 || !Number.isFinite(targetRate) || targetRate < 1
      || !Number.isInteger(chunkSamples) || chunkSamples < 1
      || !Number.isInteger(maxSamples) || maxSamples < 1) throw new TypeError('Invalid PCM encoder configuration.');
    this.ratio = inputRate / targetRate;
    this.chunkSamples = chunkSamples;
    this.maxSamples = maxSamples;
    this.onChunk = onChunk;
    this.chunk = new Int16Array(chunkSamples);
    this.used = 0;
    this.samples = 0;
    this.weight = 0;
    this.sum = 0;
    this.limited = false;
  }

  push(channels) {
    if (this.limited || !channels?.length || !channels[0]?.length) return;
    const length = Math.min(...channels.map(channel => channel.length));
    for (let i = 0; i < length && !this.limited; i += 1) {
      let mono = 0;
      for (const channel of channels) mono += Number.isFinite(channel[i]) ? channel[i] : 0;
      mono /= channels.length;
      let remaining = 1;
      while (remaining > 1e-9 && !this.limited) {
        const take = Math.min(remaining, this.ratio - this.weight);
        this.sum += mono * take;
        this.weight += take;
        remaining -= take;
        if (this.weight >= this.ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / this.ratio));
          this.chunk[this.used++] = Math.round(value * (value < 0 ? 32768 : 32767));
          this.samples += 1;
          this.weight = 0;
          this.sum = 0;
          if (this.used === this.chunkSamples || this.samples === this.maxSamples) this.flush();
          if (this.samples === this.maxSamples) this.limited = true;
        }
      }
    }
  }

  flush() {
    if (!this.used) return;
    const complete = this.chunk.slice(0, this.used);
    this.used = 0;
    this.onChunk(complete);
  }
}

export function dictationWorkletSource() {
  return `${StreamingPcm16Encoder.toString()}
class LocalDictationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.active = true;
    this.limitSent = false;
    this.encoder = new StreamingPcm16Encoder(sampleRate, {
      maxSamples: options.processorOptions.maxSamples,
      onChunk: pcm => this.port.postMessage({type: 'pcm', pcm: pcm.buffer}, [pcm.buffer])
    });
    this.port.onmessage = event => {
      if (event.data?.type !== 'flush') return;
      this.active = false;
      this.encoder.flush();
      this.port.postMessage({type: 'flushed'});
    };
  }
  process(inputs, outputs) {
    // The connected output is intentionally silent, preventing microphone echo.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.active) this.encoder.push(inputs[0]);
    if (this.encoder.limited && !this.limitSent) {
      this.limitSent = true;
      this.active = false;
      this.port.postMessage({type: 'limit'});
    }
    return true;
  }
}
registerProcessor('local-dictation-pcm', LocalDictationProcessor);`;
}

function recorderError(message, code) {
  return Object.assign(new Error(message), { code });
}

function aborted() {
  return Object.assign(new Error('Voice input was cancelled.'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function stopTracks(stream) {
  for (const track of stream?.getTracks?.() ?? []) {
    try { track.stop(); } catch { /* An already-ended track needs no action. */ }
  }
}

function pcmResult(chunks, samples, encode) {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const chunk of chunks) for (const sample of chunk) {
    view.setInt16(offset, sample, true);
    offset += 2;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return { pcmBase64: encode(binary), samples, seconds: samples / DICTATION_SAMPLE_RATE };
}

export function createPcmRecorder({ window: win = globalThis.window,
  document: doc = globalThis.document, maxSeconds = DICTATION_MAX_SECONDS,
  onLimit = () => {} } = {}) {
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0 || maxSeconds > DICTATION_MAX_SECONDS) {
    throw new TypeError('Voice input must last between 0 and 120 seconds.');
  }
  const maxSamples = Math.floor(maxSeconds * DICTATION_SAMPLE_RATE);
  if (maxSamples < 1) throw new TypeError('Voice input duration is too short.');
  let current = null;
  const schedule = (...args) => (win?.setTimeout ?? globalThis.setTimeout)(...args);
  const unschedule = id => (win?.clearTimeout ?? globalThis.clearTimeout)(id);

  async function teardown(session) {
    stopTracks(session.stream);
    session.stream = null;
    if (session.durationTimer) unschedule(session.durationTimer);
    session.durationTimer = null;
    session.signal?.removeEventListener('abort', session.abortListener);
    try { session.source?.disconnect(); } catch { /* Already disconnected. */ }
    try { session.node?.disconnect(); } catch { /* Already disconnected. */ }
    try { session.node?.port?.close(); } catch { /* Already closed. */ }
    if (session.node?.port) session.node.port.onmessage = null;
    const context = session.context;
    session.source = null;
    session.node = null;
    session.context = null;
    if (session.workletUrl) win.URL.revokeObjectURL(session.workletUrl);
    session.workletUrl = null;
    if (context && context.state !== 'closed') {
      try { await context.close(); } catch { /* Tracks have already been stopped. */ }
    }
  }

  function cancelSession(session) {
    if (!session || session.cancelled) return session?.cleanup ?? Promise.resolve();
    session.cancelled = true;
    session.rejectAbort?.(aborted());
    session.rejectFlush?.(aborted());
    session.chunks.length = 0;
    session.samples = 0;
    session.cleanup = teardown(session);
    return session.cleanup;
  }

  async function stopSession(session) {
    if (!session || session.cancelled) throw aborted();
    if (session.stopPromise) return session.stopPromise;
    if (!session.started) {
      await cancelSession(session);
      throw aborted();
    }
    session.stopPromise = (async () => {
      // Release the actual microphone immediately, before waiting for the worklet.
      stopTracks(session.stream);
      session.stream = null;
      if (session.durationTimer) unschedule(session.durationTimer);
      session.durationTimer = null;
      try {
        await new Promise((resolve, reject) => {
          const timer = schedule(() => reject(recorderError(
            'Audio capture did not finish cleanly. Please try recording again.', 'AUDIO_FLUSH_TIMEOUT')), 800);
          const finish = callback => value => {
            unschedule(timer);
            session.resolveFlush = null;
            session.rejectFlush = null;
            callback(value);
          };
          session.resolveFlush = finish(resolve);
          session.rejectFlush = finish(reject);
          session.node.port.postMessage({ type: 'flush' });
        });
        if (session.cancelled) throw aborted();
        const result = pcmResult(session.chunks, session.samples, session.encode);
        session.chunks.length = 0;
        return result;
      } finally {
        await teardown(session);
      }
    })();
    return session.stopPromise;
  }

  function reachedLimit(session) {
    if (session.limitNotified || session.cancelled) return;
    session.limitNotified = true;
    // Keep stopPromise for the controller to retrieve the bounded audio result.
    void stopSession(session).catch(() => {});
    try { onLimit(); } catch { /* A UI callback cannot keep the microphone open. */ }
  }

  async function start({ signal } = {}) {
    if (current && !current.cancelled && !current.stopPromise) {
      throw recorderError('Voice input is already running.', 'ALREADY_RECORDING');
    }
    if (signal?.aborted) throw aborted();
    const policy = doc?.permissionsPolicy ?? doc?.featurePolicy;
    if (typeof policy?.allowsFeature === 'function' && policy.allowsFeature('microphone') === false) {
      throw recorderError('This reader is not allowed to access the microphone. Reopen Codex after enabling the reader microphone compatibility patch.', 'MICROPHONE_POLICY_DENIED');
    }
    const AudioContextClass = win?.AudioContext ?? win?.webkitAudioContext;
    if (!win?.navigator?.mediaDevices?.getUserMedia || !AudioContextClass || !win?.AudioWorkletNode
      || !win?.URL?.createObjectURL || !win?.Blob || typeof win?.btoa !== 'function') {
      throw recorderError('Microphone capture is unavailable in this reader.', 'MICROPHONE_UNAVAILABLE');
    }
    const session = { chunks: [], samples: 0, signal, started: false, cancelled: false,
      encode: value => win.btoa(value) };
    current = session;
    const abortPromise = new Promise((resolve, reject) => { session.rejectAbort = reject; });
    // A later abort during recording must not create an unhandled rejection.
    void abortPromise.catch(() => {});
    session.abortListener = () => { void cancelSession(session); };
    signal?.addEventListener('abort', session.abortListener, { once: true });
    const check = () => { if (session.cancelled || signal?.aborted) throw aborted(); };
    try {
      check();
      const mediaPromise = win.navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      session.stream = await Promise.race([Promise.resolve(mediaPromise).then(stream => {
        if (session.cancelled || signal?.aborted) { stopTracks(stream); throw aborted(); }
        return stream;
      }), abortPromise]);
      check();
      session.context = new AudioContextClass();
      if (!session.context.audioWorklet?.addModule) throw recorderError('Audio worklets are unavailable in this reader.', 'MICROPHONE_UNAVAILABLE');
      session.workletUrl = win.URL.createObjectURL(new win.Blob([dictationWorkletSource()], { type: 'text/javascript' }));
      await Promise.race([session.context.audioWorklet.addModule(session.workletUrl), abortPromise]);
      check();
      session.node = new win.AudioWorkletNode(session.context, 'local-dictation-pcm', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { maxSamples },
      });
      session.node.port.onmessage = event => {
        if (session.cancelled) return;
        const data = event.data;
        if (data?.type === 'pcm' && data.pcm instanceof ArrayBuffer && data.pcm.byteLength % 2 === 0) {
          const remaining = maxSamples - session.samples;
          const chunk = new Int16Array(data.pcm).slice(0, remaining);
          if (chunk.length) { session.chunks.push(chunk); session.samples += chunk.length; }
        } else if (data?.type === 'flushed') session.resolveFlush?.();
        else if (data?.type === 'limit') reachedLimit(session);
      };
      session.source = session.context.createMediaStreamSource(session.stream);
      await Promise.race([session.context.resume(), abortPromise]);
      check();
      session.started = true;
      session.source.connect(session.node);
      session.node.connect(session.context.destination);
      session.durationTimer = schedule(() => reachedLimit(session), maxSeconds * 1000);
    } catch (error) {
      await cancelSession(session);
      throw error;
    }
  }

  return {
    start,
    stop: () => stopSession(current),
    cancel: () => cancelSession(current),
  };
}
