// Display labels do not determine model routing. A controller may expose
// models from multiple vendors, even when its default label is "Claude".
export function pacModelLabel(endpoint, model) {
  const raw = typeof model?.name === 'string' && model.name.trim() ? model.name : model?.id
  if (typeof raw !== 'string' || !raw) throw new Error('PAC model has no display name')
  const name = raw.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) || String(model.id || '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
  if (!name) throw new Error('PAC model has no display name')
  const prefix = typeof endpoint.modelPrefix === 'string' ? endpoint.modelPrefix.trim() : ''
  const lower = name.toLowerCase(), lowerPrefix = prefix.toLowerCase()
  const alreadyPrefixed = prefix && (lower === lowerPrefix || [' ', '-', '/', ':'].some(separator => lower.startsWith(lowerPrefix + separator)))
  const claudeModel = /(?:^|[^a-z])(claude|opus|sonnet|haiku)(?=$|[^a-z])/i.test(`${model.id || ''} ${name}`)
  const includePrefix = prefix && !alreadyPrefixed && (prefix.toLowerCase() !== 'claude' || claudeModel)
  return `PAC ${endpoint.displayName || endpoint.name} / ${includePrefix ? prefix + ' ' : ''}${name}`
}
