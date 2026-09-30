import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
  console.error('usage: node scripts/bump-version.mjs <major.minor.patch>');
  process.exit(2);
}

const packageFiles = [
  'package.json',
  'packages/shared/package.json',
  'packages/agent/package.json',
  'packages/relay/package.json',
];

for (const file of packageFiles) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(/("version"\s*:\s*")[^"]+(".*)/, `$1${version}$2`);
  if (next === text) throw new Error(`version field not found in ${file}`);
  writeFileSync(file, next);
}

const replacements = [
  ['packages/agent/src/cli.ts', /const AGENT_VERSION = '[^']+';/, `const AGENT_VERSION = '${version}';`],
  ['packages/relay/src/app.ts', /relayVersion: '[^']+'/, `relayVersion: '${version}'`],
];
for (const [file, pattern, replacement] of replacements) {
  const text = readFileSync(file, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`runtime version not found in ${file}`);
  writeFileSync(file, next);
}
console.log(`version bumped to ${version}`);
