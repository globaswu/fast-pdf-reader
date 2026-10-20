import { build } from 'esbuild';
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectBundledLicenses } from './scripts/collect-licenses.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const plugins = path.join(root, 'plugins');
const output = path.join(plugins, 'fast-pdf-reader');
await mkdir(plugins, { recursive: true });
if (await realpath(plugins) !== path.join(await realpath(root), 'plugins')) {
  throw new Error('The generated plugins directory must remain inside this source tree.');
}

// Build the complete runtime before replacing an earlier generated bundle.
const staged = await mkdtemp(path.join(plugins, '.fast-pdf-reader-stage-'));
try {
  await mkdir(path.join(staged, '.codex-plugin'), { recursive: true });
  await mkdir(path.join(staged, 'dist'), { recursive: true });
  const serverBuild = await build({
    absWorkingDir: root, entryPoints: ['server.mjs'], outfile: path.join(staged, 'server.mjs'),
    bundle: true, platform: 'node', format: 'esm', target: 'node22', minify: true,
    metafile: true,
    banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
    legalComments: 'linked',
  });

  // This write-free analysis uses the viewer's build entrypoints. Inline worker
  // strings contain no imports; the preview worker is analyzed as its own entry.
  const browserBuild = await build({
    absWorkingDir: root, entryPoints: ['src/viewer.mjs', 'src/preview-worker.mjs', 'src/viewer.css'],
    outdir: path.join(staged, 'analysis-only'), write: false, bundle: true,
    platform: 'browser', format: 'esm', target: 'chrome124', minify: true,
    metafile: true, legalComments: 'inline',
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.gif': 'dataurl' },
    define: { __PDF_WORKER_SOURCE__: '""', __PREVIEW_WORKER_SOURCE__: '""' },
  });

  for (const relative of ['.codex-plugin/plugin.json', '.mcp.json', 'dist/ui.html',
    'USAGE.txt', 'LICENSE', 'PRIVACY.md', 'THIRD_PARTY.md']) {
    await cp(path.join(root, relative), path.join(staged, relative));
  }
  const nativeSource = await readFile(path.join(root, 'native-recorder/SmoothPdfRecorder.cs'));
  const nativeBytes = await readFile(path.join(root, 'native-recorder/bin/SmoothPdfRecorder.exe'));
  const nativeManifest = JSON.parse(await readFile(path.join(root, 'native-recorder/bin/recorder-manifest.json'), 'utf8'));
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  if (nativeManifest.sourceSha256 !== sha256(nativeSource) ||
      nativeManifest.sha256 !== sha256(nativeBytes) || nativeManifest.bytes !== nativeBytes.length ||
      nativeManifest.activation !== 'explicit-inline-button' || nativeManifest.nativeWindows !== false ||
      nativeManifest.startsOnlyOnExplicitCommand !== true) {
    throw new Error('The packaged native recorder must match its reviewed source and inline-only manifest.');
  }
  for (const relative of ['native-recorder/bin/SmoothPdfRecorder.exe', 'native-recorder/bin/recorder-manifest.json',
    'scripts/install-dictation-runtime.ps1']) {
    await mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
    await cp(path.join(root, relative), path.join(staged, relative));
  }
  const pdfRoot = path.join(root, 'node_modules/pdfjs-dist');
  for (const kind of ['cmaps', 'standard_fonts', 'wasm']) {
    await cp(path.join(pdfRoot, kind), path.join(staged, 'vendor/pdfjs', kind), { recursive: true });
  }
  await mkdir(path.join(staged, 'vendor/pdfium'), { recursive: true });
  await cp(path.join(root, 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm'),
    path.join(staged, 'vendor/pdfium/pdfium.wasm'));

  const components = await collectBundledLicenses({
    root, destination: staged, metafiles: [serverBuild.metafile, browserBuild.metafile],
    // PDF.js's raw worker and both renderer asset trees are copied above.
    additionalPackages: ['pdfjs-dist', '@embedpdf/pdfium'],
  });
  await writeFile(path.join(staged, 'third-party-versions.json'), JSON.stringify({
    schema: 'fast-pdf-reader-bundled-dependencies/v1', components,
  }, null, 2) + '\n');
  await writeFile(path.join(staged, 'package.json'), JSON.stringify({
    name: packageInfo.name, version: packageInfo.version, private: true, type: 'module',
    author: packageInfo.author, license: packageInfo.license, engines: packageInfo.engines,
  }, null, 2) + '\n');

  const prior = await lstat(output).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (prior) {
    if (!prior.isDirectory() || prior.isSymbolicLink() || await realpath(output) !== output) {
      throw new Error('Refusing to replace a runtime output that is not a regular generated directory.');
    }
    const previous = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
    if (previous.name !== 'fast-pdf-reader' || previous.private !== true) {
      throw new Error('Refusing to replace a directory without the generated runtime package identity.');
    }
    // Keep an exact rollback copy of the previous generated release.
    const backups = path.join(root, '.release-staging');
    await mkdir(backups, { recursive: true });
    if (await realpath(backups) !== path.join(await realpath(root), '.release-staging')) {
      throw new Error('Release backups must remain inside this source tree.');
    }
    await rename(output, path.join(backups, `runtime-before-${packageInfo.version}-${randomUUID()}`));
  }
  await rename(staged, output);
  console.log(`Bundled Smooth PDF Reader ${packageInfo.version}: ${components.length} dependency versions with notices.`);
} finally {
  // This unique path was created by this invocation, directly under plugins.
  await rm(staged, { recursive: true, force: true });
}
