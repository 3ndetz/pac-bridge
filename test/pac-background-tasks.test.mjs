import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizePacBackgroundTasks } from '../src/pac-background-tasks.mjs'

test('normalizes only bounded, uniquely identified structured PAC tasks', () => {
  assert.deepEqual(normalizePacBackgroundTasks([{ task_id: 'child', task_type: 'agent', description: 'work', private: 'drop' }]), [{ task_id: 'child', task_type: 'agent', description: 'work' }])
  for (const tasks of [null, [{}], [{ task_id: '', task_type: 'agent', description: '' }], [{ task_id: 'a b', task_type: 'agent', description: '' }], [{ task_id: 'a', task_type: ' ', description: '' }], [{ task_id: 'a', task_type: 'agent', description: '' }, { task_id: 'a', task_type: 'shell', description: '' }], Array.from({ length: 129 }, (_, i) => ({ task_id: String(i), task_type: 'agent', description: '' })), Array.from({ length: 128 }, (_, i) => ({ task_id: String(i), task_type: 'agent', description: '😀'.repeat(2048) }))]) {
    assert.throws(() => normalizePacBackgroundTasks(tasks))
  }
  assert.deepEqual(normalizePacBackgroundTasks([]), [])
})
