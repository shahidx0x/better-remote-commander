import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
process.env.BRC_HOME = mkdtempSync(path.join(os.tmpdir(), 'brc-home-'));
const {callTool,listTools} = await import('../dist/dispatcher.js');
const {withCallContext} = await import('../dist/context.js');
const {default: sharp} = await import('sharp');
const body = r => r.structuredContent;
const mk = async () => fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'brc-img-')));
const noise = (w, h) => { const b = Buffer.alloc(w * h * 3); for (let i = 0; i < b.length; i++) b[i] = (Math.random() * 256) | 0; return b; };
const png = (f, w, h, raw) => sharp(raw ?? {create: {width: w, height: h, channels: 3, background: '#3366cc'}}, raw ? {raw: {width: w, height: h, channels: 3}} : undefined).png({compressionLevel: 0}).toFile(f);
const jpg = (f, w, h) => sharp({create: {width: w, height: h, channels: 3, background: '#cc6633'}}).jpeg().toFile(f);
const imgs = r => r.content.filter(c => c.type === 'image');
const b64bytes = r => imgs(r).reduce((n, c) => n + Buffer.from(c.data, 'base64').length, 0);

test('read_images is advertised and read-only', () => {
  const t = listTools().find(x => x.name === 'read_images');
  assert.ok(t); assert.equal(t.annotations.readOnlyHint, true);
  assert.doesNotMatch(t.description, /prepare_file_transfer.*docker/);
});
test('list finds images, skips node_modules and secrets', async () => {
  const d = await mk();
  await fs.mkdir(path.join(d, 'sub')); await fs.mkdir(path.join(d, 'node_modules'));
  await png(path.join(d, 'a.png'), 32, 32); await jpg(path.join(d, 'sub', 'b.jpg'), 40, 20);
  await png(path.join(d, 'node_modules', 'x.png'), 8, 8); await png(path.join(d, '.env.png'), 8, 8);
  await fs.writeFile(path.join(d, 'note.txt'), 'x');
  const r = await callTool('read_images', {path: d});
  assert.ok(!r.isError, JSON.stringify(r.content));
  assert.deepEqual(body(r).files.map(f => f.file), ['a.png', 'sub/b.jpg']);
  assert.equal(body(r).previewGenerated, false);
});
test('metadata returns dimensions, hash and no images', async () => {
  const d = await mk(); await png(path.join(d, 'a.png'), 50, 30);
  const r = await callTool('read_images', {path: d, mode: 'metadata', files: ['a.png']});
  assert.ok(!r.isError); assert.equal(imgs(r).length, 0);
  const f = body(r).files[0]; assert.equal(f.width, 50); assert.equal(f.height, 30); assert.match(f.sha256, /^[0-9a-f]{64}$/);
});
test('previews are resized and the original (larger than budget) is never returned', async () => {
  const d = await mk(); const f = path.join(d, 'big.png');
  await png(f, 1800, 1800, noise(1800, 1800));
  const size = (await fs.stat(f)).size;
  assert.ok(size > 4 * 1024 * 1024, 'fixture should be large: ' + size);
  const r = await callTool('read_images', {path: d, mode: 'previews', files: ['big.png'], maxDimension: 1600});
  assert.ok(!r.isError, JSON.stringify(r.content).slice(0, 300));
  assert.ok(imgs(r).length <= 1);
  assert.ok(b64bytes(r) <= 256 * 1024, 'encoded ' + b64bytes(r));
  assert.ok(JSON.stringify(r).length < 512 * 1024, 'frame size ' + JSON.stringify(r).length);
});
test('twelve noisy previews stay inside the total byte budget', async () => {
  const d = await mk(); const names = [];
  for (let i = 0; i < 12; i++) { const n = `n${i}.png`; names.push(n); await png(path.join(d, n), 700, 700, noise(700, 700)); }
  const r = await callTool('read_images', {path: d, mode: 'previews', files: names, maxDimension: 1600});
  assert.ok(!r.isError, JSON.stringify(r.content).slice(0, 300));
  assert.ok(b64bytes(r) <= 256 * 1024);
  assert.ok(JSON.stringify(r).length < 512 * 1024);
  assert.equal(body(r).files.length + body(r).filesSkipped, 12);
});
test('sheet returns one bounded image for several files', async () => {
  const d = await mk(); await png(path.join(d, 'a.png'), 60, 40); await jpg(path.join(d, 'b.jpg'), 40, 60); await png(path.join(d, 'c.png'), 20, 20);
  const r = await callTool('read_images', {path: d, mode: 'sheet', files: ['a.png', 'b.jpg', 'c.png']});
  assert.ok(!r.isError, JSON.stringify(r.content)); assert.equal(imgs(r).length, 1);
  const m = await sharp(Buffer.from(imgs(r)[0].data, 'base64')).metadata();
  assert.equal(m.width, 768); assert.equal(m.height, 256);
  assert.ok(b64bytes(r) <= 256 * 1024);
});
test('path escape, SVG, disguised XML, non-image, oversize pixels and missing files fail per file', async () => {
  const parent = await mk(); const d = path.join(parent, 'proj'); await fs.mkdir(d);
  await png(path.join(parent, 'outside.png'), 8, 8);
  await fs.writeFile(path.join(d, 'a.svg'), '<svg/>'); await fs.writeFile(path.join(d, 'fake.png'), '<svg xmlns="x"/>');
  await fs.writeFile(path.join(d, 'junk.png'), 'not an image at all');
  await sharp({create: {width: 5000, height: 5000, channels: 3, background: '#fff'}}).png().toFile(path.join(d, 'huge.png'));
  const r = await callTool('read_images', {path: d, mode: 'metadata', files: ['../outside.png', 'a.svg', 'fake.png', 'junk.png', 'huge.png', 'missing.png']});
  const files = body(r).files;
  assert.equal(files.length, 6);
  for (const f of files) assert.ok(f.error, JSON.stringify(f));
  assert.match(files[0].error, /outside/i); assert.equal(imgs(r).length, 0);
  assert.ok(r.isError);
  assert.match(files[4].error, /16-megapixel|pixel/i);
});
test('symlink escaping the project is refused', async (t) => {
  const parent = await mk(); const d = path.join(parent, 'proj'); await fs.mkdir(d);
  await png(path.join(parent, 'secret.png'), 8, 8);
  try { await fs.symlink(path.join(parent, 'secret.png'), path.join(d, 'link.png')); } catch { return t.skip('symlinks unavailable'); }
  const r = await callTool('read_images', {path: d, mode: 'metadata', files: ['link.png']});
  assert.ok(body(r).files[0].error); assert.equal(imgs(r).length, 0);
});
test('files are required for non-list modes and cancel aborts', async () => {
  const d = await mk(); await png(path.join(d, 'a.png'), 8, 8);
  const r = await callTool('read_images', {path: d, mode: 'previews'});
  assert.equal(body(r).error.code, 'FILES_REQUIRED');
  const ac = new AbortController(); ac.abort();
  const c = await withCallContext({id: randomUUID(), client: null, remote: false, signal: ac.signal}, () => callTool('read_images', {path: d, mode: 'previews', files: ['a.png']}));
  assert.ok(c.isError); assert.equal(body(c).error.code, 'CANCELLED');
});
