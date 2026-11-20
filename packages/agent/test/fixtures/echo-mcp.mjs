// Minimal stdio MCP server used by plugin tests: tools "echo" and "add".
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'echo-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'echo', description: 'Echo text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'add', description: 'Add two numbers', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
  { name: 'pid', description: 'Process id', inputSchema: { type: 'object', properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments ?? {};
  if (req.params.name === 'echo' && a.text === '__brc_test_fail__') return { content: [{ type:'text',text:'fixture rejected test request' }], isError:true };
  if (req.params.name === 'echo') return { content: [{ type: 'text', text: `echo: ${a.text}` }] };
  if (req.params.name === 'add') return { content: [{ type: 'text', text: String(Number(a.a) + Number(a.b)) }] };
  if (req.params.name === 'pid') return { content: [{ type: 'text', text: String(process.pid) }] };
  return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
});
await server.connect(new StdioServerTransport());
