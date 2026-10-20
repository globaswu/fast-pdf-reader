import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNativeDictationBackend, __testing } from '../native-recorder.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fakeChild() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.commands = []; child.stdin.on('data', data => { for (const line of String(data).trim().split('\n')) if (line) child.commands.push(JSON.parse(line)); });
  child.killCount = 0; child.kill = () => { child.killCount++; queueMicrotask(() => child.emit('close', null)); return true; };
  child.event = value => child.stdout.write(JSON.stringify(value) + '\n'); return child;
}
function fixture(t, overrides = {}) {
  let time = 10000, tick;
  const children = [], spawned = [], calls = [], verified = [];
  const backend = createNativeDictationBackend({
    platform: 'win32', helperPath: '/owned/SmoothPdfRecorder.exe', now: () => time,
    setIntervalFn: fn => { tick = fn; return { unref() {} }; }, clearIntervalFn() {},
    spawn: (...args) => { spawned.push(args); const child = fakeChild(); children.push(child); return child; },
    verifyHelper: async (name, opts) => { verified.push([name, opts]); return name; },
    dictation: { info: async () => ({ available: true }), transcribe: async (...args) => { calls.push(args); return { text: 'Please revise this sentence.', language: 'en' }; } },
    ...overrides,
  });
  t.after(() => backend.dispose());
  return { backend, children, spawned, calls, verified, advance(ms) { time += ms; tick(); }, async begin() {
    const response = await backend.start({ requestId: randomUUID() }); const child = children.at(-1);
    child.event({ event: 'ready', protocolVersion: 1, interactionMode: 'inline-only' });
    return { response, child, sessionId: response.sessionId };
  } };
}
const pcm = Buffer.from([0, 1, 2, 3]).toString('base64');

