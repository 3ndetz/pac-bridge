export function normalizePacBackgroundTasks(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 128) throw new Error('Invalid PAC background snapshot')
  const ids = new Set()
  const clean = tasks.map(task => {
    if (!task || typeof task !== 'object' || Array.isArray(task) || typeof task.task_id !== 'string' || !task.task_id || task.task_id.length > 512 || /[\s\x00-\x1f\x7f]/.test(task.task_id) || ids.has(task.task_id) ||
        typeof task.task_type !== 'string' || !task.task_type.trim() || task.task_type.length > 128 || /[\x00-\x1f\x7f]/.test(task.task_type) ||
        typeof task.description !== 'string' || task.description.length > 4096) throw new Error('Invalid PAC background task')
    ids.add(task.task_id)
    return { task_id: task.task_id, task_type: task.task_type, description: task.description }
  })
  if (Buffer.byteLength(JSON.stringify(clean)) > 1024 * 1024) throw new Error('PAC background snapshot exceeds size limit')
  return clean
}
