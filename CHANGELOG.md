# Changelog

## 1.1.0 — 2026-10-20

Packages the interaction updates developed through local reader 0.5.13, with
portable public paths and the display name Smooth PDF Reader. Repository,
marketplace, MCP server identifier and the previous desktop UI resource URI
remain compatible.

- Collect change requests in a context-only batch; explicit Send to dialogue box
  does not overwrite the user's typed input or automatically send a message.
- Inline selection-anchored comment editor, Enter to save, Shift+Enter for a new
  line, and Ctrl+Shift+X with the existing Ctrl+I alias.
- Highlight requested passages and selected regions throughout the open session.
- Detect supported local-file revision changes and offer Open new version.
- Restore hyperlink hover highlighting and destination display while making
  click-and-drag select text.
- Optional plugin-owned Windows recorder and offline recognition into the same
  input, with no popup recorder window. The model/runtime installer is opt-in;
  recording requires an explicit click and respects Windows microphone settings.
- Keep the rendering/cache architecture of the previous smooth reader.

The hosted directory edition receives portable UI updates separately. Its
remote MCP service does not gain access to the Windows microphone or arbitrary
local files. Existing hosted tools and UI URI are retained.

## 1.0.0 — 2026-10-04

Initial public release of Fast PDF Reader, based on the locally validated reader:

- Continuous scrolling with crisp cached page appearances and foreground rendering priority.
- Independent early text selection and pinned selection handoff.
- Contextual text/figure change requests with explicit unsent-draft integration where supported.
- One-row icon toolbar, search, outline, page entry and zoom.
- Source-bound local PDF access and bundled PDF.js/PDFium assets.
- Portable Node.js launch configuration, MIT licence and public installation instructions.
