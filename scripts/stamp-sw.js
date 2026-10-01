// Lists the app's files in sw.js and sets its VERSION to a hash of them, so
// every change to the app reaches devices as an update.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT_FILES = ['index.html', 'styles.css', 'manifest.webmanifest'];
const FOLDERS = ['js', 'vendor', 'icons'];

function walk(folder) {
  return readdirSync(folder).sort().flatMap(name => {
    const path = join(folder, name);
    if (name.startsWith('.')) return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = [...ROOT_FILES, ...FOLDERS.flatMap(walk)];
const hash = createHash('sha256');
files.forEach(file => hash.update(file).update(readFileSync(file)));
const version = hash.digest('hex').slice(0, 12);

const source = readFileSync('sw.js', 'utf8');
const list = ["'./'", ...files.map(file => `'${file}'`)].map(line => `  ${line},`).join('\n').replace(/,$/, '');
const updated = source
  .replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`)
  .replace(/( *)\/\/ FILES-START\n[\s\S]*?\/\/ FILES-END/, `$1// FILES-START\n${list}\n$1// FILES-END`);
writeFileSync('sw.js', updated);
console.log(`sw.js: version ${version}, ${files.length + 1} files.`);
