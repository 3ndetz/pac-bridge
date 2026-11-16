import test from 'node:test'
import assert from 'node:assert/strict'
import { createPacSourceBinding } from '../src/pac-source-binding.mjs'

function setup(){const query={},session={query},agent={sessions:{'acp-root':session}};let invalidations=0;const binding=createPacSourceBinding({agent,rootSessionId:'acp-root',sdkSessionId:'sdk-other',query,onInvalidated:()=>invalidations++});return {query,session,agent,binding,get invalidations(){return invalidations}}}
const event={type:'system',subtype:'background_tasks_changed',session_id:'sdk-other',tasks:[]}

test('binds distinct ACP and SDK identities to the owned query and witnessed SDK frame',()=>{
 const x=setup();assert.equal(x.binding.owned(),true);assert.equal(x.binding.trusted(),false)
 x.binding.observe(x.query,event);assert.equal(x.binding.trusted(),true)
 x.session.query={};assert.equal(x.binding.trusted(),false);assert.equal(x.invalidations,1)
 x.binding.close();assert.equal(x.invalidations,1)
})

test('foreign SDK identity or a replaced session fails closed',()=>{
 const x=setup();assert.throws(()=>x.binding.observe(x.query,{...event,session_id:'acp-root'}),/Foreign/)
 assert.equal(x.binding.trusted(),false);assert.equal(x.invalidations,1)
 const y=setup();y.agent.sessions['acp-root']={query:y.query};assert.equal(y.binding.owned(),false);assert.equal(y.invalidations,1)
})

test('foreign query and disconnected query cannot establish identity',()=>{
 const x=setup();assert.throws(()=>x.binding.observe({},event),/changed/);assert.equal(x.binding.trusted(),false)
 const y=setup();y.session.queryClosed=true;assert.equal(y.binding.owned(),false);assert.equal(y.invalidations,1)
})
