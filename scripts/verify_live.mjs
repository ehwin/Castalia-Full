// Read-only live MCP verification. Close all temporary sessions.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const ports=[3310,3312,3316,3318,3314];
const results=await Promise.all(ports.map(async port=>{
  const client=new Client({name:'castalia-regression',version:'1.0.0'});
  const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`));
  try {
    await client.connect(transport, {timeout:15000});
    const {tools}=await client.listTools({}, {timeout:15000});
    const tool=tools.find(t=>t.name==='memory_list') || tools.find(t=>t.name==='federation_members');
    if (!tool) throw new Error('no expected read-only tool');
    const response=await client.callTool({name:tool.name,arguments:tool.name==='memory_list'?{limit:1}:{}},undefined,{timeout:15000});
    if (response.isError) throw new Error(`read-only tool failed: ${tool.name}`);
    return {port,ok:true,toolCount:tools.length,readOnlyTool:tool.name};
  } catch(error) {return {port,ok:false,error:error.message};}
  finally {try {await transport.terminateSession();} catch {} await client.close();}
}));
console.log(JSON.stringify(results,null,2));
process.exitCode=results.some(r=>!r.ok)?1:0;
