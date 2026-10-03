# Fast PDF Reader

**Smooth local PDF reading, crisp page previews and contextual comments inside Codex.**

Fast PDF Reader keeps page appearances ready for continuous scrolling and prepares selectable text independently of expensive graphics rendering. A compact, single-row toolbar gives you page navigation, zoom, search, bookmarks and figure-region selection.

Select a passage, choose **Ask for change**, and compose a request linked to the source page. In compatible Codex hosts, **Add to chat** appends an unsent draft; you review and send it yourself.

This is an independent community plugin by **Sen Wu**, distributed under the **MIT licence**. It does not modify Codex application binaries, require Acrobat, or use a special Codex launcher. It is not an official OpenAI product or an approved public-directory listing.

## Install

### Requirements

- A desktop Codex/ChatGPT host with local MCP plugins, MCP Apps and file-viewer or thread-panel entrypoints. The development build was validated with host UI version `26.930.31730`; support can vary by release.
- **Node.js 22.13 or newer**, available as `node` on the desktop app's PATH. Run `node --version` in a terminal. If Node was just installed, restart the desktop app so it receives the updated PATH.
- Windows is the validated platform. Show in folder and Open externally currently use Windows file actions. Other platforms have not been validated.

### Repository marketplace

With the Codex CLI installed:

```sh
codex plugin marketplace add globaswu/fast-pdf-reader
codex plugin add fast-pdf-reader@fast-pdf-reader
```

Alternatively, add `https://github.com/globaswu/fast-pdf-reader` as a repository marketplace in a compatible desktop client's plugin settings, then install **Fast PDF Reader**. The ready-to-install bundle is already included; no source build is required.

Close and reopen the PDF panel after installation. If the old viewer remains loaded, restart Codex normally. Choose **Fast PDF Reader** if the host presents a viewer selector, or ask Codex to open Fast PDF Reader and use **Open PDF** from the **⋯** menu.

### ZIP download

Download `fast-pdf-reader-v1.0.0.zip` from [Releases](https://github.com/globaswu/fast-pdf-reader/releases/latest) and extract it. Add the **extracted root folder**, containing `.agents/plugins/marketplace.json`, as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/extracted-folder
codex plugin add fast-pdf-reader@fast-pdf-reader
```

Quote paths containing spaces. Do not add only the nested plugin folder as the marketplace root.

## Read and comment

- Scroll normally; page previews prepare in the background. Distant cold jumps can precede preparation.
- Enter a physical PDF page number, use previous/next, choose a zoom level, or open the outline.
- Use the magnifying-glass icon or **Ctrl+F** to search. The circular-arrow icon reloads a changed PDF.
- Select text and choose the nearby **Ask for change** action, or press **Ctrl+I**. Use the region icon for a figure.
- Enter the change and choose **Add to chat** when supported. The viewer never sends the message automatically.
- The **Comments** panel is viewer history. Removing an entry there does not remove text already placed in the chat draft. Save pending comments before closing or changing the document.
- **⋯** contains Open PDF, Show in folder and Open externally. The latter two require a trusted host-supplied local path; browser file pickers do not expose a full path.

## Privacy and host integration

PDF parsing, rasterization, text extraction and page caches run locally. There is no plugin-owned upload endpoint, telemetry service or persistent document-rendering cache. The small local server reads only the host-selected PDF and bundled rendering assets.

**Adding a comment is a deliberate transfer into the host application.** The selected text or region coordinates, document name/path, page number and your comment can be added to the chat draft or host context. The host's privacy and retention settings then apply. Follow PDF hyperlinks only if you intend to open their destination. See [PRIVACY.md](PRIVACY.md).

Ask for change depends on host capabilities. The plugin uses native browser annotation when available; otherwise it provides its own anchored editor and the host's advertised draft/context interface. It does not embed the built-in PDF editor. If draft support is absent, the UI reports whether context attachment or viewer-only storage is available.

## Rendering design

- PDFium prepares 1,200-pixel page appearances in a 128 MiB compressed cache; visible higher-zoom appearances use a separate 64 MiB target.
- PDF.js provides the native scroll layout, detailed canvas, links, search and text geometry.
- An independent text-only worker avoids waiting behind graphics decoding. Nearby text is bounded to 24 pages / 8 MiB estimated.
- Visible pages receive priority. There is no scroll-settled display gate, and the retained preview worker goes idle when its queue empties.
- The native canvas target is 192 MiB. These are component budgets, not a total-process RAM cap: PDF buffers, decoder heaps, decoded images and GPU resources add memory; protected visible content can exceed soft targets.

This release supports ordinary text-bearing PDFs. It is not an OCR engine; scanned pages without a text layer cannot provide text selection. Password-protected documents are not supported. File-picker loading is capped at 512 MiB. Performance depends on document complexity, zoom, hardware and the host.

## Build and test

Source and the locked dependencies are included. With Node.js and pnpm installed:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm bundle
pnpm test:bundle
pnpm audit:release
```

`plugins/fast-pdf-reader` is the distributable runtime; `src` contains the unminified viewer. Tests generate synthetic PDF bytes in temporary directories. No private PDFs, traces or user documents are included.

The original scrolling/selection workflow was exercised locally on Windows; automated tests cover cache lifecycles, text handoff, bounded reads, toolbar controls and the MCP transport. These checks are not a cross-platform performance guarantee.

## Support and licence

Report reproducible bugs in [Issues](https://github.com/globaswu/fast-pdf-reader/issues). Include host/plugin versions and a short description. Please do not post private PDFs, credentials, full machine paths or confidential screenshots.

Original code: [MIT](LICENSE), copyright 2026 Sen Wu. Bundled components retain their own licences and notices in `plugins/fast-pdf-reader/licenses`; see [THIRD_PARTY.md](THIRD_PARTY.md).

Repository marketplaces are distinct from the official directory. OpenAI's [plugin packaging guide](https://developers.openai.com/plugins/build/plugins) describes repository distribution; [directory submission](https://developers.openai.com/plugins/deploy/submission) is a separate reviewed process.
