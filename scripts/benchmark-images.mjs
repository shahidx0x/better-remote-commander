// Repeatable local native-image microbenchmark (not a remote MCP latency benchmark).
// pnpm bench:images -- output is printed only; no report or project files persist.
import { performance } from 'node:perf_hooks';
import { mkdtempSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const tmp = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-img-bench-'));
process.env.BRC_HOME = path.join(tmp, 'home');
process.env.BRC_LOG_FILE = '0';
const { default: sharp } = await import('../packages/agent/node_modules/sharp/lib/index.js');
const { configManager } = await import('../packages/agent/dist/core/config-manager.js');
const { readImages, imageRuntimeStatus } = await import('../packages/agent/dist/tools/image-tools.js');
const names = [];
const median = arr => {
  const v = [...arr].sort((a, b) => a - b);
  return Math.round(v[Math.floor(v.length / 2)]);
};
function noise(width, height, seed) {
  const b = Buffer.allocUnsafe(width * height * 3);
  let state = seed | 0;
  for (let i = 0; i < b.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    b[i] = state & 255;
  }
  return b;
}
try {
  await configManager.setValue('allowedDirectories', [tmp]);
  for (let i = 0; i < 6; i++) {
    const name = 'fixture-' + i + '.jpg';
    names.push(name);
    await sharp(noise(1200, 800, i + 1), { raw: { width: 1200, height: 800, channels: 3 } })
      .jpeg({ quality: 84 }).toFile(path.join(tmp, name));
  }
  console.log('BRC native image benchmark:', JSON.stringify(imageRuntimeStatus()));
  for (const [label, args] of [
    ['one preview', { path: tmp, mode: 'previews', files: names.slice(0, 1) }],
    ['six previews', { path: tmp, mode: 'previews', files: names }],
    ['six-image sheet', { path: tmp, mode: 'sheet', files: names }],
    ['six metadata', { path: tmp, mode: 'metadata', files: names }],
  ]) {
    const times = [];
    let size = 0, count = 0;
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const result = await readImages(args);
      if (result.isError) throw new Error(JSON.stringify(result.structuredContent).slice(0, 300));
      if (i > 0) times.push(performance.now() - start);
      size = result.structuredContent.encodedOutputBytes ?? 0;
      count = result.structuredContent.returnedImages ?? 0;
    }
    console.log(label + ': median=' + median(times) + 'ms, images=' + count + ', encodedBytes=' + size);
  }
} finally {
  await configManager.close();
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
