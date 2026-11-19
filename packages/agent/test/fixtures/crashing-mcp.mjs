// A local MCP fixture deliberately exits after receiving a mutating tool call.
// The counter proves the caller never blindly replays an uncertain mutation.
import fs from 'node:fs';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const server=new Server({name:'crashing-mcp',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 {name:'mutate_and_crash',description:'Mutation fixture',
  inputSchema:{type:'object',properties:{},additionalProperties:false}}
]}));
server.setRequestHandler(CallToolRequestSchema,async(req)=>{
 if(req.params.name==='mutate_and_crash'){
   const p=process.env.PLUGIN_CRASH_COUNT_FILE;
   if(p)fs.appendFileSync(p,'performed\n');
   process.exit(17);
 }
 return {content:[{type:'text',text:'unknown'}],isError:true};
});
await server.connect(new StdioServerTransport());
