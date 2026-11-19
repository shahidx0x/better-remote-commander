import path from 'path';
import fs from 'fs';
import os from 'os';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
// Better Remote Commander (BRC): own config dir so we never collide with an installed Desktop Commander
const longPath = (p: string): string => { try { return fs.realpathSync.native(p); } catch { const parent = path.dirname(p); return parent === p ? p : path.join(longPath(parent), path.basename(p)); } };
// Regression guard: Node's test runner sets NODE_TEST_CONTEXT in every test
// worker. A test that forgets BRC_HOME must NEVER overwrite the paired, live
// agent's ~/.brc/config.json or allowedDirectories. Isolate it automatically.
const productionHome = longPath(path.join(USER_HOME, '.brc'));
const requestedHome = process.env.BRC_HOME ? longPath(path.resolve(process.env.BRC_HOME)) : undefined;
const sameHome = (a:string,b:string) => process.platform === 'win32'
  ? a.toLowerCase() === b.toLowerCase() : a === b;
// Protect the actual ~/.brc even when a test-runner accidentally inherits an
// explicit BRC_HOME pointing there. Explicit temporary test homes still work.
const needsTestIsolation = !!process.env.NODE_TEST_CONTEXT &&
  (!requestedHome || sameHome(requestedHome, productionHome));
const isolatedTestHome = needsTestIsolation
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'brc-auto-test-home-')) : undefined;
if (isolatedTestHome) {
  process.env.BRC_HOME = isolatedTestHome;
  process.once('exit', () => {
    try { fs.rmSync(isolatedTestHome, {recursive:true,force:true,maxRetries:4,retryDelay:50}); }
    catch { /* Windows open handles can delay temp cleanup; NEVER touch real ~/.brc. */ }
  });
}
export const CONFIG_DIR = longPath(process.env.BRC_HOME ?? path.join(USER_HOME, '.brc'));

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds
