import path from 'path';
import os from 'os';

// Use user's home directory for configuration files
export const USER_HOME = os.homedir();
// SES-RDP: own config dir so we never collide with an installed Desktop Commander
export const CONFIG_DIR = process.env.SES_RDP_HOME ?? path.join(USER_HOME, '.ses-rdp');

// Paths relative to the config directory
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const TOOL_CALL_FILE = path.join(CONFIG_DIR, 'claude_tool_call.log');
export const TOOL_CALL_FILE_MAX_SIZE = 1024 * 1024 * 10; // 10 MB

export const DEFAULT_COMMAND_TIMEOUT = 1000; // milliseconds
