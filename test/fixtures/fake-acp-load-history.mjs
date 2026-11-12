import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value)+'\n')
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line), result = request.method==='initialize' ? {protocolVersion:1,agentCapabilities:{loadSession:true}} : request.method==='session/load' ? {sessionId:request.params.sessionId,models:{currentModelId:'PAC_test/sonnet',availableModels:[{modelId:'PAC_test/sonnet'}]}} : request.method==='session/set_model' ? {} : request.method==='session/prompt' ? {stopReason:'end_turn'} : {}
 if(request.method==='session/load') for(let i=0;i<2000;i++)send({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'old history'}}}})
 if(request.method==='session/load') send({jsonrpc:'2.0',method:'session/update',params:{sessionId:request.params.sessionId,update:{sessionUpdate:'compaction_update',status:'completed'}}})
 if(request.id!==undefined) send({jsonrpc:'2.0',id:request.id,result})
})
