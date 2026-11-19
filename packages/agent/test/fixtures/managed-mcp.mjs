// Disposable local MCP plugin fixture used to verify owned process cleanup.
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
const descendant=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{
 stdio:'ignore',windowsHide:true
});
if(process.env.PLUGIN_FIXTURE_CHILD_PID_PATH)
 fs.writeFileSync(process.env.PLUGIN_FIXTURE_CHILD_PID_PATH,String(descendant.pid));
if(process.env.PLUGIN_FIXTURE_START_DELAY_MS)
 await delay(Math.min(10000,Number(process.env.PLUGIN_FIXTURE_START_DELAY_MS)||0));
const server=new Server({name:'managed-mcp-fixture',version:'1.0.0'},{capabilities:{tools:{}}});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 {name:'descendant_pid',description:'Returns the child process PID',
  inputSchema:{type:'object',properties:{},additionalProperties:false}}
]}));
server.setRequestHandler(CallToolRequestSchema,async()=>{
 return {content:[{type:'text',text:String(descendant.pid)}]};
});
await server.connect(new StdioServerTransport());
