# Privacy

Fast PDF Reader is a local desktop plugin. It has no developer-operated backend, account system, advertising or telemetry.

## Reading documents

The local MCP server supplies bounded byte ranges from the host-selected PDF. Browser file-picker input is read locally by the viewer. PDF.js and PDFium parse, render and extract text on the local machine. The plugin keeps document buffers, page appearances and text caches in memory and releases them when the viewer closes; it does not create a persistent document-rendering cache. Host-managed file/resource storage and retention remain subject to the host's own policies.

The renderer does not execute PDF document JavaScript or XFA. PDF-provided hyperlinks can open external destinations when clicked; those sites have their own policies.

## Comments and change requests

When you explicitly add a change request, the plugin supplies selected text or figure coordinates, physical PDF page numbers, your comment, document identity and the document name or local path to the host's draft or context interface. A supported draft is not sent automatically; you review and submit it. Native browser annotation, where available, is handled by the host. Host chat, context, diagnostic logging and retention are governed by your host/account settings.

Viewer history is memory-only. Removing history does not retract content already added to the host. Do not add confidential selections to a chat unless you intend the host to receive them.

## Support

GitHub issues are public. Use only non-sensitive reproduction material. Do not upload confidential documents, credentials, recordings or full local paths. There is no private-document upload requirement for using this plugin.
