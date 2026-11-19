import {test} from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
// A static import reproduces the original risk: config resolution happened
// before the test could set an isolated BRC_HOME in its body.
import {CONFIG_DIR,CONFIG_FILE} from '../dist/core/config.js';
import {configManager} from '../dist/core/config-manager.js';

test('Node test workers never use the real ~/.brc without an explicit isolated home',async()=>{
  assert.ok(process.env.NODE_TEST_CONTEXT,'must run under node --test');
  const real=path.resolve(os.homedir(),'.brc').toLowerCase();
  assert.notEqual(path.resolve(CONFIG_DIR).toLowerCase(),real,
    'NEVER let an agent test write to the real user config directory');
  assert.equal(path.resolve(process.env.BRC_HOME),path.resolve(CONFIG_DIR));
  assert.ok(path.resolve(CONFIG_DIR).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()+path.sep));
  const fixture=path.join(CONFIG_DIR,'fixture-only');
  await fs.mkdir(fixture,{recursive:true});
  await configManager.setValue('allowedDirectories',[fixture]);
  assert.deepEqual(await configManager.getValue('allowedDirectories'),[fixture]);
  const parsed=JSON.parse(await fs.readFile(CONFIG_FILE,'utf8'));
  assert.deepEqual(parsed.allowedDirectories,[fixture]);
  await configManager.close();
});
