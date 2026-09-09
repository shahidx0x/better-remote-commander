import path from 'path';
import fs from 'fs';
import os from 'os';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
// SES-RDP: own config dir so we never collide with an installed Desktop Commander
const longPath = (p: string): string => { try { return fs.realpathSync.native(p); } catch { const parent = path.dirname(p); return parent === p ? p : path.join(longPath(parent), path.basename(p)); } };
export const CONFIG_DIR = longPath(process.env.SES_RDP_HOME ?? path.join(USER_HOME, '.ses-rdp'));

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds
