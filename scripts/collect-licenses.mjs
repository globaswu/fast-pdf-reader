import { cp, mkdir, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const isNotice = name => /^(?:licen[sc]e|notice|copying|authors)(?:[._-]|$)|^third[_-]party[_-](?:notices|licenses)/i.test(name);
const portable = value => value.split(path.sep).join('/');

async function packageAt(directory) {
  try {
    const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    return info.name && info.version ? { directory, info } : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

async function packageForInput(root, input) {
  if (!portable(input).split('/').includes('node_modules')) return null;
  let directory = path.dirname(await realpath(path.resolve(root, input)));
  while (path.dirname(directory) !== directory) {
    const found = await packageAt(directory);
    if (found) return found;
    directory = path.dirname(directory);
  }
  throw new Error('Could not identify a bundled dependency package.');
}

async function noticeFiles(directory, relative = '') {
  const result = [];
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.isSymbolicLink()) continue;
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) result.push(...await noticeFiles(directory, next));
    else if (entry.isFile() && isNotice(entry.name)) result.push(next);
  }
  return result.sort();
}

// Inventory esbuild's actual bundled inputs, not every installed dependency.
// Published entries contain package identities and portable notice paths only.
export async function collectBundledLicenses({ root, destination, metafiles, additionalPackages = [] }) {
  const packages = new Map();
  const remember = found => {
    if (found) packages.set(`${found.info.name}@${found.info.version}`, found);
  };
  for (const metafile of metafiles) {
    const included = new Set(Object.values(metafile.outputs).flatMap(output =>
      Object.entries(output.inputs).filter(([, contribution]) => contribution.bytesInOutput > 0)
        .map(([input]) => input)));
    for (const input of included) remember(await packageForInput(root, input));
  }
  for (const name of additionalPackages) {
    const directory = await realpath(path.join(root, 'node_modules', name));
    const found = await packageAt(directory);
    if (!found) throw new Error(`Could not identify packaged renderer ${name}.`);
    remember(found);
  }

  const components = [];
  for (const [identity, { directory, info }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const folder = path.join('licenses', identity.replaceAll('/', '__'));
    const files = await noticeFiles(directory);
    const record = { name: info.name, version: info.version,
      declaredLicense: info.license ?? null, noticeFiles: [] };
    for (const relative of files) {
      const target = path.join(folder, relative);
      await mkdir(path.dirname(path.join(destination, target)), { recursive: true });
      await cp(path.join(directory, relative), path.join(destination, target));
      record.noticeFiles.push(portable(target));
    }
    if (!files.length) {
      if (identity !== '@cfworker/json-schema@4.1.1') {
        throw new Error(`No license or notice file found for bundled dependency ${identity}.`);
      }
      // The npm 4.1.1 tarball omits its repository's MIT licence. Keep a
      // version-pinned upstream copy in source so bundling remains offline.
      const fallback = path.join(root, 'third-party', 'cfworker-json-schema-4.1.1');
      const target = path.join(folder, 'LICENSE.md');
      await mkdir(path.join(destination, folder), { recursive: true });
      await cp(path.join(fallback, 'LICENSE.md'), path.join(destination, target));
      record.noticeFiles.push(portable(target));
      record.noticeSource = JSON.parse(await readFile(path.join(fallback, 'provenance.json'), 'utf8'));
    }
    components.push(record);
  }
  return components;
}
