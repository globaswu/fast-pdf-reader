import childProcess from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StringDecoder } from 'node:string_decoder';
import { createLocalDictationBackend, MAX_DICTATION_SECONDS, MAX_PCM_BYTES } from './local-dictation.mjs';

const DEFAULT_HELPER = fileURLToPath(new URL('./native-recorder/bin/SmoothPdfRecorder.exe', import.meta.url));
const LEASE_MS = 8000;
const RESULT_TTL_MS = 120000;
const MAX_LINE_BYTES = 6 * 1024 * 1024;
const REQUEST_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['complete', 'cancelled', 'error']);
const SAFE_ERRORS = Object.freeze({
  DICTATION_CANCELLED: 'Dictation was cancelled.',
  DICTATION_LEASE_EXPIRED: 'Recording stopped because the reader connection was lost.',
  DICTATION_UNAVAILABLE: 'Local voice recognition is not installed or needs repair.',
  DICTATION_RECORDER_UNAVAILABLE: 'The local microphone recorder is unavailable or needs repair.',
  DICTATION_RECORDER_UPDATE_REQUIRED: 'The local recorder needs an update for inline-only dictation. Reopen the updated reader and try again.',
  DICTATION_RECORDER_FAILED: 'The local microphone recorder stopped unexpectedly.',
  DICTATION_PERMISSION_DENIED: 'Microphone access was not granted. Check Windows microphone privacy settings.',
  DICTATION_NO_MICROPHONE: 'No recording device is available. Connect or enable a microphone and try again.',
  DICTATION_AUDIO_FORMAT_UNSUPPORTED: 'The microphone audio format is unsupported. Try another default recording device.',
  DICTATION_START_FAILED: 'The local recorder could not start. Check the microphone and try again.',
  DICTATION_FAILED: 'Local transcription failed. Please try again.',
  DICTATION_TIMEOUT: 'Local transcription timed out. Please try a shorter recording.',
  DICTATION_RESULT_INVALID: 'Local transcription returned an invalid result.',
  DICTATION_BUSY: 'Another dictation is active. Finish or cancel it first.',
  DICTATION_DISPOSED: 'The reader connection has closed.',
  INVALID_DICTATION_SESSION: 'The dictation session is no longer available.',
  INVALID_DICTATION_REQUEST: 'The dictation request is invalid.',
});
function fail(code) { const error = new Error(SAFE_ERRORS[code] || SAFE_ERRORS.DICTATION_FAILED); error.code = code; return error; }
function safeCode(code, fallback = 'DICTATION_FAILED') { return Object.hasOwn(SAFE_ERRORS, code) ? code : fallback; }
function nativeErrorCode(code) {
  return ({ MICROPHONE_DENIED: 'DICTATION_PERMISSION_DENIED', MICROPHONE_UNAVAILABLE: 'DICTATION_NO_MICROPHONE',
    AUDIO_FORMAT_UNSUPPORTED: 'DICTATION_AUDIO_FORMAT_UNSUPPORTED', RECORDING_FAILED: 'DICTATION_RECORDER_FAILED',
    RECORDER_UNAVAILABLE: 'DICTATION_RECORDER_UNAVAILABLE', RECORDER_BUSY: 'DICTATION_BUSY' })[code] || safeCode(code, 'DICTATION_RECORDER_FAILED');
}
function validRequestId(value) { return typeof value === 'string' && REQUEST_RE.test(value); }

// The executable is an owned, packaged component. Never resolve an executable
// from tool arguments, PATH, an audio filename, or the document being viewed.
async function verifyPackagedHelper(helperPath, { verify = true } = {}) {
  const absolute = path.resolve(helperPath);
  if (path.basename(absolute) !== 'SmoothPdfRecorder.exe') throw fail('DICTATION_RECORDER_UNAVAILABLE');
  const directory = path.dirname(absolute);
  const dirStat = await lstat(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw fail('DICTATION_RECORDER_UNAVAILABLE');
  const root = await realpath(directory);
  const manifestPath = path.join(directory, 'recorder-manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16384) throw fail('DICTATION_RECORDER_UNAVAILABLE');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== 1 || manifest.executable !== 'SmoothPdfRecorder.exe' ||
      !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 20 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !/^[a-f0-9]{64}$/.test(manifest.sourceSha256)) throw fail('DICTATION_RECORDER_UNAVAILABLE');
  if (manifest.activation !== 'explicit-inline-button' || manifest.requiresNativeConsent !== false ||
      manifest.interactionMode !== 'inline-only' || manifest.nativeWindows !== false || manifest.startsOnlyOnExplicitCommand !== true) {
    throw fail('DICTATION_RECORDER_UPDATE_REQUIRED');
  }
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== manifest.bytes || path.dirname(await realpath(absolute)) !== root) throw fail('DICTATION_RECORDER_UNAVAILABLE');
  if (verify && createHash('sha256').update(await readFile(absolute)).digest('hex') !== manifest.sha256) throw fail('DICTATION_RECORDER_UNAVAILABLE');
  return absolute;
}

