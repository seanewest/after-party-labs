import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg', '.txt', '.xml']);

function parseArguments(arguments_) {
  const options = {};

  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Expected --name value arguments; received ${key ?? 'nothing'}`);
    }
    options[key.slice(2)] = value;
  }

  return options;
}

function validateBasePath(basePath) {
  if (!basePath.startsWith('/') || !basePath.endsWith('/') || basePath.includes('..')) {
    throw new Error(`Base path must start and end with / and cannot contain ..: ${basePath}`);
  }
}

async function replaceTokens(directory, replacements) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await replaceTokens(entryPath, replacements);
      continue;
    }

    if (!entry.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name))) {
      continue;
    }

    let contents = await readFile(entryPath, 'utf8');
    for (const [token, value] of Object.entries(replacements)) {
      contents = contents.replaceAll(token, value);
    }
    await writeFile(entryPath, contents);
  }
}

export async function buildPages({ source, output, commit, basePath }) {
  if (!source || !output || !commit || !basePath) {
    throw new Error('source, output, commit, and basePath are required');
  }
  validateBasePath(basePath);

  const sourceInfo = await stat(source);
  if (!sourceInfo.isDirectory()) {
    throw new Error(`Pages source is not a directory: ${source}`);
  }
  await stat(path.join(source, 'index.html'));

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(source, output, { recursive: true });
  await replaceTokens(output, {
    __AFTER_PARTY_BASE_PATH__: basePath,
    __AFTER_PARTY_COMMIT__: commit,
  });
  await writeFile(
    path.join(output, 'version.json'),
    `${JSON.stringify({ commit, basePath }, null, 2)}\n`,
  );
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === invokedPath) {
  const options = parseArguments(process.argv.slice(2));
  await buildPages({
    source: options.source,
    output: options.output,
    commit: options.commit,
    basePath: options['base-path'],
  });
}
