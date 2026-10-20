# Privacy

This document describes the Smooth PDF Reader local desktop package, whose installation identifier remains `fast-pdf-reader`. It has no developer-operated document backend, account system, advertising or telemetry. The separately hosted public-directory edition has its own service privacy notice.

## Reading documents

The local MCP server supplies bounded byte ranges from the host-selected PDF. Browser file-picker input is read locally by the viewer. PDF.js and PDFium parse, render and extract text on the local machine. The plugin keeps document buffers, page appearances and text caches in memory and releases them when the viewer closes; it does not create a persistent document-rendering cache. Host-managed file/resource storage and retention remain subject to the host's own policies.

The renderer does not execute PDF document JavaScript or XFA. PDF-provided hyperlinks can open external destinations when clicked; those sites have their own policies.

## Comments and change requests

Saving a change request collects it in the reader. When you explicitly choose Send to dialogue box, the plugin supplies the batch of selected text or figure coordinates, physical PDF page numbers, comments, document identities and document names or local paths to the host's context interface. It does not type the batch into the main input box or automatically send a message. Host chat, context, diagnostic logging and retention are governed by your host/account settings.

Viewer history is memory-only. Removing history does not retract content already added to the host. Do not add confidential selections to a chat unless you intend the host to receive them.

## Optional local dictation

The Windows desktop edition includes a plugin-owned microphone recorder. It records only after an explicit click in the inline editor; it does not start when the plugin or editor opens. Windows microphone privacy settings and host approvals remain in effect. The helper opens no separate recorder window.

Recognition requires a separately installed, hash-checked whisper.cpp runtime and multilingual base model. The optional installer downloads those public components from GitHub and Hugging Face; those providers receive ordinary download-request metadata. No PDF, comment, audio or transcript is sent in those downloads. The runtime is stored under the user's local application-data folder, outside the plugin's versioned bundle.

Audio is processed on the user's computer. Temporary recognition files are removed after completion, cancellation or handled failure; an abrupt operating-system or process crash can prevent normal cleanup. The recorder has a 120-second capture bound and an expiring UI lease. The transcript is inserted into the same comment input for review and is not automatically attached to chat. It becomes host context only through the explicit comment-batch action described above.

## Support

GitHub issues are public. Use only non-sensitive reproduction material. Do not upload confidential documents, credentials, recordings or full local paths. There is no private-document upload requirement for using this plugin.
