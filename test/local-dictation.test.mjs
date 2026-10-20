import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_DICTATION_SECONDS, MAX_PCM_BYTES, createLocalDictationBackend, defaultDictationRuntimeDir, __testing as helpers } from '../local-dictation.mjs';

function tone(samples = 1600, amplitude = 1000) { const data = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(amplitude * Math.sin(i * 0.1)), i * 2); return data; }
function child() {
  const result = new EventEmitter(); result.stdout = new PassThrough(); result.stderr = new PassThrough();
  result.killCount = 0; result.kill = () => { result.killCount++; queueMicrotask(() => result.emit('close', null)); return true; };
  return result;
}

test('voice runtime uses private local app data instead of a development or plugin directory', () => {
  const appData = path.resolve('example-local-app-data');
  const testHome = path.resolve('example-home');
  assert.equal(defaultDictationRuntimeDir({ env: { LOCALAPPDATA: appData }, home: testHome }),
    path.join(appData, 'SmoothPdfReader', 'voice-runtime'));
  for (const env of [{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: 'relative-app-data' }]) {
    assert.equal(defaultDictationRuntimeDir({ env, home: testHome }),
      path.join(testHome, 'AppData', 'Local', 'SmoothPdfReader', 'voice-runtime'));
  }
});

test('dictation validates canonical bounded PCM16 base64', () => {
  assert.equal(MAX_DICTATION_SECONDS, 120); assert.equal(MAX_PCM_BYTES, 3840000);
  for (const value of [null, undefined, 1, '', 'AA', 'AAAA\n', 'AA-_', 'A===', 'AB==', Buffer.from([1]).toString('base64'), 'A'.repeat(5120004)]) {
    assert.throws(() => helpers.decodePcm(value), { code: 'INVALID_DICTATION_AUDIO' });
  }
  assert.deepEqual(helpers.decodePcm('AAA='), Buffer.alloc(2));
  assert.equal(helpers.decodePcm(Buffer.alloc(MAX_PCM_BYTES).toString('base64')).length, MAX_PCM_BYTES);
});

test('silence and DC are rejected without rejecting a normal synthetic signal', () => {
  assert.equal(helpers.hasAudioEnergy(Buffer.alloc(32000)), false);
  const dc = Buffer.alloc(32000); for (let i = 0; i < dc.length; i += 2) dc.writeInt16LE(800, i);
  assert.equal(helpers.hasAudioEnergy(dc), false);
  assert.equal(helpers.hasAudioEnergy(tone(1600, 1)), false);
  assert.equal(helpers.hasAudioEnergy(tone()), true);
});

test('PCM WAV header is 16 kHz mono 16-bit and bounded exact payload', () => {
  const pcm = tone(); const wav = helpers.makeWav(pcm);
  assert.equal(wav.length, pcm.length + 44); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), pcm.length + 36); assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(34), 16);
  assert.deepEqual(wav.subarray(44), pcm);
});

test('manifest relative paths forbid traversal, drives, UNC and alternate data streams', () => {
  for (const value of ['', '../whisper-cli.exe', '/tmp/a', 'C:/a', 'a/../x', 'a//x', 'a\\x', 'a:stream', 'a/./x', 'a\0x', 'a/*', 'a/con.dll', 'a/b.', 'a/b ']) assert.throws(() => helpers.safeRelative(value));
  assert.equal(helpers.safeRelative('releases/b5130/bin/Release/whisper-cli.exe'), 'releases/b5130/bin/Release/whisper-cli.exe');
});

test('transcript parses bounded text without accepting arbitrary shape', () => {
  assert.deepEqual(helpers.parseTranscript(JSON.stringify({result:{language:'en'},transcription:[{text:' Please revise'},{text:' this sentence.'}]})), {text:'Please revise this sentence.',language:'en',engine:'whisper.cpp',local:true});
  assert.equal(helpers.parseTranscript('{"transcription":[]}').empty, true);
  for (const raw of ['', '{}', '{"transcription":[{"text":1}]}', JSON.stringify({transcription:[{text:'x'.repeat(32001)}]})]) assert.throws(() => helpers.parseTranscript(raw), {code:'DICTATION_RESULT_INVALID'});
});

test('absent runtime reports sanitized unavailable state; silence does not launch process', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dictation-unit-')); t.after(() => rmdir(dir));
  const backend = createLocalDictationBackend({runtimeDir:dir});
  const info = await backend.info(); assert.equal(info.available, false); assert.equal(info.local, true);
  assert.equal(JSON.stringify(info).includes(dir), false);
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('Should not spawn'); });
  assert.equal((await backend.transcribe({pcmBase64:Buffer.alloc(32000).toString('base64')})).empty, true);
  assert.equal(spawn.mock.callCount(), 0);
  await assert.rejects(backend.transcribe({pcmBase64:tone().toString('base64')}), {code:'DICTATION_UNAVAILABLE'});
});

test('fixed process runner has no shell, hides console and never exposes stderr', async t => {
  const fake = child(); let options;
  t.mock.method(childProcess, 'spawn', (exe,args,opts) => { assert.equal(exe,'verified-whisper.exe'); assert.deepEqual(args,['-ng']); options=opts; return fake; });
  const promise = helpers.runWhisper('verified-whisper.exe',['-ng'],{cwd:'verified-dir'});
  fake.stderr.write('secret transcript that must never escape'); fake.emit('close', 1);
  await assert.rejects(promise, {code:'DICTATION_FAILED',message:'Local transcription failed. Please try again.'});
  assert.equal(options.shell,false); assert.equal(options.windowsHide,true); assert.equal(options.cwd,'verified-dir');
});

test('cancellation terminates only the owned child and returns no transcript', async t => {
  const fake=child(); t.mock.method(childProcess,'spawn',()=>fake);
  const controller = new AbortController(); const promise=helpers.runWhisper('verified.exe',[],{signal:controller.signal});
  controller.abort(); await assert.rejects(promise,{code:'DICTATION_CANCELLED'}); assert.equal(fake.killCount,1);
  assert.throws(()=>helpers.runWhisper('verified.exe',[],{signal:controller.signal}),{code:'DICTATION_CANCELLED'});
});

test('timeout and oversized process output stop the owned process', async t => {
  const timed=child(); t.mock.method(childProcess,'spawn',()=>timed);
  await assert.rejects(helpers.runWhisper('verified.exe',[],{timeoutMs:5}),{code:'DICTATION_TIMEOUT'});
  assert.equal(timed.killCount,1);
  const noisy=child(); childProcess.spawn=()=>noisy;
  const promise=helpers.runWhisper('verified.exe',[]); noisy.stdout.write(Buffer.alloc(1024*1024+1));
  await assert.rejects(promise,{code:'DICTATION_OUTPUT_LIMIT'}); assert.equal(noisy.killCount,1);
});

test('start failure and success use sanitized deterministic responses', async t => {
  const fake=child(); t.mock.method(childProcess,'spawn',()=>fake);
  const failed=helpers.runWhisper('verified.exe',[]); fake.emit('error',new Error('private runtime path'));
  await assert.rejects(failed,{code:'DICTATION_START_FAILED',message:'The local transcription engine could not start.'});
  const good=child(); childProcess.spawn=()=>good;
  const success=helpers.runWhisper('verified.exe',[]); good.emit('close',0); await success;
});
