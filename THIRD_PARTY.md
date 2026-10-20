# Third-party components

Smooth PDF Reader's original code, including the Windows recorder source, is MIT licensed. That licence does not replace the licences of bundled dependencies.

The runtime includes Mozilla PDF.js (Apache-2.0), PDFium through `@embedpdf/pdfium` (MIT wrapper and PDFium's BSD/third-party notices), the Model Context Protocol SDK and MCP Apps SDK, OpenAI MCP Extensions, Zod and their bundled dependencies. Exact versions and available licence/notice files are generated into `plugins/fast-pdf-reader/third-party-versions.json` and `plugins/fast-pdf-reader/licenses` during bundling. Any linked legal-notice file emitted by the bundler is retained.

Rebuilds use the pinned `pnpm-lock.yaml`. Source code for these dependencies is available through their published npm package metadata. The renderer does not include Adobe Acrobat code or extracted Codex application code.

The optional speech installer downloads whisper.cpp's pinned official Windows CPU distribution (build b5130) and the multilingual Whisper base model. These are not included in the plugin ZIP. The installer verifies exact download hashes and retains the distribution's files, including its licence notices. The source projects are [whisper.cpp](https://github.com/ggml-org/whisper.cpp) and [Whisper](https://github.com/openai/whisper), both MIT licensed. The bundled original Windows recorder calls the operating system's WASAPI interfaces and requires Windows; it does not redistribute Windows or Codex components.
