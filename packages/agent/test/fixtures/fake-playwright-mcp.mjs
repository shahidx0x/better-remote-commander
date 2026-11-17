// Fake local Playwright-compatible MCP server for agent-only regression tests.
// It does NOT launch a browser, navigate the web, or install Playwright.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({name:'fake-playwright',version:'1.0.0'},{capabilities:{tools:{}}});
const object=(properties,required=[])=>({type:'object',properties,required,additionalProperties:false});
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
  {name:'browser_snapshot',description:'Current DOM snapshot',inputSchema:object({depth:{type:'number'}})},
  {name:'browser_click',description:'Click a current element reference',inputSchema:object({target:{type:'string'},element:{type:'string'}},['target'])},
  {name:'browser_navigate',description:'Navigate a page',inputSchema:object({url:{type:'string'}},['url'])},
  {name:'browser_resize',description:'Resize a page',inputSchema:object({width:{type:'number'},height:{type:'number'}},['width','height'])},
  {name:'browser_tabs',description:'List/select tabs',inputSchema:object({action:{type:'string'},index:{type:'number'}},['action'])},
  {name:'browser_take_screenshot',description:'Screenshot only',inputSchema:object({})},
]}));
let page=0;
server.setRequestHandler(CallToolRequestSchema,async req=>{
  const args=req.params.arguments??{};
  const tool=req.params.name;
  if(tool==='browser_snapshot')return{content:[{type:'text',text:'snapshot '+page+' target=submit-'+page}]};
  if(tool==='browser_click'){
    if(args.target==='stale')return{content:[{type:'text',text:'Error: element ref stale; element not found in current DOM'}],isError:true};
    page++;
    return{content:[{type:'text',text:'clicked '+args.target}]};
  }
  if(tool==='browser_navigate'){page++;return{content:[{type:'text',text:'navigated '+args.url}]}};
  if(tool==='browser_resize'){page++;return{content:[{type:'text',text:'resized'}]}};
  if(tool==='browser_tabs'){if(args.action!=='list')page++;return{content:[{type:'text',text:'tabs '+args.action}]}};
  if(tool==='browser_take_screenshot')return{content:[{type:'text',text:'checkpoint screenshot (fake)'}]};
  return{content:[{type:'text',text:'unknown tool'}],isError:true};
});
await server.connect(new StdioServerTransport());
