import { readFile, mkdir, cp, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Build a new metadata package without changing a previously reviewed package.
// The hosted viewer is deployed separately; native binaries never enter this ZIP.
const [sourceArg, outputArg] = process.argv.slice(2);
assert.ok(sourceArg && outputArg, 'Usage: node scripts/package-directory.mjs existing-package new-output');
const source = await realpath(sourceArg);
const output = path.resolve(outputArg);
assert.ok(output !== source && !source.startsWith(output + path.sep), 'Output must be a separate new directory.');
const manifest = JSON.parse(await readFile(path.join(source, '.codex-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(await readFile(path.join(source, '.mcp.json'), 'utf8'));
assert.equal(manifest.name, 'smooth-pdf-reader');
assert.equal(mcp.mcpServers['fast-pdf-reader'].url,
  'https://smooth-pdf-reader.smooth-pdf-reader-cloudflare.workers.dev/mcp');
manifest.version = '1.1.0';
manifest.description = 'Read PDFs smoothly with an inline Ask for change editor, highlighted selections and explicit comment batches.';
manifest.interface.longDescription = `Read PDFs smoothly inside Codex, with responsive rendering and an inline Ask for change workflow.

Open a local PDF or supported host-provided file with continuous scrolling, cached page images, independent text selection, search, page entry, zoom and bookmarks. Select text or a region, type a comment, and press Enter to save; Shift+Enter adds a line. Saved selections remain highlighted during the reader session. Use Comments > Send to dialogue box to attach the whole batch as context in compatible hosts, without typing into the main input or sending a message.

Hyperlinks display hover feedback and destinations; dragging selects text. Supported host resource updates offer Open new version. Browser-selected files must be selected again to load a new local copy.

PDF contents are processed on your device, not uploaded to this service. The service delivers the interface and libraries; host resources and comments follow the host's privacy settings. This hosted edition does not provide microphone recording or operating-system file actions; optional offline Windows dictation belongs to the separate desktop edition. PDF editing, signing, OCR and password-protected documents are unsupported. Input is limited to 512 MiB; performance depends on the device and document.`;
const review = manifest.extensions['com.openai'].review;
review.test_cases.positive[3].expected_behavior = "On page 1 select 'Select this sentence to request a wording change.' and choose Ask for change or Ctrl+Shift+X (Ctrl+I also works). Type a comment, test Shift+Enter for a newline, then cancel once: nothing should be collected or sent. Repeat and press Enter: one comment is collected and its selection remains highlighted. Add a page-2 region comment. Open Comments and choose Send to dialogue box in a supported host: both comments must arrive together as context with the correct source/page/selection, without altering the typed composer text or sending a message. Standalone or unsupported hosts must explain that context attachment is unavailable; do not count that fallback as successful host delivery. Confirm that the hosted editor does not advertise native microphone recording.";
review.test_cases.positive[4].expected_behavior = "Explain Open PDF, physical-page navigation, Find, zoom, Enter/Shift+Enter, saved-selection highlights, and explicit batch context attachment. Distinguish browser-local PDF processing from hosted asset delivery and host handling of comments. Describe host-resource update notices without claiming arbitrary local filesystem watching. State that native offline Windows dictation and OS file actions require the separate desktop edition. Identify password-protected PDFs and OCR as unsupported and state the 512 MiB limit. Do not claim to have read, uploaded, edited, deleted, signed or automatically sent a user document.";
manifest.extensions['com.openai'].publication.release_notes = "Interaction update 1.1.0: inline Ask for change editor with Enter/Shift+Enter, persistent session selection highlights, context-only comment batching through Send to dialogue box, hyperlink hover and drag-selection, and supported host-resource version notices. Existing four hosted tools, remote origin and UI resource URI remain compatible. The Windows desktop release separately packages optional offline inline dictation; no native microphone or filesystem access is added to the hosted service. The existing walkthrough documents the initial release; updated test scenarios describe the new interactions.";
await mkdir(output);
await mkdir(path.join(output, '.codex-plugin'));
await mkdir(path.join(output, 'assets'));
await writeFile(path.join(output, '.codex-plugin/plugin.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
for (const file of ['.mcp.json', 'LICENSE', 'assets/icon-v2.png']) {
  await cp(path.join(source, file), path.join(output, file), { errorOnExist: true, force: false });
}
console.log(JSON.stringify({ version: manifest.version, name: manifest.name, files: 4,
  remoteOriginUnchanged: true, nativeBinaryIncluded: false, output }, null, 2));
