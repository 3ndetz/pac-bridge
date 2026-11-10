import assert from 'node:assert/strict'
import test from 'node:test'
import { mapQuestionAnswers } from '../src/question-answers.mjs'

test('preserves free-text and multi-select answers for the original questions', () => {
  const questions = [{ question: 'Choose?' }, { question: 'Select?', multiSelect: true }]
  assert.deepEqual(mapQuestionAnswers(questions, { '0': ['custom answer'], '1': ['first', 'second'] }),
    { 'Choose?': 'custom answer', 'Select?': 'first, second' })
  assert.throws(() => mapQuestionAnswers(questions, { '0': [], '1': ['first'] }), /Invalid/)
  assert.throws(() => mapQuestionAnswers(questions, { '0': ['one', 'two'], '1': ['first'] }), /Invalid/)
  assert.throws(() => mapQuestionAnswers([{ question: 'same' }, { question: 'same' }], {}), /Invalid/)
  assert.equal(mapQuestionAnswers([{ question: '__proto__' }], { '0': ['safe'] }).__proto__, 'safe')
})
