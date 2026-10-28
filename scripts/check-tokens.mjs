// Fails when app code carries raw colour values: design/tokens.css is the only source.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/gi;
const bad = [];
for (const f of readdirSync('src')) {
  const text = readFileSync(join('src', f), 'utf8');
  text.split('\n').forEach((line, i) => {
    const hits = line.replace(/&#\$\{|`&#/g, '').match(RAW);
    if (hits) bad.push(`src/${f}:${i + 1}: ${hits.join(', ')}`);
  });
}
if (bad.length) {
  console.error('Raw colour values found (use tokens from design/tokens.css):\n' + bad.join('\n'));
  process.exit(1);
}
console.log('check:tokens — no raw colour values in src/');
