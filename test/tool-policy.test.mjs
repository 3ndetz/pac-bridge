import assert from 'node:assert/strict'
import test from 'node:test'
import { prototypeToolDecision } from '../src/tool-policy.mjs'

test('denies unhandled tools rather than executing them on the controller', () => {
  for (const name of ['PowerShell', 'WebFetch', 'Skill', 'mcp__other__Read', 'Read', undefined]) {
    assert.equal(prototypeToolDecision(name).hookSpecificOutput.permissionDecision, 'deny')
  }
  for (const name of ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill']) {
    assert.deepEqual(prototypeToolDecision(`mcp__pac__${name}`), {})
    assert.deepEqual(prototypeToolDecision(name, { aliases: false }), {})
  }
  assert.equal(prototypeToolDecision('Agent').hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(prototypeToolDecision('Agent', { allowSubagents: true }), {})
  assert.deepEqual(prototypeToolDecision('mcp__pac__TaskOutput'), {})
  assert.deepEqual(prototypeToolDecision('mcp__pac__TaskStop'), {})
  assert.deepEqual(prototypeToolDecision('ToolSearch'), {})
  assert.equal(prototypeToolDecision('mcp__source_tools__read_source_marker').hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(prototypeToolDecision('mcp__source_tools__read_source_marker', { allowSourceMcp: true }), {})
  assert.equal(prototypeToolDecision('mcp__source_tools__bad__name!', { allowSourceMcp: true }).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(prototypeToolDecision('AskUserQuestion').hookSpecificOutput.permissionDecision, 'deny')
  assert.deepEqual(prototypeToolDecision('mcp__pac__AskUserQuestion', { allowQuestions: true }), {})
})
