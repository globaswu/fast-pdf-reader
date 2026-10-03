// Public PDFium/WASM preview renderer. The UI controls the priority queue; this
// worker executes at most one page at a time and never fetches document/network
// resources. It is independent from PDF.js text/annotation/high-resolution work.
import { init } from '@embedpdf/pdfium';

let pdfium = null;
let documentHandle = 0;
let filePointer = 0;
let pageCount = 0;
let canvas = null;
let context = null;
let queue = Promise.resolve();
let pending = 0;
let disposed = false;
let renderCount = 0;
const MAX_PREVIEW_PIXELS = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('Local PDFium WASM was not bundled.');
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(value);
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function closeDocument() {
  if (documentHandle && pdfium) pdfium.FPDF_CloseDocument(documentHandle);
  documentHandle = 0;
  if (filePointer && pdfium) pdfium.pdfium.wasmExports.free(filePointer);
  filePointer = 0;
  pageCount = 0;
  if (canvas) { canvas.width = 1; canvas.height = 1; }
  canvas = null;
  context = null;
}

async function initialize(message) {
  if (documentHandle) throw new Error('The preview worker already has an open document.');
  const bytes = message.bytes instanceof ArrayBuffer ? new Uint8Array(message.bytes) : message.bytes;
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_DOCUMENT_BYTES) {
    throw new Error('A nonempty PDF buffer of at most 512 MiB is required.');
  }
  const started = performance.now();
  if (!pdfium) {
    const wasmBinary = message.wasmBinary || decodeBase64(self.__PDFIUM_WASM_BASE64__);
    // Blob workers cannot resolve a relative URL against import.meta.url.
    // The bytes are already local; this symbolic locator must never fetch.
    pdfium = await init({ wasmBinary, locateFile: name => name });
    pdfium.PDFiumExt_Init();
  }
  const initialized = performance.now();
  filePointer = pdfium.pdfium.wasmExports.malloc(bytes.length);
  if (!filePointer) throw new Error('Unable to allocate PDF preview memory.');
  try {
    pdfium.pdfium.HEAPU8.set(bytes, filePointer);
    documentHandle = pdfium.FPDF_LoadMemDocument(filePointer, bytes.length, '');
    if (!documentHandle) throw new Error(`Preview document could not be opened (PDFium ${pdfium.FPDF_GetLastError()}).`);
    pageCount = pdfium.FPDF_GetPageCount(documentHandle);
    if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('Preview document contains no pages.');
    return { type: 'ready', pageCount, initMs: initialized - started, openMs: performance.now() - initialized,
      wasmBytes: pdfium.pdfium.HEAPU8.buffer.byteLength };
  } catch (error) {
    closeDocument();
    throw error;
  }
}

async function render(message) {
  if (!documentHandle) throw new Error('Open a document before rendering a preview.');
  const pageNumber = message.pageNumber;
  const requestedWidth = message.width ?? 600;
  const format = message.format ?? 'webp';
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) throw new Error('Preview page number is out of range.');
  if (!Number.isFinite(requestedWidth) || requestedWidth < 64 || requestedWidth > 1600) throw new Error('Preview width must be between 64 and 1600 pixels.');
  if (!['png', 'webp'].includes(format)) throw new Error('Preview format must be png or webp.');
  const started = performance.now();
  const page = pdfium.FPDF_LoadPage(documentHandle, pageNumber - 1);
  if (!page) throw new Error(`Unable to open preview page ${pageNumber}.`);
  let bitmap = 0;
  let pixels;
  let width;
  let height;
  let pageWidth;
  let pageHeight;
  try {
    pageWidth = pdfium.FPDF_GetPageWidthF(page);
    pageHeight = pdfium.FPDF_GetPageHeightF(page);
    if (!(pageWidth > 0 && pageHeight > 0 && Number.isFinite(pageWidth + pageHeight))) throw new Error('Invalid PDF page dimensions.');
    width = Math.round(requestedWidth);
    height = Math.max(1, Math.round(width * pageHeight / pageWidth));
    if (!Number.isFinite(height)) throw new Error('The PDF page aspect ratio is unsupported.');
    if (width * height > MAX_PREVIEW_PIXELS) {
      const reduction = Math.sqrt(MAX_PREVIEW_PIXELS / (width * height));
      width = Math.max(1, Math.floor(width * reduction));
      height = Math.max(1, Math.floor(height * reduction));
      // Extreme-aspect pages may round width up from below one pixel. Reapply
      // the budget after integer rounding so a pathological page cannot OOM.
      height = Math.min(height, Math.floor(MAX_PREVIEW_PIXELS / width));
    }
    bitmap = pdfium.FPDFBitmap_Create(width, height, 1);
    if (!bitmap) throw new Error('Unable to allocate preview bitmap.');
    pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    // FPDF_ANNOT | FPDF_REVERSE_BYTE_ORDER: ordinary annotations and RGBA pixels.
    // No form event handlers or document JavaScript are executed here.
    pdfium.FPDF_RenderPageBitmap(bitmap, page, 0, 0, width, height, 0, 1 | 16);
    const pointer = pdfium.FPDFBitmap_GetBuffer(bitmap);
    const stride = pdfium.FPDFBitmap_GetStride(bitmap);
    if (!pointer || stride < width * 4) throw new Error('Invalid preview bitmap buffer.');
    pixels = new Uint8ClampedArray(width * height * 4);
    const heap = pdfium.pdfium.HEAPU8;
    if (stride === width * 4) pixels.set(heap.subarray(pointer, pointer + pixels.length));
    else for (let row = 0; row < height; row++) pixels.set(heap.subarray(pointer + row * stride, pointer + row * stride + width * 4), row * width * 4);
  } finally {
    if (bitmap) pdfium.FPDFBitmap_Destroy(bitmap);
    pdfium.FPDF_ClosePage(page);
  }
  const rendered = performance.now();
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Offscreen canvas rendering is unavailable.');
  } else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await canvas.convertToBlob({ type: `image/${format}`, quality: 0.78 });
  const buffer = await blob.arrayBuffer();
  renderCount++;
  return { type: 'rendered', pageNumber, width, height, pageWidth, pageHeight, buffer,
    mime: blob.type, renderMs: rendered - started, encodeMs: performance.now() - rendered,
    renderCount, wasmBytes: pdfium.pdfium.HEAPU8.buffer.byteLength };
}

self.onmessage = event => {
  const message = event.data || {};
  if (disposed) return;
  // The controller sends one render at a time. Keep malformed/duplicate callers
  // from creating a hidden unbounded render queue; permit one pending dispose.
  if (pending >= 2) {
    self.postMessage({ id: message.id, type: 'error', message: 'The preview worker queue is full.' });
    return;
  }
  pending++;
  queue = queue.then(async () => {
    if (disposed) return;
    try {
      let result;
      if (message.type === 'init') result = await initialize(message);
      else if (message.type === 'render') result = await render(message);
      else if (message.type === 'dispose') {
        closeDocument();
        if (pdfium) pdfium.FPDF_DestroyLibrary();
        pdfium = null;
        disposed = true;
        result = { type: 'disposed' };
      } else throw new Error('Unknown preview worker operation.');
      const transfers = result.buffer instanceof ArrayBuffer ? [result.buffer] : [];
      self.postMessage({ id: message.id, ...result }, transfers);
      if (disposed) self.close();
    } catch (error) {
      self.postMessage({ id: message.id, type: 'error', message: String(error?.message || error) });
    }
  }).finally(() => { pending--; });
};
