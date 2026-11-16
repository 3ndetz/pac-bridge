import test from 'node:test'
import assert from 'node:assert/strict'
import { createSourceSnapshotComposite } from '../src/sdk-source-snapshot.mjs'

function setup(){const query={},terminals={},events=[],barrier={},source=createSourceSnapshotComposite({sourceSessionId:'source',query,terminals,publish:value=>events.push(value)});return {query,terminals,events,source,proof:()=>({barrier,generation:source.generation,complete:true,healthy:true,starting:0,uncertain:0,valid:()=>true})}}
const sdk=[{task_id:'agent',run_id:'run-1',task_type:'local_agent',description:'agent'}], shell=[{task_id:'pac-shell-1',task_type:'local_bash',description:'shell'}]

test('requires complete SDK and terminal sets for the same source and epoch',()=>{
 const x=setup();x.source.sdk(x.query,'source',sdk,x.proof());assert.equal(x.events.at(-1).availability,'unknown')
 x.source.terminal(x.terminals,'source',shell,x.proof());assert.equal(x.events.at(-1).availability,'ready')
 assert.deepEqual(x.events.at(-1).tasks,[...sdk,...shell]);assert.equal(x.events.at(-1).epoch,x.source.epoch)
})

test('start, uncertain terminal outcome, loss, and stale generations fail closed',()=>{
 const x=setup();x.source.sdk(x.query,'source',sdk,x.proof());x.source.terminal(x.terminals,'source',shell,x.proof())
 const old=x.proof();x.source.invalidate();assert.equal(x.events.at(-1).availability,'unknown')
 assert.throws(()=>x.source.terminal(x.terminals,'source',shell,old),/incomplete/)
 assert.throws(()=>x.source.terminal(x.terminals,'source',shell,{...x.proof(),starting:1}),/incomplete/)
 assert.throws(()=>x.source.terminal(x.terminals,'source',shell,{...x.proof(),uncertain:1}),/incomplete/)
 x.source.terminal(x.terminals,'source',[],x.proof());assert.equal(x.events.at(-1).availability,'unknown')
 x.source.sdk(x.query,'source',[],x.proof());assert.equal(x.events.at(-1).availability,'ready')
 x.source.close();assert.equal(x.events.at(-1).availability,'unknown')
})

test('rejects duplicate or foreign tasks and does not retain partial authority',()=>{
 const x=setup();x.source.sdk(x.query,'source',sdk,x.proof())
 assert.throws(()=>x.source.terminal(x.terminals,'source',[{...shell[0],task_id:'agent'}],x.proof()),/Duplicate/)
 assert.equal(x.events.at(-1).availability,'unknown')
 assert.throws(()=>x.source.sdk({},'source',sdk,x.proof()),/incomplete/)
 assert.throws(()=>x.source.sdk(x.query,'other',sdk,x.proof()),/incomplete/)
 x.source.terminal(x.terminals,'source',[],x.proof());assert.equal(x.events.at(-1).availability,'unknown')
})

test('expired proof and failed publication invalidate both sources',()=>{
 let fail=false;const query={},terminals={},events=[],barrier={}
 const source=createSourceSnapshotComposite({sourceSessionId:'source',query,terminals,publish:value=>{if(fail && value.availability==='ready')throw new Error('lost');events.push(value)}})
 const proof=()=>({barrier,generation:source.generation,complete:true,healthy:true,starting:0,uncertain:0,valid:()=>true})
 source.sdk(query,'source',sdk,proof());fail=true
 assert.throws(()=>source.terminal(terminals,'source',shell,proof()),/lost/);assert.equal(events.at(-1).availability,'unknown')
 fail=false;source.terminal(terminals,'source',shell,proof());assert.equal(events.at(-1).availability,'unknown')
 assert.throws(()=>source.sdk(query,'source',sdk,{...proof(),valid:()=>false}),/incomplete/)
})

test('both source proofs must remain valid under the same quiescence barrier',()=>{
 for(const first of ['sdk','terminal']) {
  const x=setup();let valid=true
  const firstProof={...x.proof(),valid:()=>valid}
  if(first==='sdk')x.source.sdk(x.query,'source',sdk,firstProof)
  else x.source.terminal(x.terminals,'source',shell,firstProof)
  valid=false
  assert.throws(()=>first==='sdk' ? x.source.terminal(x.terminals,'source',shell,x.proof()) : x.source.sdk(x.query,'source',sdk,x.proof()),/barrier/)
  assert.equal(x.events.at(-1).availability,'unknown')
 }
 const x=setup();x.source.sdk(x.query,'source',sdk,x.proof())
 assert.throws(()=>x.source.terminal(x.terminals,'source',shell,{...x.proof(),barrier:{}}),/barrier/)
 assert.equal(x.events.at(-1).availability,'unknown')
 const y=setup();assert.throws(()=>y.source.sdk(y.query,'source',sdk,{...y.proof(),valid:()=>{throw new Error('lease lost')}}),/incomplete/)
 assert.equal(y.events.at(-1).availability,'unknown')
})

test('closed source cannot publish again or disturb a new source epoch',()=>{
 const x=setup();x.source.close();const count=x.events.length
 assert.throws(()=>x.source.sdk(x.query,'source',sdk,x.proof()),/closed/)
 x.source.close();x.source.invalidate();assert.equal(x.events.length,count)
 const next=setup();assert.notEqual(next.source.epoch,x.source.epoch)
})