test('info does not launch recorder, verifies metadata only, and returns no private paths', async t => {
  const f = fixture(t); const value = await f.backend.info();
  assert.deepEqual(value, { local: true, engine: 'whisper.cpp', maxSeconds: 120, available: true,
    activation: 'explicit-inline-button', requiresNativeConsent: false, defaultEnabled: true });
  assert.equal(f.children.length, 0); assert.equal(f.verified[0][1].verify, false);
});
test('explicit start verifies helper hash and launches hidden helper without requiring a native popup', async t => {
  const f = fixture(t); const { response, child, sessionId } = await f.begin();
  assert.equal(response.state, 'starting'); assert.equal(response.sessionId.length, 43);
  assert.equal(f.verified[0][1].verify, true);
  assert.equal(f.spawned[0][0], '/owned/SmoothPdfRecorder.exe');
  assert.deepEqual(f.spawned[0][1], ['--parent-pid', String(process.pid)]);
  assert.equal(f.spawned[0][2].windowsHide, true); assert.equal(f.spawned[0][2].shell, false);
  assert.deepEqual(child.commands, [{ op: 'start', sessionId }]);
  assert.equal((await f.backend.status({ sessionId })).state, 'starting');
  assert.equal(f.calls.length, 0);
  child.event({ event: 'recording', sessionId }); assert.equal((await f.backend.status({ sessionId })).state, 'recording');
});
test('request keys are idempotent and an overlapping reader cannot control or start capture', async t => {
  const f = fixture(t); const requestId = randomUUID();
  const first = await f.backend.start({ requestId }); const second = await f.backend.start({ requestId });
  assert.equal(first.sessionId, second.sessionId); assert.equal(f.children.length, 1);
  await assert.rejects(f.backend.start({ requestId: randomUUID() }), { code: 'DICTATION_BUSY' });
  await assert.rejects(f.backend.stop({ sessionId: 'x'.repeat(43) }), { code: 'INVALID_DICTATION_SESSION' });
  await assert.rejects(f.backend.heartbeat({ sessionId: '../bad' }), { code: 'INVALID_DICTATION_SESSION' });
  await assert.rejects(f.backend.start({ requestId: 'not a UUID' }), { code: 'INVALID_DICTATION_REQUEST' });
});
test('native recorder audio stays internal and stop returns before transcription finishes', async t => {
  let resolveTranscript, input, aborted;
  const f = fixture(t, { dictation: { info: async () => ({ available: true }), transcribe: (value, options) => {
    input = value; aborted = options.signal; return new Promise(resolve => { resolveTranscript = resolve; });
  } } });
  const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  assert.equal((await f.backend.stop({ sessionId })).state, 'stopping');
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2, seconds: 2 / 16000 });
  const during = await f.backend.status({ sessionId }); assert.equal(during.state, 'transcribing');
  assert.equal(JSON.stringify(during).includes('pcmBase64'), false); assert.equal(input.pcmBase64, pcm);
  resolveTranscript({ text: 'hello', language: 'en' }); await flush();
  const result = await f.backend.status({ sessionId }); assert.equal(result.state, 'complete'); assert.equal(result.text, 'hello');
  assert.equal(aborted.aborted, true);
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 });
  assert.equal((await f.backend.status({ sessionId })).text, 'hello');
});
test('automatic max-duration stopped event transcribes once only for the live owner', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 });
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 }); await flush();
  assert.equal(f.calls.length, 1); assert.equal((await f.backend.status({ sessionId })).state, 'complete');
});
test('short native capture before queued recording notification still transcribes the explicitly started session', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin();
  assert.equal((await f.backend.status({ sessionId })).state, 'starting');
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 }); await flush();
  assert.equal((await f.backend.status({ sessionId })).state, 'complete'); assert.equal(f.calls.length, 1);
  child.event({ event: 'recording', sessionId }); assert.equal((await f.backend.status({ sessionId })).state, 'complete');
});
test('frontend Stop before native recording notification cancels instead of accepting late audio', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin();
  assert.equal((await f.backend.stop({ sessionId })).state, 'cancelled');
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 }); await flush();
  assert.equal(f.calls.length, 0); assert.equal((await f.backend.status({ sessionId })).state, 'cancelled');
});
test('status polling cannot keep an abandoned microphone alive; only heartbeat renews 8-second lease', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  f.advance(7000); assert.equal((await f.backend.status({ sessionId })).state, 'recording');
  await f.backend.heartbeat({ sessionId }); assert.equal(child.commands.at(-1).op, 'heartbeat');
  f.advance(7000); assert.equal((await f.backend.status({ sessionId })).state, 'recording');
  f.advance(1000); const value = await f.backend.status({ sessionId });
  assert.equal(value.state, 'cancelled'); assert.equal(value.code, 'DICTATION_LEASE_EXPIRED');
  assert.equal(child.commands.at(-1).op, 'cancel');
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 }); await flush(); assert.equal(f.calls.length, 0);
});
test('cancel during pending start validation prevents helper spawn', async t => {
  let verified; const f = fixture(t, { verifyHelper: () => new Promise(resolve => { verified = resolve; }) });
  const requestId = randomUUID(); const pending = f.backend.start({ requestId });
  assert.equal((await f.backend.cancel({ requestId })).state, 'cancelled');
  verified('/owned/SmoothPdfRecorder.exe'); const result = await pending;
  assert.equal(result.state, 'cancelled'); assert.equal(f.children.length, 0);
});
test('cancellation tombstone prevents out-of-order start request from recording', async t => {
  const f = fixture(t); const requestId = randomUUID(); await f.backend.cancel({ requestId });
  await assert.rejects(f.backend.start({ requestId }), { code: 'DICTATION_CANCELLED' });
  assert.equal(f.children.length, 0);
});
test('cancel aborts owned recognition and never accepts its stale transcript', async t => {
  let signal, resolveTranscript;
  const f = fixture(t, { dictation: { info: async () => ({ available: true }), transcribe: (_, options) => {
    signal = options.signal; return new Promise(resolve => { resolveTranscript = resolve; });
  } } });
  const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 });
  await f.backend.cancel({ sessionId }); assert.equal(signal.aborted, true);
  resolveTranscript({ text: 'secret stale transcript', language: 'en' }); await flush();
  const result = await f.backend.status({ sessionId }); assert.equal(result.state, 'cancelled'); assert.equal('text' in result, false);
});
test('native process exit aborts capture, hides raw diagnostic details and permits fresh session', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.stderr.write('PRIVATE PATH AND USER AUDIO'); child.emit('close', 3);
  const value = await f.backend.status({ sessionId }); assert.equal(value.state, 'error');
  assert.equal(JSON.stringify(value).includes('PRIVATE'), false);
  await f.backend.start({ requestId: randomUUID() }); assert.equal(f.children.length, 2);
});
test('malformed native PCM is rejected without recognition and native output is bounded', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.event({ event: 'stopped', sessionId, pcmBase64: 'AA==', samples: 1 });
  assert.equal((await f.backend.status({ sessionId })).state, 'error'); assert.equal(f.calls.length, 0); assert.equal(child.killCount, 1);
  await f.backend.start({ requestId: randomUUID() }); const other = f.children.at(-1);
  other.stdout.write('x'.repeat(6 * 1024 * 1024 + 1)); assert.equal(other.killCount, 1);
});
test('wrong-session native events cannot insert audio or change state', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin();
  child.event({ event: 'recording', sessionId: 'x'.repeat(43) });
  child.event({ event: 'stopped', sessionId: 'x'.repeat(43), pcmBase64: pcm, samples: 2 });
  assert.equal((await f.backend.status({ sessionId })).state, 'starting'); assert.equal(f.calls.length, 0);
});
test('empty capture produces empty transcript without invoking recognizer', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.event({ event: 'stopped', sessionId, pcmBase64: '', samples: 0 }); await flush();
  const value = await f.backend.status({ sessionId }); assert.equal(value.state, 'complete'); assert.equal(value.empty, true); assert.equal(f.calls.length, 0);
});
test('terminal transcripts expire after two minutes and explicit cancellation erases them', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  child.event({ event: 'stopped', sessionId, pcmBase64: pcm, samples: 2 }); await flush();
  assert.equal((await f.backend.status({ sessionId })).text, 'Please revise this sentence.');
  await f.backend.cancel({ sessionId }); assert.equal('text' in await f.backend.status({ sessionId }), false);
  f.advance(120000); await assert.rejects(f.backend.status({ sessionId }), { code: 'INVALID_DICTATION_SESSION' });
});
test('one helper is reused only after prior session is terminal; dispose cancels and closes it', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); await f.backend.cancel({ sessionId });
  await assert.rejects(f.backend.start({ requestId: randomUUID() }), { code: 'DICTATION_BUSY' });
  child.event({ event: 'cancelled', sessionId });
  const second = await f.backend.start({ requestId: randomUUID() }); assert.equal(f.children.length, 1);
  assert.deepEqual(child.commands.at(-1), { op: 'start', sessionId: second.sessionId });
  f.backend.dispose(); assert.equal(child.killCount, 1); assert.equal(child.commands.at(-1).op, 'shutdown');
  await assert.rejects(f.backend.start({ requestId: randomUUID() }), { code: 'DICTATION_DISPOSED' });
});
test('Windows permission refusal is reported without retrying or exposing native error data', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin();
  child.event({ event: 'error', sessionId, code: 'MICROPHONE_DENIED', message: 'unsafe native detail' });
  const result = await f.backend.status({ sessionId });
  assert.equal(result.state, 'error'); assert.equal(result.code, 'DICTATION_PERMISSION_DENIED');
  assert.equal(result.message.includes('Windows'), true); assert.equal(JSON.stringify(result).includes('unsafe'), false);
  assert.equal(f.children.length, 1); assert.equal(f.calls.length, 0);
});
test('legacy ready is rejected before any start command can open a native popup', async t => {
  const f = fixture(t); const { sessionId } = await f.backend.start({ requestId: randomUUID() });
  const child = f.children[0]; child.event({ event: 'ready', protocolVersion: 1 });
  const result = await f.backend.status({ sessionId });
  assert.equal(result.state, 'error'); assert.equal(result.code, 'DICTATION_RECORDER_UPDATE_REQUIRED');
  assert.equal(child.commands.length, 0); assert.equal(child.killCount, 1); assert.equal(f.calls.length, 0);
});
test('unexpected legacy consent event cancels and terminates only the owned helper', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin();
  child.event({ event: 'consent', sessionId }); const result = await f.backend.status({ sessionId });
  assert.equal(result.state, 'error'); assert.equal(result.code, 'DICTATION_RECORDER_UPDATE_REQUIRED');
  assert.deepEqual(child.commands.at(-1), { op: 'cancel', sessionId });
  assert.equal(child.killCount, 1); assert.equal(f.calls.length, 0);
  child.event({ event: 'recording', sessionId }); assert.equal((await f.backend.status({ sessionId })).state, 'error');
});
test('a recorder that fails to stop after cancellation is terminated without affecting unrelated processes', async t => {
  const f = fixture(t); const { child, sessionId } = await f.begin(); child.event({ event: 'recording', sessionId });
  await f.backend.cancel({ sessionId }); assert.equal(child.killCount, 0);
  f.advance(2000); assert.equal(child.killCount, 1);
  assert.equal((await f.backend.status({ sessionId })).state, 'cancelled');
});
test('unavailable or unverified runtime never launches microphone helper', async t => {
  const f = fixture(t, { verifyHelper: async () => { throw new Error('C:/private/secret'); } });
  const info = await f.backend.info(); assert.equal(info.available, false); assert.equal(info.reason.includes('private'), false);
  const result = await f.backend.start({ requestId: randomUUID() }); assert.equal(result.state, 'error'); assert.equal(f.children.length, 0);
});
test('tool abort before helper launch cancels the owned session', async t => {
  const controller = new AbortController(); let verified;
  const f = fixture(t, { verifyHelper: () => new Promise(resolve => { verified = resolve; }) });
  const pending = f.backend.start({ requestId: randomUUID() }, { signal: controller.signal }); controller.abort(); verified('/owned/SmoothPdfRecorder.exe');
  assert.equal((await pending).state, 'cancelled'); assert.equal(f.children.length, 0);
});
test('packaged helper rejects changed binary and only resolves exact manifest executable', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'native-recorder-unit-'));
  const executable = path.join(dir, 'SmoothPdfRecorder.exe'), manifestFile = path.join(dir, 'recorder-manifest.json');
  t.after(async () => { for (const name of [executable, manifestFile]) try { await unlink(name); } catch {} await rmdir(dir); });
  const bytes = Buffer.from('synthetic executable, never launched');
  const manifest = { schemaVersion: 1, protocolVersion: 1, executable: 'SmoothPdfRecorder.exe', bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256: '0'.repeat(64),
    activation: 'explicit-inline-button', requiresNativeConsent: false, interactionMode: 'inline-only', nativeWindows: false,
    startsOnlyOnExplicitCommand: true };
  await writeFile(executable, bytes); await writeFile(manifestFile, JSON.stringify(manifest));
  assert.equal(await __testing.verifyPackagedHelper(executable), executable);
  await writeFile(manifestFile, JSON.stringify({ ...manifest, requiresNativeConsent: true }));
  await assert.rejects(__testing.verifyPackagedHelper(executable), { code: 'DICTATION_RECORDER_UPDATE_REQUIRED' });
  await writeFile(manifestFile, JSON.stringify(manifest));
  await writeFile(executable, Buffer.alloc(bytes.length));
  await assert.rejects(__testing.verifyPackagedHelper(executable), { code: 'DICTATION_RECORDER_UNAVAILABLE' });
  await assert.rejects(__testing.verifyPackagedHelper(path.join(dir, 'other.exe')), { code: 'DICTATION_RECORDER_UNAVAILABLE' });
});
