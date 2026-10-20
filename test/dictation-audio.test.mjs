import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createPcmRecorder, StreamingPcm16Encoder, dictationWorkletSource } from '../src/dictation-audio.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mockEnvironment({ policy = true, mediaDeferred = null, workletFailure = null,
  noFlush = false, addModuleDeferred = null, fastFlushTimeout = false } = {}) {
  const counts = { getUserMedia: 0, stopped: 0, closed: 0, revoked: 0, disconnected: 0, connected: 0 };
  const stream = { getTracks: () => [{ stop() { counts.stopped += 1; } }] };
  let node;
  class AudioContext {
    state = 'running';
    destination = {};
    audioWorklet = { addModule: async () => {
      if (workletFailure) throw workletFailure;
      if (addModuleDeferred) await addModuleDeferred.promise;
    } };
    createMediaStreamSource() {
      return { connect() { counts.connected += 1; }, disconnect() { counts.disconnected += 1; } };
    }
    async resume() {}
    async close() { this.state = 'closed'; counts.closed += 1; }
  }
  class AudioWorkletNode {
    constructor(context, name, options) {
      node = this;
      this.options = options;
      this.port = {
        onmessage: null,
        postMessage: data => {
          if (data.type === 'flush' && !noFlush) queueMicrotask(() => {
            this.emit({ type: 'pcm', pcm: new Int16Array([7, -8]).buffer });
            this.emit({ type: 'flushed' });
          });
        },
        close() {},
      };
    }
    emit(data) { this.port.onmessage?.({ data }); }
    connect() { counts.connected += 1; }
    disconnect() { counts.disconnected += 1; }
  }
  const window = {
    navigator: { mediaDevices: { getUserMedia: async () => {
      counts.getUserMedia += 1;
      return mediaDeferred ? mediaDeferred.promise : stream;
    } } },
    AudioContext, AudioWorkletNode, Blob,
    URL: { createObjectURL: () => 'blob:unit-test', revokeObjectURL: () => { counts.revoked += 1; } },
    btoa: data => Buffer.from(data, 'binary').toString('base64'),
    setTimeout: (fn, ms) => setTimeout(fn, fastFlushTimeout && ms === 800 ? 5 : ms),
    clearTimeout,
  };
  const document = { permissionsPolicy: { allowsFeature: name => name === 'microphone' && policy } };
  return { window, document, counts, stream, node: () => node };
}

test('recorder construction never requests microphone access', () => {
  const env = mockEnvironment();
  createPcmRecorder(env);
  assert.equal(env.counts.getUserMedia, 0);
});

test('explicit microphone policy denial does not request capture', async () => {
  const env = mockEnvironment({ policy: false });
  await assert.rejects(createPcmRecorder(env).start(), { code: 'MICROPHONE_POLICY_DENIED' });
  assert.equal(env.counts.getUserMedia, 0);
});

test('absent policy is not treated as explicit denial; absent capture API fails clearly', async () => {
  const env = mockEnvironment();
  delete env.document.permissionsPolicy;
  const recorder = createPcmRecorder(env);
  await recorder.start();
  await recorder.cancel();
  delete env.window.AudioWorkletNode;
  await assert.rejects(createPcmRecorder(env).start(), { code: 'MICROPHONE_UNAVAILABLE' });
});

test('encoder mixes channels, clips safely, and preserves the exact sample cap', () => {
  const chunks = [];
  const encoder = new StreamingPcm16Encoder(16000, { maxSamples: 4, chunkSamples: 3, onChunk: chunk => chunks.push(...chunk) });
  encoder.push([Float32Array.from([1, -1, 2, 0, 0.4]), Float32Array.from([0, -1, 2, 0, 0.4])]);
  encoder.flush();
  assert.deepEqual(chunks, [16384, -32768, 32767, 0]);
  assert.equal(encoder.limited, true);
});

test('48k to 16k encoder uses all samples rather than every third sample', () => {
  const chunks = [];
  const encoder = new StreamingPcm16Encoder(48000, { onChunk: chunk => chunks.push(...chunk) });
  encoder.push([Float32Array.from([1, 0, -1, 0.6, 0.6, 0.6])]);
  encoder.flush();
  assert.deepEqual(chunks, [0, 19660]);
});

test('44.1k resampling is invariant to worklet block boundaries', () => {
  const values = Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 15) / 2);
  const encode = size => {
    const output = [];
    const encoder = new StreamingPcm16Encoder(44100, { onChunk: chunk => output.push(...chunk) });
    for (let i = 0; i < values.length; i += size) encoder.push([values.subarray(i, i + size)]);
    encoder.flush();
    return output;
  };
  const a = encode(128);
  assert.equal(a.length, 16000);
  assert.deepEqual(a, encode(397));
});

