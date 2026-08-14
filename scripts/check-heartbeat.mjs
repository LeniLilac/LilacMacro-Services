import { lstat } from 'node:fs/promises';

const [path, maximumAgeRaw] = process.argv.slice(2);
const maximumAge = Number(maximumAgeRaw);
if (!path?.startsWith('/tmp/') || !Number.isInteger(maximumAge) || maximumAge < 1_000) {
  process.exit(2);
}

try {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || Date.now() - stat.mtimeMs > maximumAge) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}
