# Third-party components

Fast PDF Reader's original code is MIT licensed. That licence does not replace the licences of bundled dependencies.

The runtime includes Mozilla PDF.js (Apache-2.0), PDFium through `@embedpdf/pdfium` (MIT wrapper and PDFium's BSD/third-party notices), the Model Context Protocol SDK and MCP Apps SDK, OpenAI MCP Extensions, Zod and their bundled dependencies. Exact versions and available licence/notice files are generated into `plugins/fast-pdf-reader/third-party-versions.json` and `plugins/fast-pdf-reader/licenses` during bundling. Any linked legal-notice file emitted by the bundler is retained.

Rebuilds use the pinned `pnpm-lock.yaml`. Source code for these dependencies is available through their published npm package metadata. The renderer does not include Adobe Acrobat code or extracted Codex application code.