test('worklet source is self contained, flushes pending samples, and sends one limit', () => {
  let Processor;
  const sent = [];
  class Base { port = { postMessage: data => sent.push(data), onmessage: null }; }
  vm.runInNewContext(dictationWorkletSource(), {
    AudioWorkletProcessor: Base, sampleRate: 16000,
    registerProcessor: (name, value) => { Processor = value; },
  });
  const processor = new Processor({ processorOptions: { maxSamples: 3 } });
  const silent = new Float32Array([1, 1, 1]);
  processor.process([[new Float32Array([0.2, 0.3, 0.4, 0.5])]], [[silent]]);
  processor.process([[new Float32Array([0.5])]], [[silent]]);
  processor.port.onmessage({ data: { type: 'flush' } });
  assert.deepEqual([...silent], [0, 0, 0]);
  assert.deepEqual(sent.map(item => item.type), ['pcm', 'limit', 'flushed']);
  assert.equal(sent[0].pcm.byteLength, 6);
});

test('stop flushes the final worklet block and encodes little-endian PCM once', async () => {
  const env = mockEnvironment();
  const recorder = createPcmRecorder(env);
  await recorder.start();
  env.node().emit({ type: 'pcm', pcm: new Int16Array([32767, -32768]).buffer });
  const result = await recorder.stop();
  assert.equal(result.samples, 4);
  assert.deepEqual([...Buffer.from(result.pcmBase64, 'base64')], [255, 127, 0, 128, 7, 0, 248, 255]);
  assert.deepEqual(await recorder.stop(), result);
  assert.equal(env.counts.stopped, 1);
  assert.equal(env.counts.closed, 1);
  assert.equal(env.counts.revoked, 1);
});

test('cancellation while permission is pending promptly aborts and stops a late stream', async () => {
  const pending = deferred();
  const env = mockEnvironment({ mediaDeferred: pending });
  const recorder = createPcmRecorder(env);
  const starting = recorder.start();
  await recorder.cancel();
  await assert.rejects(starting, { name: 'AbortError' });
  pending.resolve(env.stream);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.counts.stopped, 1);
  assert.equal(env.counts.connected, 0);
});

test('abort during worklet module loading releases microphone and URL', async () => {
  const pending = deferred();
  const env = mockEnvironment({ addModuleDeferred: pending });
  const controller = new AbortController();
  const recorder = createPcmRecorder(env);
  const starting = recorder.start({ signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(starting, { name: 'AbortError' });
  pending.resolve();
  assert.equal(env.counts.stopped, 1);
  assert.equal(env.counts.closed, 1);
  assert.equal(env.counts.revoked, 1);
});

test('worklet initialization failure releases microphone and reports original failure', async () => {
  const env = mockEnvironment({ workletFailure: new Error('Test worklet failure') });
  await assert.rejects(createPcmRecorder(env).start(), /Test worklet failure/);
  assert.equal(env.counts.stopped, 1);
  assert.equal(env.counts.closed, 1);
  assert.equal(env.counts.revoked, 1);
});

test('limit stops hardware automatically and preserves audio for the controller', async () => {
  const env = mockEnvironment();
  let reached = 0;
  const recorder = createPcmRecorder({ ...env, maxSeconds: 0.001, onLimit: () => { reached += 1; } });
  await recorder.start();
  env.node().emit({ type: 'pcm', pcm: new Int16Array(100).fill(42).buffer });
  env.node().emit({ type: 'limit' });
  env.node().emit({ type: 'limit' });
  const result = await recorder.stop();
  assert.equal(result.samples, 16);
  assert.equal(reached, 1);
  assert.equal(env.counts.stopped, 1);
});

test('missing flush acknowledgement fails rather than silently truncating audio', async () => {
  const env = mockEnvironment({ noFlush: true, fastFlushTimeout: true });
  const recorder = createPcmRecorder(env);
  await recorder.start();
  await assert.rejects(recorder.stop(), { code: 'AUDIO_FLUSH_TIMEOUT' });
  assert.equal(env.counts.stopped, 1);
  assert.equal(env.counts.closed, 1);
});

test('cancelling during stop discards queued audio and aborts the result', async () => {
  const env = mockEnvironment({ noFlush: true });
  const recorder = createPcmRecorder(env);
  await recorder.start();
  const stopping = recorder.stop();
  await recorder.cancel();
  await assert.rejects(stopping, { name: 'AbortError' });
  assert.equal(env.counts.stopped, 1);
});
