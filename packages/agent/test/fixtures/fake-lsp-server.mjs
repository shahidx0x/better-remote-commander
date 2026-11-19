/** Disposable LSP fixture. No source is executed. */
let buffer=Buffer.alloc(0);
let opened='',version=0;
function send(message){
 const bytes=Buffer.from(JSON.stringify({jsonrpc:'2.0',...message}),'utf8');
 process.stdout.write('Content-Length: '+bytes.length+'\r\n\r\n');
 process.stdout.write(bytes);
}
process.stdin.on('data',chunk=>{
 buffer=Buffer.concat([buffer,chunk]);
 while(buffer.length){
  const headerEnd=buffer.indexOf('\r\n\r\n');
  if(headerEnd<0)return;
  const header=buffer.subarray(0,headerEnd).toString('ascii');
  const match=/Content-Length:\s*(\d+)/i.exec(header);
  if(!match)process.exit(1);
  const n=Number(match[1]),offset=headerEnd+4;
  if(buffer.length<offset+n)return;
  const obj=JSON.parse(buffer.subarray(offset,offset+n).toString('utf8'));
  buffer=buffer.subarray(offset+n);
  if(obj.method==='textDocument/didOpen'){opened=obj.params.textDocument.text;version=1;}
  if(obj.method==='textDocument/didChange'){opened=obj.params.contentChanges[0].text;version++;}
  if(obj.id===undefined)continue;
  if(obj.method==='initialize')send({id:obj.id,result:{capabilities:{definitionProvider:true,referencesProvider:true,hoverProvider:true,documentSymbolProvider:true}}});
  else if(obj.method==='textDocument/definition')send({id:obj.id,result:[{uri:obj.params.textDocument.uri,range:{start:{line:0,character:0},end:{line:0,character:5}}}]});
  else if(obj.method==='textDocument/references')send({id:obj.id,result:[{uri:obj.params.textDocument.uri,range:{start:{line:0,character:0},end:{line:0,character:5}}}]});
  else if(obj.method==='textDocument/documentSymbol')send({id:obj.id,result:[{name:'symbol',kind:12,detail:'version '+version,range:{start:{line:0,character:0},end:{line:0,character:4}},selectionRange:{start:{line:0,character:0},end:{line:0,character:4}}}]});
  else if(obj.method==='textDocument/hover')send({id:obj.id,result:{contents:'LSP TEST '+process.pid+' version '+version+' source '+opened.length}});
  else send({id:obj.id,result:null});
 }
});
