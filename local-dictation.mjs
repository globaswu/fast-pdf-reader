import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const MAX_DICTATION_SECONDS = 120;
export const MAX_PCM_BYTES = 3840000;
const MAX_BASE64_CHARS = Math.ceil(MAX_PCM_BYTES / 3) * 4;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_TIMEOUT_MS = 180000;
const MODEL_BYTES = 147951465;
const MODEL_SHA256 = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe';
const ARCHIVE_SHA256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c';
const ARCHIVE_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin';
let processOwned = false;

function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { return failure('DICTATION_CANCELLED', 'Dictation was cancelled.'); }
function ensureNotCancelled(signal) { if (signal?.aborted) throw cancelled(); }
function decodePcm(pcmBase64) {
  if (typeof pcmBase64 !== 'string' || !pcmBase64.length || pcmBase64.length > MAX_BASE64_CHARS || pcmBase64.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(pcmBase64)) {
    throw failure('INVALID_DICTATION_AUDIO', 'Dictation requires bounded PCM16 mono audio.');
  }
  const pcm = Buffer.from(pcmBase64, 'base64');
  if (!pcm.length || pcm.length % 2 || pcm.length > MAX_PCM_BYTES || pcm.toString('base64') !== pcmBase64) {
    throw failure('INVALID_DICTATION_AUDIO', 'Dictation requires bounded PCM16 mono audio.');
  }
  return pcm;
}

// Reject DC and effectively silent captures before asking a generative decoder
// to interpret them. This is an energy gate, not a claim of voice detection.
function hasAudioEnergy(pcm) {
  let activeFrames = 0;
  for (let start = 0; start < pcm.length; start += 640) {
    const end = Math.min(start + 640, pcm.length);
    const count = (end - start) / 2;
    let sum = 0, squared = 0;
    for (let i = start; i < end; i += 2) { const v = pcm.readInt16LE(i) / 32768; sum += v; squared += v * v; }
    const acRms = Math.sqrt(Math.max(0, squared / count - (sum / count) ** 2));
    if (acRms >= 0.001 && ++activeFrames >= 3) return true;
  }
  return false;
}

function makeWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function safeRelative(value) {
  if (typeof value !== 'string' || value.length > 300 || !value.length || value.includes('\\') ||
      value.includes(':') || value.includes('\0') || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9_.-]+$/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
  }
  return value;
}

async function regularContainedFile(root, relative) {
  const name = safeRelative(relative);
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
  }
  const stat = await lstat(current);
  const resolved = await realpath(current);
  if (!stat.isFile() || path.relative(root, resolved).startsWith('..') || path.isAbsolute(path.relative(root, resolved))) {
    throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
  }
  return { absolute: current, stat };
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function parseTranscript(raw) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_OUTPUT_BYTES) throw failure('DICTATION_RESULT_INVALID', 'Local transcription returned an invalid result.');
  let output;
  try { output = JSON.parse(raw); } catch { throw failure('DICTATION_RESULT_INVALID', 'Local transcription returned an invalid result.'); }
  if (!Array.isArray(output?.transcription) || output.transcription.length > 4096 || output.transcription.some(s => typeof s?.text !== 'string')) {
    throw failure('DICTATION_RESULT_INVALID', 'Local transcription returned an invalid result.');
  }
  const text = output.transcription.map(segment => segment.text).join('').trim();
  if (text.length > 32000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw failure('DICTATION_RESULT_INVALID', 'Local transcription returned an invalid result.');
  const language = typeof output.result?.language === 'string' && /^[a-z]{2,3}$/.test(output.result.language) ? output.result.language : null;
  return { text, language, engine: 'whisper.cpp', local: true, ...(text ? {} : { empty: true }) };
}

function runWhisper(executable, args, { signal, timeoutMs = PROCESS_TIMEOUT_MS, cwd } = {}) {
  ensureNotCancelled(signal);
  return new Promise((resolve, reject) => {
    let child, timer, finalError, finished = false, bytes = 0;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const done = (error) => { if (finished) return; finished = true; cleanup(); error ? reject(error) : resolve(); };
    const terminate = error => { if (finished || finalError) return; finalError = error; if (child) child.kill(); };
    const abort = () => terminate(cancelled());
    try {
      child = childProcess.spawn(executable, args, {
        shell: false, windowsHide: true, cwd, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OMP_NUM_THREADS: '4', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' },
      });
      if (Number.isInteger(child.pid)) { try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {} }
    } catch { done(failure('DICTATION_START_FAILED', 'The local transcription engine could not start.')); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => terminate(failure('DICTATION_TIMEOUT', 'Local transcription timed out. Please try a shorter recording.')), timeoutMs);
    const discardOutput = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) terminate(failure('DICTATION_OUTPUT_LIMIT', 'The local transcription engine returned too much output.'));
    };
    child.stdout?.on('data', discardOutput); child.stderr?.on('data', discardOutput);
    child.once('error', () => done(finalError || failure('DICTATION_START_FAILED', 'The local transcription engine could not start.')));
    child.once('close', code => done(finalError || (code === 0 ? null : failure('DICTATION_FAILED', 'Local transcription failed. Please try again.'))));
    if (signal?.aborted) abort();
  });
}

// Per-user runtime storage is outside the plugin package and survives upgrades.
// An unset or relative LOCALAPPDATA must not make resolution depend on the cwd.
export function defaultDictationRuntimeDir({ env = process.env, home = os.homedir() } = {}) {
  const localAppData = typeof env.LOCALAPPDATA === 'string' && path.isAbsolute(env.LOCALAPPDATA)
    ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local');
  return path.join(localAppData, 'SmoothPdfReader', 'voice-runtime');
}

