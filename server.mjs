import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { OpenAIExtensions, getResourcePath } from '@openai/mcp-extensions/server';
import { z } from 'zod';
import { DocumentStore, MAX_CHUNK } from './document-store.mjs';
import { openSelectedPdf } from './file-actions.mjs';

export const UI_URI = 'ui://fast-pdf-reader/v1-0-0/viewer.html';

export function createServer() {
  const server = new McpServer({ name: 'fast-pdf-reader', version: '1.0.0' });
  new OpenAIExtensions(server);
  const store = new DocumentStore();
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
  registerAppResource(server, 'Fast PDF Reader', UI_URI, {}, async () => ({
    contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE,
      text: await readFile(new URL('./dist/ui.html', import.meta.url), 'utf8'),
      _meta: { ui: { csp: { connectDomains: [], resourceDomains: ['blob:', 'data:'] } },
        'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen'] } },
    }],
  }));
  registerAppTool(server, 'pdf_open', {
    title: 'Fast PDF Reader', description: 'Read a local PDF with continuous scrolling and selection-based change requests.',
    inputSchema: { file: z.object({ name: z.string(), resourceUri: z.string() }) },
    annotations: readOnly,
    _meta: { ui: { resourceUri: UI_URI, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'file', extensions: ['.pdf'] }] } },
  }, async () => ({ content: [], structuredContent: { viewer: 'fast-pdf-reader', version: '1.0.0' } }));
  registerAppTool(server, 'pdf_launch', {
    title:'Fast PDF Reader', description:'Open the local PDF reader. Rendering stays local; explicitly added comments go to host draft/context. For an existing file-panel selection use the file handler.',
    inputSchema:{}, annotations:readOnly,
    _meta:{ui:{resourceUri:UI_URI},'openai/ui':{entrypoints:[{type:'thread'}]}},
  }, async()=>({content:[{type:'text',text:'Fast PDF Reader is ready. Open a local PDF in the reader; PDF rendering does not upload the document.'}],structuredContent:{viewer:'fast-pdf-reader',version:'1.0.0',launcher:true}}));
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
  await createServer().connect(new StdioServerTransport());
}
