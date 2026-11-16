import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createControllerSourceMcp } from '../src/source-mcp-controller.mjs'
import { createSourceQuiescence } from '../src/pac-source-quiescence.mjs'

test('real MCP controller request preempts a snapshot lease until its reply', {timeout:15000}, async()=>{
 let invalidate=0,resolveCall,entered
 const gate=createSourceQuiescence({onInvalidate:()=>invalidate++})
 const started=new Promise(resolve=>{entered=resolve})
 const peer={call:gate.wrapExternal('mcp',async(method,params)=>{
  assert.equal(method,'pac/source_mcp/call');assert.equal(params.sessionId,'remote')
  entered();return await new Promise(resolve=>{resolveCall=resolve})
 })}
 const bridge=createControllerSourceMcp({remoteSessionId:'remote',serverName:'fixture',peer})
 const client=new Client({name:'isolated',version:'1'})
 const [a,b]=InMemoryTransport.createLinkedPair()
 await Promise.all([bridge.config.instance.connect(a),client.connect(b)])
 try {
  const lease=gate.acquire(),call=client.callTool({name:'example',arguments:{}})
  await started
  assert.equal(lease.valid(),false);assert.equal(invalidate,1)
  lease.release();assert.equal(gate.acquire(),null)
  resolveCall({content:[{type:'text',text:'ok'}]})
  assert.equal((await call).content[0].text,'ok')
  assert.ok(gate.acquire())
 } finally {resolveCall?.({content:[{type:'text',text:'ok'}]});await client.close();await bridge.close()}
})
