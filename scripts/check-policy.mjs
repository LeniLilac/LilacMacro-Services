import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const roots = ['src', 'scripts', 'ops', 'test'];
const ignored = new Set(['node_modules', 'dist', 'coverage', '.git', '.local']);
const errors = [];

async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(full);
    if (!entry.isFile()) continue;
    const extension = path.extname(entry.name);
    if (!['.ts', '.mjs', '.js'].includes(extension)) continue;
    const lines = (await readFile(full, 'utf8')).split(/\r?\n/).length;
    const limit = full.startsWith('test' + path.sep) ? 800 : 500;
    if (lines > limit) errors.push(`${full}: ${lines} lines exceeds ${limit}`);
  }
}

for (const root of roots) {
  try {
    if ((await stat(root)).isDirectory()) await visit(root);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

const forbidden = [
  /discord(?:app)?\.com\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/i,
  /AKIA[0-9A-Z]{16}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /gh[oprsu]_[A-Za-z0-9]{20,}/,
  /dp\.st\.[A-Za-z0-9._-]{20,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /C:\\Users\\[^\\]+/i,
];

const textExtensions = new Set([
  '',
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.sql',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);

async function scanSecrets(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await scanSecrets(full);
      continue;
    }
    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
    const content = await readFile(full, 'utf8');
    for (const pattern of forbidden) {
      if (pattern.test(content)) errors.push(`${full}: secret/path pattern`);
    }
  }
}

await scanSecrets('.');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Repository policy passed.');
}
