import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relative => readFile(new URL(`../${relative}`, import.meta.url), 'utf8');

test('portable MCP configuration preserves the public connection identity', async () => {
  const config = JSON.parse(await read('.mcp.json'));
  assert.deepEqual(Object.keys(config.mcpServers), ['fast-pdf-reader']);
  assert.equal(config.mcpServers['fast-pdf-reader'].command, 'node');
  assert.deepEqual(config.mcpServers['fast-pdf-reader'].args, ['./server.mjs']);
  assert.equal(config.mcpServers['fast-pdf-reader'].cwd, '.');
});

test('runtime and opt-in installer agree on app-data storage with no developer path', async () => {
  const runtime = await read('local-dictation.mjs');
  const installer = await read('scripts/install-dictation-runtime.ps1');
  assert.match(runtime, /'SmoothPdfReader', 'voice-runtime'/);
  assert.match(installer, /'SmoothPdfReader\\voice-runtime'/);
  for (const source of [runtime, installer, await read('native-recorder.mjs')]) {
    assert.doesNotMatch(source, /local-patches|C:[\\/]Users[\\/]/i);
  }
  assert.match(installer, /\$env:LOCALAPPDATA/);
  assert.match(installer, /Get-FileHash[\s\S]*SHA256/);
});

test('production UI uses only the explicit native recorder, never browser capture', async () => {
  const feedback = await read('src/feedback.mjs');
  const inline = await read('src/inline-dictation.mjs');
  assert.match(feedback, /createInlineDictation/);
  assert.doesNotMatch(feedback, /dictation-audio|getUserMedia/);
  assert.doesNotMatch(inline, /getUserMedia|SpeechRecognition|fetch\(/);
  assert.match(inline, /pdf_dictation_start/);
  assert.match(inline, /getBinding/);
  assert.match(inline, /isBindingCurrent/);
});

test('recorder manifest generation is BOM-free in Windows PowerShell and PowerShell 7', async () => {
  const build = await read('native-recorder/build-recorder.ps1');
  assert.match(build, /\[IO\.File\]::WriteAllText/);
  assert.match(build, /\[Text\.UTF8Encoding\]::new\(\$false\)/);
  assert.doesNotMatch(build, /Set-Content[^\r\n]*-Encoding utf8/i);
  const manifest = await readFile(new URL('../native-recorder/bin/recorder-manifest.json', import.meta.url));
  assert.notDeepEqual([...manifest.subarray(0, 3)], [239, 187, 191]);
  assert.equal(JSON.parse(manifest.toString('utf8')).interactionMode, 'inline-only');
});
