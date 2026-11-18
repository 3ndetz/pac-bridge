import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Duplex } from 'node:stream'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { createOpencodeProvider } from '../src/opencode-provider.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

// A synthetic PAC and native OpenCode; no remote credentials or model calls.
for (const abortPrompt of [false, true]) test(abortPrompt ? 'native OpenCode abort releases the paused PAC turn before a new user turn' : 'native OpenCode drains the original PAC turn after rejecting its permission', {skip:!process.env.PAC_TEST_NATIVE_OPENCODE,timeout:90000}, async () => {
  const root=await mkdtemp(join(tmpdir(),'pac-native-permission-')), token='synthetic-local-provider-token-long-enough'
  let server, child, peer, calls=0, decisions=0, permissionRequests=0, text=''
  const requests=[], failures=[]
  server=createOpencodeProvider({token,cwd:root,onToolUpdate:()=>{},onFailure:x=>failures.push(x),router:{hasSession:()=>true,
    async prompt(binding,_prompt,update){
      calls++
      if(calls>1){update({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'NEW_USER_TURN_ACCEPTED'}}}});return {stopReason:'end_turn'}}
      const result=await server.requestPermission(binding.sessionId,{toolCall:{toolCallId:'fixture-call',title:'Synthetic source command',kind:'execute',rawInput:{command:'never-executed-fixture'}},options:[{optionId:'allow',name:'Allow once',kind:'allow_once'},{optionId:'deny',name:'Reject',kind:'reject_once'}]})
      assert.ok(result.outcome.outcome==='cancelled'||result.outcome.optionId==='deny');decisions++
      update({method:'session/update',params:{update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ORIGINAL_PAC_TURN_DENIED_ONCE'}}}})
      return {stopReason:'end_turn'}
    },cancel(){},
  }})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const base=`http://127.0.0.1:${server.address().port}`
  const proxy=createServer(async(req,res)=>{
    try{
      let raw='';for await(const part of req)raw+=part
      const body=JSON.parse(raw);requests.push({lastRole:body.messages?.at(-1)?.role,tools:body.tools?.map(t=>t.function?.name),choice:body.tool_choice,stream:body.stream})
      const reply=await fetch(base+req.url,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','x-pac-session-id':req.headers['x-pac-session-id']||'','x-pac-message-id':req.headers['x-pac-message-id']||''},body:raw})
      res.writeHead(reply.status,{'content-type':reply.headers.get('content-type')||'application/json'})
      for await(const chunk of reply.body)res.write(chunk)
      res.end()
    }catch{res.writeHead(502).end()}
  })
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening')
  try{
    const config={plugin:[new URL('../adapters/opencode-plugin.mjs',import.meta.url).href],provider:{pacbridge:{npm:'@ai-sdk/openai-compatible',name:'Synthetic PAC',options:{baseURL:`http://127.0.0.1:${proxy.address().port}/v1`,apiKey:token},models:{'PAC_fixture/haiku':{name:'fixture'}}}}}
    const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT||'.COM;.EXE;.BAT;.CMD',SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,HOME:root,USERPROFILE:root,APPDATA:join(root,'appdata'),LOCALAPPDATA:join(root,'localappdata'),XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_CACHE_HOME:join(root,'cache'),XDG_STATE_HOME:join(root,'state'),OPENCODE_CONFIG_CONTENT:JSON.stringify(config),OPENCODE_DISABLE_MODELS_FETCH:'1',OPENCODE_DISABLE_AUTOUPDATE:'1',OPENCODE_DISABLE_CLAUDE_CODE:'1',OPENCODE_DISABLE_PROJECT_CONFIG:'1',PAC_PROVIDER_URL:base,PAC_PROVIDER_TOKEN:token}
    child=spawnContained(process.env.PAC_TEST_NATIVE_OPENCODE,['acp'],{cwd:root,env,stdio:['pipe','pipe','pipe'],windowsHide:true})
    child.stderr.resume()
    peer=createAcpPeer(Duplex.from({readable:child.stdout,writable:child.stdin}),{timeoutMs:45000,onRequest:async(method,params)=>{
      if(method==='session/request_permission'){permissionRequests++;if(abortPrompt){peer.notify('session/cancel',{sessionId:params.sessionId});await new Promise(r=>setTimeout(r,25))}return {outcome:{outcome:'cancelled'}}}
      return {}
    },onNotification:(_method,params)=>{if(params?.update?.sessionUpdate==='agent_message_chunk')text+=params.update.content?.text||''}})
    await peer.call('initialize',{protocolVersion:1,clientCapabilities:{}})
    const session=await peer.call('session/new',{cwd:root,mcpServers:[]})
    await peer.call('session/set_config_option',{sessionId:session.sessionId,configId:'model',value:'pacbridge/PAC_fixture/haiku'})
    await peer.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'Run the bounded synthetic permission fixture.'}]},45000)
    assert.doesNotMatch(text,/PAC approval requested/)
    assert.equal(permissionRequests,1,JSON.stringify({requests,failures}));assert.equal(calls,1);assert.equal(decisions,1)
    if(abortPrompt){
      await peer.call('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'A distinct new user turn after the aborted fixture.'}]},45000)
      assert.equal(calls,2,JSON.stringify({requests,failures}));assert.match(text,/NEW_USER_TURN_ACCEPTED/,JSON.stringify({requests,failures}))
    }else assert.match(text,/ORIGINAL_PAC_TURN_DENIED_ONCE/,JSON.stringify({requests,failures}))
  }finally{
    peer?.close()
    if(child){const closed=child.exitCode===null?once(child,'close'):null;await stopContained(child);if(closed)await closed}
    proxy.closeAllConnections();await new Promise(r=>proxy.close(r));server.closeAllConnections();await new Promise(r=>server.close(r))
    const actual=await realpath(root),local=relative(await realpath(tmpdir()),actual)
    if(local&&!isAbsolute(local)&&local!=='..'&&!local.includes(sep)&&local.startsWith('pac-native-permission-'))await rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:200})
  }
})
