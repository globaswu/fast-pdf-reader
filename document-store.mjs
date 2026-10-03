import { open, realpath, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

export const MAX_CHUNK = 1024 * 1024;
const bundledAssetRoot = fileURLToPath(new URL('./vendor/pdfjs/', import.meta.url));
const assetRoot = existsSync(bundledAssetRoot) ? bundledAssetRoot
  : path.dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')));
const previewBundleRoot=fileURLToPath(new URL('./vendor/pdfium/',import.meta.url));
const previewAssetRoot=existsSync(previewBundleRoot)?previewBundleRoot:path.dirname(fileURLToPath(import.meta.resolve('@embedpdf/pdfium')));
const assetKinds = new Set(['cmaps', 'standard_fonts', 'wasm','preview_engine']);

// No persistent cache and no open descriptor survives a request. Each read is
// re-bound to the host-selected file and its identity; old tokens cannot cross
// tabs or silently read a newer revision of a PDF.
export class DocumentStore {
  async describe(sourcePath) {
    // The host can express a Windows drive path in slash-prefixed file-link
    // notation. Normalize that exact representation, never decode an arbitrary
    // URI or derive file authority from the viewer's input arguments.
    if(process.platform==='win32'&&typeof sourcePath==='string'&&/^\/[A-Za-z]:[\\/]/.test(sourcePath))sourcePath=sourcePath.slice(1);
    if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath)) {
      throw new Error('A host-selected absolute PDF path is required.');
    }
    const actualPath = await realpath(sourcePath);
    if (!/\.(pdf|pdfprobe)$/i.test(actualPath)) throw new Error('Only PDF documents are accepted.');
    const handle = await open(actualPath, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 8) throw new Error('Not a PDF file.');
      const header = Buffer.alloc(8);
      await handle.read(header, 0, header.length, 0);
      if (!header.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Invalid PDF header.');
      return this.#identity(actualPath, info);
    } finally {
      await handle.close();
    }
  }

  #identity(sourcePath, info) {
    const signature = [sourcePath, info.size, info.mtimeMs, info.ctimeMs, info.ino].join('\0');
    return {
      documentId: createHash('sha256').update(signature).digest('hex'),
      name: path.basename(sourcePath), size: info.size,
      modifiedMs: info.mtimeMs, sourcePath,
    };
  }

  async read(sourcePath, { documentId, begin, end }) {
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(end) || begin < 0 ||
        end <= begin || end - begin > MAX_CHUNK) throw new Error('Invalid PDF byte range.');
    const expected = await this.describe(sourcePath);
    if (expected.documentId !== documentId) throw new Error('Document changed or context mismatch; reload required.');
    if (end > expected.size) throw new Error('PDF byte range is out of bounds.');
    const handle = await open(expected.sourcePath, 'r');
    try {
      if (this.#identity(expected.sourcePath, await handle.stat()).documentId !== documentId) {
        throw new Error('Document changed; reload required.');
      }
      const data = Buffer.alloc(end - begin);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, begin + offset);
        if (!bytesRead) throw new Error('Unexpected PDF end of file; reload required.');
        offset += bytesRead;
      }
      if (this.#identity(expected.sourcePath, await handle.stat()).documentId !== documentId) {
        throw new Error('Document changed while reading; reload required.');
      }
      return { begin, base64: data.toString('base64') };
    } finally {
      await handle.close();
    }
  }

  async asset({ kind, name }) {
    if (!assetKinds.has(kind) || typeof name !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name.includes('..')) {
      throw new Error('Invalid bundled PDF asset.');
    }
    if(kind==='preview_engine'&&name!=='pdfium.wasm')throw new Error('Invalid bundled preview asset.');
    const kindRoot=kind==='preview_engine'?previewAssetRoot:path.join(assetRoot,kind);
    const resolved = await realpath(path.join(kindRoot, name));
    const allowed = await realpath(kindRoot);
    if (path.dirname(resolved) !== allowed) throw new Error('Asset escapes its package directory.');
    const metadata = await stat(resolved);
    if (!metadata.isFile() || metadata.size > 16 * MAX_CHUNK) throw new Error('Invalid bundled asset size.');
    return { base64: (await readFile(resolved)).toString('base64') };
  }
}
