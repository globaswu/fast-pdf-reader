import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { MAX_CHUNK } from '../document-store.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const selected = sourcePath => ({ 'openai/resource': { path: sourcePath } });
const errorText = result => (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');

// This is a real stdio MCP client, standing in for the trusted host. It verifies
// server contracts, not that a particular desktop build enforces app visibility
// or prevents an untrusted embedded app from forging host-owned metadata.
test('MCP stdio exposes a read-only app contract and enforces source-scoped reads', { timeout: 20000 }, async t => {
  const base = path.resolve(os.tmpdir());
  const dir = await mkdtemp(path.join(base, 'fresh-pdf-mcp-test-'));
  const a = path.join(dir, 'synthetic-a.pdfprobe');
  const b = path.join(dir, 'synthetic-b.pdf');
  const bytes = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n');
  await Promise.all([writeFile(a, bytes), writeFile(b, bytes)]);
  const executableRoot = process.env.FAST_PDF_TEST_BUNDLED === '1' ? path.join(root, 'plugins', 'fast-pdf-reader') : root;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [path.join(executableRoot, 'server.mjs')], cwd: executableRoot, stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const client = new Client({ name: 'fast-pdf-reader-synthetic-test', version: '1.0.0' });
  t.after(async () => {
    await client.close();
    assert.equal(path.dirname(path.resolve(dir)), base);
    assert.match(path.basename(dir), /^fresh-pdf-mcp-test-/);
    await rm(dir, { recursive: true, force: true });
    assert.equal(stderr, '', 'MCP subprocess must not print PDF data or diagnostic paths to stderr');
  });
  await client.connect(transport);
  const call = (name, args = {}, meta) => client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) });

  await t.test('data tools are app-only and closed-world; launch and file-action metadata are explicit', async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['pdf_asset', 'pdf_info', 'pdf_launch', 'pdf_open', 'pdf_open_external', 'pdf_read']);
    for (const tool of tools) {
      if(tool.name!=='pdf_launch') assert.deepEqual(tool._meta.ui.visibility, ['app']);
      assert.equal(tool.annotations.readOnlyHint, tool.name!=='pdf_open_external');
      assert.equal(tool.annotations.destructiveHint, false);
      assert.equal(tool.annotations.openWorldHint, false);
      if (tool.name !== 'pdf_open') {
        assert.equal(tool.inputSchema.properties?.sourcePath, undefined);
        assert.equal(tool.inputSchema.properties?.path, undefined);
      }
    }
    const open = tools.find(tool => tool.name === 'pdf_open');
    assert.deepEqual(open._meta['openai/ui'].entrypoints, [{ type: 'file', extensions: ['.pdf'] }]);
    assert.equal(open._meta.ui.resourceUri, 'ui://fast-pdf-reader/v1-0-0/viewer.html');
  });

  await t.test('missing and malformed host context fail without using arbitrary argument paths', async () => {
    for (const meta of [undefined, {}, { 'openai/resource': {} }, { 'openai/resource': { path: 12 } }]) {
      const result = await call('pdf_info', { sourcePath: a, path: a }, meta);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.ok(!errorText(result).includes(dir));
    }
    const result = await call('pdf_info', {}, selected('relative.pdf'));
    assert.equal(result.isError, true);
    assert.match(errorText(result), /absolute PDF path/);
  });

  await t.test('opening input alone cannot establish a persisted file authority', async () => {
    const result = await call('pdf_open', { file: { name: 'synthetic-a.pdfprobe', resourceUri: a } });
    assert.deepEqual(result.structuredContent, { viewer:'fast-pdf-reader', version:'1.0.0' });
    const info = await call('pdf_info');
    assert.equal(info.isError, true);
    assert.match(errorText(info), /host has not supplied local file context/);
  });

  let documentId;
  await t.test('trusted metadata controls which file is read; results are not transcript content', async () => {
    const info = await call('pdf_info', { sourcePath: b }, selected(a));
    assert.ok(!info.isError);
    assert.equal(info.structuredContent.name, 'synthetic-a.pdfprobe');
    assert.equal(info.structuredContent.size, bytes.length);
    assert.deepEqual(info.content, []);
    documentId = info.structuredContent.documentId;
    const read = await call('pdf_read', { documentId, begin: 0, end: bytes.length, sourcePath: b }, selected(a));
    assert.ok(!read.isError);
    assert.deepEqual(read.content, []);
    assert.deepEqual(Buffer.from(read.structuredContent.base64, 'base64'), bytes);
  });

  await t.test('valid token cannot cross file context and absent context cannot read bytes', async () => {
    for (const meta of [selected(b), undefined]) {
      const result = await call('pdf_read', { documentId, begin: 0, end: 8 }, meta);
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.ok(!errorText(result).includes(dir));
    }
  });

  await t.test('read bounds and schema validation reject malformed requests', async () => {
    for (const range of [{ begin: -1, end: 5 }, { begin: 0, end: 0 }, { begin: 4, end: 3 },
      { begin: 0, end: MAX_CHUNK + 1 }, { begin: 0.5, end: 4 }, { begin: 0, end: bytes.length + 1 }]) {
      const result = await call('pdf_read', { documentId, ...range }, selected(a));
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
    }
    const result = await call('pdf_read', { documentId: 'invalid', begin: 0, end: 8 }, selected(a));
    assert.equal(result.isError, true);
  });

  await t.test('changed-file tokens are rejected over the real transport', async () => {
    await appendFile(a, '\n% synthetic update\n');
    const stale = await call('pdf_read', { documentId, begin: 0, end: 8 }, selected(a));
    assert.equal(stale.isError, true);
    assert.match(errorText(stale), /reload required/);
    const fresh = await call('pdf_info', {}, selected(a));
    assert.notEqual(fresh.structuredContent.documentId, documentId);
  });

  await t.test('asset traversal and missing files return sanitized errors', async () => {
    for (const name of ['../package.json', '..\\package.json', '/package.json', 'a..b']) {
      const result = await call('pdf_asset', { kind: 'standard_fonts', name });
      assert.equal(result.isError, true);
      assert.match(errorText(result), /Invalid bundled PDF asset/);
    }
    const missing = await call('pdf_info', {}, selected(path.join(dir, 'missing.pdf')));
    assert.equal(missing.isError, true);
    assert.equal(errorText(missing), 'The selected PDF path was not found.');
    assert.equal(missing._meta.localPdfErrorCode,'PDF_NOT_FOUND');
    const asset = await call('pdf_asset', { kind: 'standard_fonts', name: 'FoxitFixed.pfb' });
    assert.ok(!asset.isError);
    assert.deepEqual(asset.content, []);
    assert.ok(Buffer.from(asset.structuredContent.base64, 'base64').length > 0);
    const preview=await call('pdf_asset',{kind:'preview_engine',name:'pdfium.wasm'});
    assert.ok(!preview.isError);
    assert.deepEqual(Buffer.from(preview.structuredContent.base64,'base64').subarray(0,4),Buffer.from([0,97,115,109]));
  });
});
