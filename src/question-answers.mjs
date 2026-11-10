export function mapQuestionAnswers(questions, answers) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 4 ||
      questions.some((entry) => typeof entry?.question !== 'string' || !entry.question || entry.question.length > 16384) ||
      new Set(questions.map((entry) => entry.question)).size !== questions.length ||
      !answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Invalid question request or answer')
  const result = {}
  for (const [index, question] of questions.entries()) {
    const values = answers[String(index)]
    if (!Array.isArray(values) || !values.length || values.length > 100 ||
        values.some((value) => typeof value !== 'string' || !value || value.length > 16384) ||
        (question.multiSelect !== true && values.length !== 1)) throw new Error('Invalid question answer')
    Object.defineProperty(result, question.question, { value: values.join(', '), enumerable: true, configurable: true, writable: true })
  }
  return result
}