function validPcm(base64, samples) {
  if (typeof base64 !== 'string' || base64.length > Math.ceil(MAX_PCM_BYTES / 3) * 4 || base64.length % 4 || /[^A-Za-z0-9+/=]/.test(base64)) return false;
  const pcm = Buffer.from(base64, 'base64');
  try { return pcm.length <= MAX_PCM_BYTES && pcm.length % 2 === 0 && pcm.toString('base64') === base64 &&
    (samples === undefined || Number.isInteger(samples) && samples === pcm.length / 2); }
  finally { pcm.fill(0); }
}

/** A local session broker: neither audio nor process output reaches MCP clients. */
export function createNativeDictationBackend({
  dictation = createLocalDictationBackend(), helperPath = DEFAULT_HELPER,
  spawn = childProcess.spawn, verifyHelper = verifyPackagedHelper,
  platform = process.platform, now = () => Date.now(),
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  let disposed = false, active = null, helper = null, ready = false, nativeSessionId = null, cancelRequestedAt = null;
  let buffer = '', decoder = new StringDecoder('utf8'), stderrBytes = 0;
  const sessions = new Map(), requests = new Map();
  const pendingCancellations = new Map();

  function snapshot(session) {
    return {
      sessionId: session.id, state: session.state, local: true, maxSeconds: MAX_DICTATION_SECONDS,
      elapsedSeconds: session.startedAt === null ? 0 : Math.max(0, Math.min(MAX_DICTATION_SECONDS, Math.floor(((session.endedAt ?? now()) - session.startedAt) / 1000))),
      ...(session.state === 'complete' ? { text: session.text, language: session.language, ...(session.text ? {} : { empty: true }) } : {}),
      ...(session.code ? { code: session.code, message: SAFE_ERRORS[session.code] } : {}),
    };
  }
  function send(op, session) {
    if (!helper || helper.stdin?.destroyed || !helper.stdin?.writable) return false;
    try {
      helper.stdin.write(JSON.stringify({ op, ...(session ? { sessionId: session.id } : {}) }) + '\n');
      if (op === 'start') nativeSessionId = session.id;
      if (op === 'cancel' && nativeSessionId === session.id) cancelRequestedAt ??= now();
      return true;
    }
    catch { return false; }
  }
  function finish(session, state, code) {
    if (TERMINAL.has(session.state)) return;
    session.endedAt ??= now(); session.completedAt = now(); session.state = state;
    if (code) session.code = safeCode(code);
    if (state !== 'complete') { session.text = ''; session.language = null; }
    session.controller.abort();
    if (active === session) active = null;
  }
  function cancelSession(session, code = 'DICTATION_CANCELLED') {
    if (TERMINAL.has(session.state)) {
      // Explicit cancellation also removes a transcript that was completed just
      // before the user dismissed the editor.
      session.text = ''; session.language = null; session.state = 'cancelled'; session.code = code;
      session.completedAt = now(); return;
    }
    send('cancel', session); finish(session, 'cancelled', code);
  }
  function failHelper(code = 'DICTATION_RECORDER_FAILED') {
    const child = helper; helper = null; ready = false; nativeSessionId = null; cancelRequestedAt = null; buffer = ''; decoder = new StringDecoder('utf8');
    if (active) finish(active, 'error', code);
    if (child) { try { child.kill(); } catch {} }
  }
  function prune() {
    const time = now();
    for (const [id, session] of sessions) if (TERMINAL.has(session.state) && time - session.completedAt >= RESULT_TTL_MS) {
      session.text = ''; sessions.delete(id); requests.delete(session.requestId);
    }
    for (const [id, timeAdded] of pendingCancellations) if (time - timeAdded >= RESULT_TTL_MS) pendingCancellations.delete(id);
  }
  function checkLease() {
    prune();
    if (active && now() - active.lastHeartbeat >= LEASE_MS) cancelSession(active, 'DICTATION_LEASE_EXPIRED');
    // If a recorder fails to acknowledge cancellation, terminate only the
    // helper process this backend owns. Do not leave a hidden capture alive.
    if (nativeSessionId && cancelRequestedAt !== null && now() - cancelRequestedAt >= 2000) failHelper();
  }
  const timer = setIntervalFn(checkLease, 500); timer?.unref?.();
  function requireSession({ sessionId } = {}) {
    checkLease();
    if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionId) || !sessions.has(sessionId)) throw fail('INVALID_DICTATION_SESSION');
    return sessions.get(sessionId);
  }

  async function transcribe(session, pcmBase64) {
    if (active !== session || TERMINAL.has(session.state)) return;
    session.state = 'transcribing'; session.endedAt ??= now();
    try {
      const result = pcmBase64 ? await dictation.transcribe({ pcmBase64 }, { signal: session.controller.signal }) : { text: '', language: null };
      if (active !== session || session.controller.signal.aborted) return;
      if (typeof result?.text !== 'string' || result.text.length > 32000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(result.text)) throw fail('DICTATION_RESULT_INVALID');
      session.text = result.text; session.language = typeof result.language === 'string' && /^[a-z]{2,3}$/.test(result.language) ? result.language : null;
      finish(session, 'complete');
    } catch (error) { if (active === session && !session.controller.signal.aborted) finish(session, 'error', safeCode(error?.code)); }
    finally { pcmBase64 = null; }
  }

  function event(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) { failHelper(); return; }
    if (message.event === 'ready') {
      if (ready || message.protocolVersion !== 1) { failHelper(); return; }
      if (message.interactionMode !== 'inline-only') { failHelper('DICTATION_RECORDER_UPDATE_REQUIRED'); return; }
      ready = true;
      if (active?.state === 'starting' && !send('start', active)) failHelper();
      return;
    }
    if (message.sessionId === nativeSessionId && ['stopped', 'cancelled', 'error'].includes(message.event)) { nativeSessionId = null; cancelRequestedAt = null; }
    const session = active;
    if (!session || message.sessionId !== session.id || TERMINAL.has(session.state)) return;
    // A popup-producing legacy helper is incompatible with the inline-only
    // interaction. Stop that owned process instead of waiting for its dialog.
    if (message.event === 'consent') { send('cancel', session); failHelper('DICTATION_RECORDER_UPDATE_REQUIRED'); return; }
    if (message.event === 'recording' && session.state === 'starting') { session.state = 'recording'; session.startedAt = now(); }
    // A short capture may finish before its queued `recording` notification is
    // delivered. Accept only the live session created by an explicit UI start;
    // Windows microphone privacy checks remain the native recorder's authority.
    else if (message.event === 'stopped' && ['starting', 'recording', 'stopping'].includes(session.state)) {
      if (now() - session.lastHeartbeat >= LEASE_MS) { cancelSession(session, 'DICTATION_LEASE_EXPIRED'); return; }
      let pcmBase64 = message.pcmBase64; delete message.pcmBase64;
      if (!validPcm(pcmBase64, message.samples)) { pcmBase64 = null; failHelper(); return; }
      if (session.startedAt === null) session.startedAt = now() - (message.samples ?? 0) / 16;
      void transcribe(session, pcmBase64); pcmBase64 = null;
    } else if (message.event === 'cancelled') finish(session, 'cancelled', 'DICTATION_CANCELLED');
    else if (message.event === 'error') finish(session, 'error', nativeErrorCode(message.code));
  }

  function spawnHelper(executable) {
    if (helper) return;
    let child;
    try { child = spawn(executable, ['--parent-pid', String(process.pid)], { shell: false, windowsHide: true, cwd: path.dirname(executable), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw fail('DICTATION_START_FAILED'); }
    helper = child; ready = false; buffer = ''; decoder = new StringDecoder('utf8'); stderrBytes = 0;
    child.stdin?.on('error', () => { if (helper === child) failHelper(); });
    child.stdout?.on('data', chunk => {
      if (helper !== child) return;
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) { failHelper(); return; }
      let newline;
      while (helper === child && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { event(JSON.parse(line)); } catch { failHelper(); return; }
      }
    });
    child.stderr?.on('data', chunk => { if (helper === child && (stderrBytes += chunk.length) > 32768) failHelper(); });
    child.once('error', () => { if (helper === child) failHelper('DICTATION_START_FAILED'); });
    child.once('close', () => { if (helper === child) failHelper(); });
  }

  async function info() {
    // These describe the plugin interaction, not a grant of Windows microphone
    // access. info() never opens a device or changes OS permission settings.
    const common = { local: true, engine: 'whisper.cpp', maxSeconds: MAX_DICTATION_SECONDS,
      activation: 'explicit-inline-button', requiresNativeConsent: false, defaultEnabled: true };
    try {
      if (disposed || platform !== 'win32') throw fail('DICTATION_RECORDER_UNAVAILABLE');
      await verifyHelper(helperPath, { verify: false });
      const voice = await dictation.info();
      if (!voice.available) throw fail('DICTATION_UNAVAILABLE');
      return { ...common, available: true };
    } catch (error) { return { ...common, available: false, reason: SAFE_ERRORS[safeCode(error?.code, 'DICTATION_RECORDER_UNAVAILABLE')] }; }
  }
  async function start({ requestId } = {}, { signal } = {}) {
    if (disposed) throw fail('DICTATION_DISPOSED');
    if (!validRequestId(requestId)) throw fail('INVALID_DICTATION_REQUEST');
    checkLease();
    if (requests.has(requestId)) return snapshot(sessions.get(requests.get(requestId)));
    if (active || nativeSessionId) throw fail('DICTATION_BUSY');
    if (signal?.aborted || pendingCancellations.has(requestId)) throw fail('DICTATION_CANCELLED');
    if (platform !== 'win32') throw fail('DICTATION_RECORDER_UNAVAILABLE');
    // Bound retained transcripts and idempotency keys even during rapid use.
    while (sessions.size >= 24) {
      const oldest = sessions.values().next().value;
      oldest.text = ''; sessions.delete(oldest.id); requests.delete(oldest.requestId);
    }
    const session = { id: randomBytes(32).toString('base64url'), requestId, state: 'starting', startedAt: null, endedAt: null, completedAt: null,
      lastHeartbeat: now(), controller: new AbortController(), text: '', language: null };
    sessions.set(session.id, session); requests.set(requestId, session.id); active = session;
    const abort = () => cancelSession(session);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const executable = await verifyHelper(helperPath, { verify: true });
      const voice = await dictation.info();
      if (!voice.available) throw fail('DICTATION_UNAVAILABLE');
      checkLease();
      if (disposed || active !== session || session.controller.signal.aborted || signal?.aborted) return snapshot(session);
      spawnHelper(executable);
      if (ready && !send('start', session)) failHelper();
      return snapshot(session);
    } catch (error) { if (!TERMINAL.has(session.state)) finish(session, 'error', safeCode(error?.code, 'DICTATION_RECORDER_UNAVAILABLE')); return snapshot(session); }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async function status(args) { return snapshot(requireSession(args)); }
  async function heartbeat(args) {
    const session = requireSession(args);
    if (!TERMINAL.has(session.state)) {
      session.lastHeartbeat = now();
      if (helper && ready && session.state !== 'transcribing' && !send('heartbeat', session)) failHelper();
    }
    return snapshot(session);
  }
  async function stop(args) {
    const session = requireSession(args);
    if (session.state === 'recording') { session.state = 'stopping'; session.endedAt = now(); if (!send('stop', session)) failHelper(); }
    else if (session.state === 'starting') cancelSession(session);
    return snapshot(session);
  }
  async function cancel(args = {}) {
    if (args.sessionId) { const session = requireSession(args); cancelSession(session); return snapshot(session); }
    if (!validRequestId(args.requestId)) throw fail('INVALID_DICTATION_REQUEST');
    const id = requests.get(args.requestId);
    if (id) { const session = sessions.get(id); cancelSession(session); return snapshot(session); }
    prune();
    if (pendingCancellations.size >= 64) pendingCancellations.delete(pendingCancellations.keys().next().value);
    pendingCancellations.set(args.requestId, now());
    return { state: 'cancelled', local: true };
  }
  function dispose() {
    if (disposed) return;
    disposed = true; clearIntervalFn(timer);
    if (active) cancelSession(active);
    send('shutdown');
    const child = helper; helper = null; ready = false;
    if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
    for (const session of sessions.values()) { session.text = ''; session.controller.abort(); }
    sessions.clear(); requests.clear(); pendingCancellations.clear(); buffer = '';
  }
  return { info, start, status, heartbeat, stop, cancel, dispose };
}

export const __testing = Object.freeze({ verifyPackagedHelper, validPcm, LEASE_MS, RESULT_TTL_MS });
