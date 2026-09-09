/**
 * SES-RDP agent entry (library). Phase 0: exposes the reused Desktop Commander
 * tool core so the build proves it compiles. Phase 1 adds the WS transport and CLI.
 */
export * from './context.js';
export { configManager } from './core/config-manager.js';
export { terminalManager } from './core/terminal-manager.js';
export { commandManager } from './core/command-manager.js';
export { searchManager } from './core/search-manager.js';
export * as handlers from './core/handlers/index.js';
export { VERSION as CORE_VERSION } from './core/version.js';
