/**
 * SES-RDP: stub for upstream's stdio transport type.
 * The agent never speaks stdio; this only satisfies the `global.mcpTransport` type
 * referenced by upstream logger/types code. Always undefined at runtime.
 */
export interface FilteredStdioServerTransport {
  send(message: unknown): Promise<void>;
  sendLog(level: string, message: string, data?: unknown): void;
}
