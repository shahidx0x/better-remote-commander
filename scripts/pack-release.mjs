// Release packer: pnpm pack all packages, then rewrite agent/relay's dependency on
// brc-shared to the shared tarball URL of this GitHub release so
// `npm i -g <agent.tgz url>` works without an npm registry.
//   node scripts/pack-release.mjs <owner/repo> <tag>
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const [repo, tag] = process.argv.slice(2);
if (!repo || !tag) { console.error('usage: pack-release <owner/repo> <tag>'); process.exit(2); }
const out = path.resolve('dist-pack');
rmSync(out, { recursive: true, force: true }); mkdirSync(out);
execSync('pnpm -r --filter "./packages/*" exec pnpm pack --pack-destination ../../dist-pack', { stdio: 'inherit' });

const files = readdirSync(out).filter((f) => f.endsWith('.tgz'));
const shared = files.find((f) => f.startsWith('brc-shared-'));
const sharedUrl = `https://github.com/${repo}/releases/download/${tag}/${shared}`;

for (const f of files.filter((x) => !x.startsWith('brc-shared-'))) {
  const work = path.join(out, 'work'); rmSync(work, { recursive: true, force: true }); mkdirSync(work);
  execSync(`tar -xzf "${path.join(out, f)}" -C "${work}"`);
  const pj = path.join(work, 'package', 'package.json');
  const pkg = JSON.parse(readFileSync(pj, 'utf8'));
  if (pkg.dependencies?.['brc-shared']) pkg.dependencies['brc-shared'] = sharedUrl;
  writeFileSync(pj, JSON.stringify(pkg, null, 2));
  rmSync(path.join(out, f));
  execSync(`tar -czf "${path.join(out, f)}" -C "${work}" package`);
  rmSync(work, { recursive: true, force: true });
  console.log(`${f}: brc-shared -> ${sharedUrl}`);
}
