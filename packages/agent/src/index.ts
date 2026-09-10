/** BRC agent library entry. */
export * from './context.js';
export { callTool, listTools, hasTool } from './dispatcher.js';
export { WsClient, type WsClientOptions } from './transport/ws-client.js';
export { configManager } from './core/config-manager.js';
export { VERSION as CORE_VERSION } from './core/version.js';
