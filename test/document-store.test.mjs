import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocumentStore, MAX_CHUNK } from '../document-store.mjs';

// Only synthetic files are created/read. Cleanup is restricted to the exact
// temporary directory returned by mkdtemp, never the project or a user PDF.
async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const dir = await mkdtemp(path.join(base, 'fresh-pdf-store-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)), base);
    assert.match(path.basename(dir), /^fresh-pdf-store-test-/);
    await rm(dir, { recursive: true, force: true });
  });
  const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  const first = path.join(dir, 'synthetic-a.pdf');
  const second = path.join(dir, 'synthetic-b.pdf');
  await Promise.all([writeFile(first, bytes), writeFile(second, bytes)]);
  return { dir, bytes, first, second, store: new DocumentStore() };
}

test('document identity is stable, source-bound and readable in exact bounded ranges', async t => {
  const { first, bytes, store } = await fixture(t);
  const info = await store.describe(first);
  assert.match(info.documentId, /^[a-f0-9]{64}$/);
  assert.equal(info.name, 'synthetic-a.pdf');
  assert.equal(info.size, bytes.length);
  assert.deepEqual(await store.describe(first), info);
  const whole = await store.read(first, { documentId: info.documentId, begin: 0, end: bytes.length });
  assert.equal(whole.begin, 0);
  assert.deepEqual(Buffer.from(whole.base64, 'base64'), bytes);
  const part = await store.read(first, { documentId: info.documentId, begin: 5, end: 13 });
  assert.deepEqual(Buffer.from(part.base64, 'base64'), bytes.subarray(5, 13));
});

test('document input requires an absolute supported regular PDF with a PDF header', async t => {
  const { dir, store } = await fixture(t);
  for (const value of [undefined, null, 7, '', 'relative.pdf']) {
    await assert.rejects(store.describe(value), /host-selected absolute PDF path/);
  }
  const text = path.join(dir, 'invalid.txt');
  await writeFile(text, '%PDF-1.7\n%%EOF');
  await assert.rejects(store.describe(text), /Only PDF/);
  const short = path.join(dir, 'short.pdf');
  await writeFile(short, '%PDF-');
  await assert.rejects(store.describe(short), /Not a PDF/);
  const invalid = path.join(dir, 'invalid.pdf');
  await writeFile(invalid, 'this is not a PDF file');
  await assert.rejects(store.describe(invalid), /Invalid PDF header/);
  const directory = path.join(dir, 'directory.pdf');
  await mkdir(directory);
  await assert.rejects(store.describe(directory));
  const probe = path.join(dir, 'synthetic.PDFPROBE');
  await writeFile(probe, '%PDF-1.7\n%%EOF\n');
  assert.equal((await store.describe(probe)).name, 'synthetic.PDFPROBE');
});

test('Windows host file-link notation preserves the same selected document identity',{skip:process.platform!=='win32'},async t=>{
  const {first,store}=await fixture(t);
  assert.deepEqual(await store.describe('/'+first.replaceAll('\\','/')),await store.describe(first));
  await assert.rejects(store.describe('file:///'+first.replaceAll('\\','/')),/absolute PDF path/);
});

test('ranges reject negative, empty, reversed, fractional, unsafe and excessive reads', async t => {
  const { first, bytes, store } = await fixture(t);
  const { documentId } = await store.describe(first);
  const invalidRanges = [
    [-1, 1], [0, 0], [4, 3], [0.5, 1], [0, 1.5],
    [NaN, 1], [0, Infinity], [0, MAX_CHUNK + 1],
    [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2],
  ];
  for (const [begin, end] of invalidRanges) {
    await assert.rejects(store.read(first, { documentId, begin, end }), /Invalid PDF byte range/);
  }
  await assert.rejects(store.read(first, { documentId, begin: 0, end: bytes.length + 1 }), /out of bounds/);
});

test('one exact maximum-size chunk is permitted without unbounded whole-file reads', async t => {
  const { first, store } = await fixture(t);
  const bytes = Buffer.alloc(MAX_CHUNK + 20, 32);
  bytes.write('%PDF-1.7\n');
  bytes.write('\n%%EOF', bytes.length - 6);
  await writeFile(first, bytes);
  const { documentId } = await store.describe(first);
  const result = await store.read(first, { documentId, begin: 0, end: MAX_CHUNK });
  assert.equal(Buffer.from(result.base64, 'base64').length, MAX_CHUNK);
  await assert.rejects(store.read(first, { documentId, begin: 0, end: MAX_CHUNK + 1 }), /Invalid PDF byte range/);
});

test('a document token cannot read another file even when the PDF bytes are identical', async t => {
  const { first, second, store } = await fixture(t);
  const a = await store.describe(first);
  const b = await store.describe(second);
  assert.notEqual(a.documentId, b.documentId);
  await assert.rejects(store.read(second, { documentId: a.documentId, begin: 0, end: 8 }), /context mismatch/);
});

test('changed files invalidate earlier tokens and permit a fresh description', async t => {
  const { first, store } = await fixture(t);
  const before = await store.describe(first);
  await appendFile(first, '\n% synthetic revision\n');
  await assert.rejects(store.read(first, { documentId: before.documentId, begin: 0, end: 8 }), /reload required/);
  const after = await store.describe(first);
  assert.notEqual(after.documentId, before.documentId);
  assert.ok(after.size > before.size);
  const result = await store.read(first, { documentId: after.documentId, begin: 0, end: 8 });
  assert.equal(Buffer.from(result.base64, 'base64').toString(), '%PDF-1.7');
});

test('assets are limited to installed asset categories and single safe filenames', async () => {
  const store = new DocumentStore();
  const asset = await store.asset({ kind: 'standard_fonts', name: 'FoxitFixed.pfb' });
  assert.ok(Buffer.from(asset.base64, 'base64').length > 0);
  for (const kind of ['..', 'build', '/cmaps', undefined]) {
    await assert.rejects(store.asset({ kind, name: 'FoxitFixed.pfb' }), /Invalid bundled PDF asset/);
  }
  for (const name of ['../package.json', '..\\package.json', '/package.json', 'C:\\file',
    '..', 'a..b', '.hidden', 'nested/font.pfb', 'nested\\font.pfb', 'a%2fb', 'a\0b', '', null]) {
    await assert.rejects(store.asset({ kind: 'standard_fonts', name }), /Invalid bundled PDF asset/);
  }
  await assert.rejects(store.asset({ kind: 'standard_fonts', name: 'missing-synthetic.pfb' }));
});