export function createLocalDictationBackend({ runtimeDir = defaultDictationRuntimeDir() } = {}) {
  const rootInput = path.resolve(runtimeDir);
  const verified = new Map();
  async function resolveRuntime({ verify = true } = {}) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('DICTATION_PLATFORM_UNSUPPORTED', 'Local dictation currently requires Windows x64.');
    const rootStat = await lstat(rootInput);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
    const root = await realpath(rootInput);
    const manifestFile = await regularContainedFile(root, 'runtime.json');
    if (manifestFile.stat.size > 65536) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
    const manifest = JSON.parse(await readFile(manifestFile.absolute, 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.engine !== 'whisper.cpp' || manifest.version !== '1.9.4' || manifest.build !== 'b5130' ||
        manifest.archive?.url !== ARCHIVE_URL || manifest.archive?.sha256 !== ARCHIVE_SHA256 ||
        manifest.model?.url !== MODEL_URL || manifest.model?.sha256 !== MODEL_SHA256 || manifest.model?.bytes !== MODEL_BYTES ||
        manifest.model?.name !== 'base' || manifest.model?.multilingual !== true ||
        !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 100 ||
        !String(manifest.executable).endsWith('/whisper-cli.exe')) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
    const wanted = new Map();
    for (const file of manifest.files) {
      const relative = safeRelative(file.path);
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 200000000 || wanted.has(relative.toLowerCase())) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
      wanted.set(relative.toLowerCase(), file);
      const { absolute, stat } = await regularContainedFile(root, relative);
      const fingerprint = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${file.sha256}`;
      if (stat.size !== file.bytes || (verify && verified.get(absolute) !== fingerprint && await fileHash(absolute) !== file.sha256)) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
      if (verify) verified.set(absolute, fingerprint);
    }
    const executable = safeRelative(manifest.executable);
    const model = safeRelative(manifest.model.path);
    const modelEntry = wanted.get(model.toLowerCase());
    if (!wanted.has(executable.toLowerCase()) || modelEntry?.sha256 !== MODEL_SHA256 || modelEntry.bytes !== MODEL_BYTES) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
    const executableDir = path.dirname(path.join(root, executable));
    for (const item of await readdir(executableDir, { withFileTypes: true })) {
      if (/\.(?:dll|exe)$/i.test(item.name) && (!item.isFile() || !wanted.has(path.relative(root, path.join(executableDir, item.name)).replaceAll('\\', '/').toLowerCase()))) throw failure('DICTATION_RUNTIME_INVALID', 'The local dictation runtime needs repair.');
    }
    return { executable: path.join(root, executable), model: path.join(root, model), cwd: executableDir };
  }
  async function info() {
    const common = { engine: 'whisper.cpp', version: '1.9.4', local: true, model: { name: 'base', multilingual: true }, maxSeconds: MAX_DICTATION_SECONDS, maxPcmBytes: MAX_PCM_BYTES };
    try { await resolveRuntime({ verify: false }); return { ...common, available: true }; }
    catch (error) { return { ...common, available: false, reason: error.code === 'DICTATION_PLATFORM_UNSUPPORTED' ? error.message : 'Local voice runtime is not installed or needs repair.' }; }
  }
  async function transcribe({ pcmBase64 } = {}, { signal } = {}) {
    ensureNotCancelled(signal);
    const pcm = decodePcm(pcmBase64);
    if (!hasAudioEnergy(pcm)) { pcm.fill(0); return { text: '', language: null, engine: 'whisper.cpp', local: true, empty: true }; }
    if (processOwned) { pcm.fill(0); throw failure('DICTATION_BUSY', 'Another local transcription is running. Please wait.'); }
    processOwned = true;
    let temporary, wavPath, outputPath;
    try {
      let runtime;
      try { runtime = await resolveRuntime(); } catch { throw failure('DICTATION_UNAVAILABLE', 'Local voice runtime is not installed or needs repair.'); }
      ensureNotCancelled(signal);
      temporary = await mkdtemp(path.join(os.tmpdir(), 'smooth-pdf-dictation-'));
      wavPath = path.join(temporary, 'capture.wav'); outputPath = path.join(temporary, 'transcript.json');
      await writeFile(wavPath, makeWav(pcm), { flag: 'wx', mode: 0o600 });
      const outputPrefix = path.join(temporary, 'transcript');
      await runWhisper(runtime.executable, ['-m', runtime.model, '-f', wavPath, '-l', 'auto', '-t', '4', '-p', '1', '-ng', '-oj', '-of', outputPrefix], { signal, cwd: runtime.cwd });
      ensureNotCancelled(signal);
      const stat = await lstat(outputPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_OUTPUT_BYTES) throw failure('DICTATION_RESULT_INVALID', 'Local transcription returned an invalid result.');
      return parseTranscript(await readFile(outputPath, 'utf8'));
    } catch (error) {
      if (/^DICTATION_|^INVALID_DICTATION_/.test(error?.code || '')) throw error;
      throw failure('DICTATION_FAILED', 'Local transcription failed. Please try again.');
    } finally {
      // Only the two generated filenames and their exact unique directory are
      // eligible for deletion. Unexpected extra files prevent directory removal.
      for (const file of [wavPath, outputPath]) if (file) { try { await unlink(file); } catch {} }
      if (temporary) { try { await rmdir(temporary); } catch {} }
      pcm.fill(0); processOwned = false;
    }
  }
  return { info, transcribe };
}

export const __testing = Object.freeze({ decodePcm, hasAudioEnergy, makeWav, safeRelative, parseTranscript, runWhisper });
