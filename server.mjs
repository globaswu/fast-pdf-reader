import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions, getResourcePath } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { DocumentStore, MAX_CHUNK } from './document-store.mjs';
import { openSelectedPdf } from './file-actions.mjs';
import { createNativeDictationBackend } from './native-recorder.mjs';

export const UI_URI = 'ui://fast-pdf-reader/v1-1-0/viewer.html';
// File preview surfaces may retain the selected entrypoint's resource URI
// across plugin upgrades. Keep the released 1.0 resource link resolvable.
export const LEGACY_UI_URIS = Object.freeze(['ui://fast-pdf-reader/v1-0-0/viewer.html']);

export function createServer({nativeDictation} = {}) {
  const server = new McpServer({ name: 'fast-pdf-reader', version: '1.1.0' });
  new OpenAIExtensions(server);
  const store = new DocumentStore();
  const dictation = nativeDictation ?? createNativeDictationBackend();
  const closeServer = server.close.bind(server);
  server.close = async () => { await dictation.dispose(); await closeServer(); };
  server.server.onclose = () => { void dictation.dispose(); };
  const appOnly = { ui: { visibility: ['app'] } };
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const pathFor = extra => {
    const supplied = getResourcePath(extra._meta);
    if (!supplied) throw Object.assign(new Error('The desktop host has not supplied local file context.'),{code:'MISSING_HOST_FILE_CONTEXT'});
    return supplied;
  };
  const wrap = handler => async (args, extra) => {
    try { return { content: [], structuredContent: await handler(args, extra) }; }
    catch (error) {
      // Do not expose OS errors, arbitrary filesystem paths or PDF bytes in logs.
      const message = /^(A host|Only PDF|Not a PDF|Invalid |Document changed|PDF byte|Unexpected PDF|Asset escapes|The desktop)/.test(error.message)
        ? error.message : 'Local PDF operation failed.';
      const code=error.code==='MISSING_HOST_FILE_CONTEXT'?error.code:['EACCES','EPERM'].includes(error.code)?'PDF_ACCESS_DENIED':error.code==='ENOENT'?'PDF_NOT_FOUND':'LOCAL_PDF_ERROR';
      const detail=code==='PDF_ACCESS_DENIED'?'Permission denied while reading the selected PDF.':code==='PDF_NOT_FOUND'?'The selected PDF path was not found.':message;
      return { isError: true, content: [{ type: 'text', text: detail }], _meta:{localPdfErrorCode:code} };
    }
  };
  for(const resourceUri of [UI_URI,...LEGACY_UI_URIS])registerAppResource(server, 'Smooth PDF Reader', resourceUri, {}, async () => ({
    contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./dist/ui.html', import.meta.url), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: ['blob:', 'data:'] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } },
    }],
  }));
  registerAppTool(server, 'pdf_open', {
    title: 'Smooth PDF Reader', description: 'Read a local PDF with continuous scrolling and selection-based change requests.',
    inputSchema: { file: z.object({ name: z.string(), resourceUri: z.string() }) },
    annotations: readOnly,
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.pdf'] }] } },
  }, async () => ({ content: [], structuredContent: { viewer: 'fast-pdf-reader', version: '1.1.0' } }));
  registerAppTool(server, 'pdf_launch', {
    title:'Smooth PDF Reader', description:'Open the standalone local PDF reader. Use its sidebar entry and Open PDF for a saved PDF from dots; comments attach to the reader chat, not automatically to the original dot conversation.',
    inputSchema:{}, annotations:readOnly,
    _meta:{ui:{resourceUri:UI_URI},'openai/ui':{entrypoints:[{type:'global'},{type:'thread'}]}},
  }, async()=>({content:[{type:'text',text:'Smooth PDF Reader is ready. Choose Open PDF to read a file on this computer. Comments attach to the chat hosting this reader, not automatically to another dot conversation.'}],structuredContent:{viewer:'fast-pdf-reader',version:'1.1.0',launcher:true}}));
  const sessionId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
  const requestId = z.string().uuid();
  const dictationCall = handler => async (args, extra) => {
    try { return { content: [], structuredContent: await handler(args, extra) }; }
    catch (error) {
      const known = /^(?:DICTATION_|NATIVE_|INVALID_DICTATION_)/.test(error.code || '');
      return { isError: true, content: [{ type: 'text', text: known ? error.message : 'Local dictation operation failed.' }],
        _meta: { localPdfErrorCode: known ? error.code : 'DICTATION_FAILED' } };
    }
  };
  // Capture is app-only and user-started; no microphone is opened by info/status.
  // Audio stays between our native helper and local recognizer, never in MCP results.
  registerAppTool(server, 'pdf_dictation_info', {
    description: 'Check the installed local Windows recorder and offline speech recognizer without opening the microphone.',
    inputSchema: {}, annotations: readOnly, _meta: appOnly,
  }, dictationCall(() => dictation.info()));
  registerAppTool(server, 'pdf_dictation_start', {
    description: 'On an explicit inline microphone-button click, start the enabled local recorder without a separate plugin permission window. Windows microphone privacy restrictions still apply. Audio is never uploaded.',
    inputSchema: { requestId }, annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, dictationCall((args, extra) => dictation.start(args, { signal: extra.signal })));
  for (const action of ['status','heartbeat','stop']) registerAppTool(server, `pdf_dictation_${action}`, {
    description: action === 'status' ? 'Read status or the local transcript of this reader-owned recording session.' : action === 'heartbeat' ? 'Renew the short liveness lease of this reader-owned recording; a lost reader stops recording.' : 'Stop this reader-owned microphone recording and transcribe locally; returns status immediately.',
    inputSchema: { sessionId }, annotations: { ...readOnly, readOnlyHint: action === 'status' }, _meta: appOnly,
  }, dictationCall(args => dictation[action](args)));
  registerAppTool(server, 'pdf_dictation_cancel', {
    description: 'Cancel this reader-owned recording or transcription and discard its temporary data.',
    inputSchema: z.object({ sessionId: sessionId.optional(), requestId: requestId.optional() }).refine(args => Boolean(args.sessionId) !== Boolean(args.requestId), 'Specify exactly one session or pending request.'),
    annotations: { ...readOnly, readOnlyHint: false }, _meta: appOnly,
  }, dictationCall(args => dictation.cancel(args)));
  registerAppTool(server, 'pdf_info', {
    description: 'Read identity and size of the host-selected PDF.', inputSchema: {},
    annotations: readOnly, _meta: appOnly,
  }, wrap((args, extra) => store.describe(pathFor(extra))));
  registerAppTool(server, 'pdf_read', {
    description: 'Read a bounded byte range for the local PDF renderer only.',
    inputSchema: { documentId: z.string().regex(/^[0-9a-f]{64}$/),
      begin: z.number().int().min(0), end: z.number().int().min(1) },
    annotations: readOnly, _meta: appOnly,
  }, wrap((args, extra) => {
    if (args.end - args.begin > MAX_CHUNK) throw new Error('Invalid PDF byte range.');
    return store.read(pathFor(extra), args);
  }));
  registerAppTool(server, 'pdf_asset', {
    description: 'Read a packaged font, character map or decoder for the local renderer.',
    inputSchema: { kind: z.enum(['cmaps', 'standard_fonts', 'wasm','preview_engine']), name: z.string().max(160) },
    annotations: readOnly, _meta: appOnly,
  }, wrap(args => store.asset(args)));
  registerAppTool(server, 'pdf_open_external', {
    description: 'On an explicit viewer-button click, reveal the selected PDF in Explorer or open it in the OS default PDF app.',
    inputSchema: { documentId: z.string().regex(/^[0-9a-f]{64}$/), action:z.enum(['folder','default']) },
    annotations: {readOnlyHint:false,destructiveHint:false,openWorldHint:false}, _meta:appOnly,
  }, wrap((args,extra)=>openSelectedPdf(store,pathFor(extra),args)));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createServer();
  process.stdin.once('end', () => { void server.close(); });
  process.once('SIGTERM', () => { void server.close(); });
  process.once('SIGINT', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}
