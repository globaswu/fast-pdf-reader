# Smooth PDF Reader

**Smooth local PDF reading, crisp page previews and contextual comments inside Codex.**

Smooth PDF Reader keeps page appearances ready for continuous scrolling and prepares selectable text independently of expensive graphics rendering. A compact, single-row toolbar gives you page navigation, zoom, search, bookmarks and figure-region selection.

Select a passage, choose **Ask for change**, and compose a request in the nearby inline editor. Press **Enter** to save or **Shift+Enter** for a new line. Requested passages remain highlighted during the reader session. Collect several comments, then use **Send to dialogue box** to attach the complete batch as context in a compatible host. The plugin does not type comments into your main input box or send a message.

This is an independent community plugin by **Sen Wu**, distributed under the **MIT licence**. It does not modify Codex application binaries, require Acrobat, or use a special Codex launcher. It is not an official OpenAI product. The stable repository and installation identifier remain `fast-pdf-reader`.

## Version 1.1.0

This desktop release packages the interaction updates developed through local reader 0.5.13:

- Context-only comment batches, with explicit handoff and no automatic chat submission.
- An inline Ask for change editor, Enter/Shift+Enter controls and source-bound selection highlights.
- New-version notices for supported host-selected local files, with explicit **Open new version**.
- Hyperlink hover feedback and URL display; dragging across a link selects text instead of dragging the link.
- Optional Windows x64 offline dictation directly into the same comment editor.

The public-directory edition is hosted and renders PDFs in your browser. It shares portable reader interactions but cannot execute a Windows microphone helper or inspect arbitrary local paths. Offline dictation and operating-system file actions belong to this separate desktop edition. Document-change detection depends on the host's file capabilities; a one-time browser file selection does not grant continued filesystem access.

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

Alternatively, add `https://github.com/globaswu/fast-pdf-reader` as a repository marketplace in a compatible desktop client's plugin settings, then install **Smooth PDF Reader**. The ready-to-install bundle is already included; no source build is required for reading and commenting.

Send or otherwise preserve pending comments before closing the reader. Close and reopen the PDF panel after installation. If the old viewer/server remains loaded, restart Codex normally. Choose **Smooth PDF Reader** if the host presents a viewer selector, or ask Codex to open it and use **Open PDF** from the **⋯** menu.

### ZIP download

Download the current desktop ZIP from [Releases](https://github.com/globaswu/fast-pdf-reader/releases/latest) and extract it. Add the **extracted root folder**, containing `.agents/plugins/marketplace.json`, as a local marketplace:

```sh
codex plugin marketplace add /absolute/path/to/extracted-folder
codex plugin add fast-pdf-reader@fast-pdf-reader
```

Quote paths containing spaces. Do not add only the nested plugin folder as the marketplace root.

## Read and comment

- Scroll normally; page previews prepare in the background. Distant cold jumps can precede preparation.
- Enter a physical PDF page number, use previous/next, choose a zoom level, or open the outline.
- Use the magnifying-glass icon or **Ctrl+F** to search. The circular-arrow icon reloads a changed PDF.
- Select text and choose the nearby **Ask for change** action, or press **Ctrl+Shift+X** (**Ctrl+I** also works). Use the region icon for a figure.
- Enter the change and press **Enter** to collect it; **Shift+Enter** inserts a new line.
- Open **Comments**, review the batch, then click **Send to dialogue box**. The host receives context, not typed input. Send your host message yourself.
- The **Comments** panel and highlights are session-only. Keep the reader open until your host message has been sent. Removing a comment does not retract an already sent chat message. Unsupported hosts report that context attachment is unavailable; no input-box fallback is used.
- **⋯** contains Open PDF, Show in folder and Open externally. The latter two require a trusted host-supplied local path; browser file pickers do not expose a full path.

## Optional offline Windows dictation

The packaged recorder is plugin-owned and uses Windows WASAPI. Speech recognition uses the separately installed, pinned multilingual Whisper base model through whisper.cpp. Audio is not uploaded to a developer service or OpenAI API.

From the extracted release folder, explicitly install the optional speech runtime:

```powershell
powershell -NoProfile -File .\scripts\install-dictation-runtime.ps1
```

This downloads a hash-checked runtime and model (approximately 149 MiB of downloads) into `%LOCALAPPDATA%\SmoothPdfReader\voice-runtime`. It does not run on plugin installation, change Windows microphone permissions, change script execution policy, or start recording. Follow your device's approved script-execution procedure if policy blocks the installer. Reading and typed comments work without this runtime.

After installation, click the microphone in the inline comment editor. **Enter** or **Stop** ends capture and transcribes into that same editor; **Cancel** discards the recording without discarding typed text. Review the transcript before saving. Capture is limited to 120 seconds and stops when its UI lease is lost. Windows microphone permissions and the host's tool approvals still apply. No separate recorder window is opened.

## Privacy and host integration

PDF parsing, rasterization, text extraction and page caches run locally. There is no plugin-owned upload endpoint, telemetry service or persistent document-rendering cache. Document reads are restricted to the host-selected PDF and bundled rendering assets. Optional dictation separately accesses its verified speech runtime and temporary recognition files.

**Send to dialogue box deliberately transfers the collected batch into the host application.** Saving a comment alone keeps it in the reader. Explicit handoff attaches selected text or region coordinates, document name/path, page number and comments as host context, without typing into the chat input. The host's privacy and retention settings then apply. Follow PDF hyperlinks only if you intend to open their destination. See [PRIVACY.md](PRIVACY.md).

Ask for change depends on host capabilities. The plugin provides its own anchored editor and uses the host's advertised context interface for explicit batch delivery. It does not embed Codex's built-in editor or dictation implementation. If context attachment is absent, comments remain in the reader and the UI reports that limitation.

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
powershell -NoProfile -File .\native-recorder\build-recorder.ps1
pnpm build
pnpm test
pnpm bundle
pnpm test:bundle
pnpm audit:release
```

`plugins/fast-pdf-reader` is the distributable runtime; `src` contains the unminified viewer. The Windows helper's C# source, build script, binary hash and source hash are included. Building it requires the installed Windows .NET Framework C# compiler. Tests use synthetic fixtures; no private PDFs, traces, recordings, speech models or user documents are included in the release.

The original scrolling/selection workflow was exercised locally on Windows; automated tests cover cache lifecycles, text handoff, bounded reads, toolbar controls and the MCP transport. These checks are not a cross-platform performance guarantee.

## Support and licence

Report reproducible bugs in [Issues](https://github.com/globaswu/fast-pdf-reader/issues). Include host/plugin versions and a short description. Please do not post private PDFs, credentials, full machine paths or confidential screenshots.

Original code: [MIT](LICENSE), copyright 2026 Sen Wu. Bundled components retain their own licences and notices in `plugins/fast-pdf-reader/licenses`; see [THIRD_PARTY.md](THIRD_PARTY.md).

Repository marketplaces are distinct from the official directory. OpenAI's [plugin packaging guide](https://developers.openai.com/plugins/build/plugins) describes repository distribution; [directory submission](https://developers.openai.com/plugins/deploy/submission) is a separate reviewed process.
