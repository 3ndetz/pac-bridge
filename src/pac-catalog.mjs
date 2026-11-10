const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export class PacCatalog {
  #entries = new Map()

  register({ id, name, models, online = true }) {
    if (typeof id !== 'string' || !identifier.test(id)) throw new Error('Invalid PAC id')
    if (typeof name !== 'string' || !identifier.test(name)) throw new Error('Invalid PAC name')
    if (typeof online !== 'boolean' || !Array.isArray(models)) throw new Error('Invalid PAC availability or models')
    for (const [existingId, entry] of this.#entries) {
      if (existingId !== id && entry.name.toLowerCase() === name.toLowerCase()) throw new Error('PAC name is already registered')
    }
    const seen = new Set()
    const normalized = models.map((model) => {
      if (!model || typeof model.id !== 'string' || !model.id || /[\x00-\x1f]/.test(model.id) || seen.has(model.id)) throw new Error('Invalid or duplicate model id')
      if (typeof model.name !== 'string' || !model.name) throw new Error('Invalid model name')
      seen.add(model.id)
      return { id: model.id, name: model.name }
    })
    this.#entries.set(id, { id, name, models: normalized, online })
  }

  list(authorizedIds) {
    if (!(authorizedIds instanceof Set)) throw new Error('Explicit PAC authorization is required')
    return [...this.#entries.values()].filter((entry) => authorizedIds.has(entry.id)).map((entry) => ({
      id: entry.id, name: entry.name, online: entry.online,
      models: entry.online ? entry.models.map((model) => ({ ...model, selector: `PAC_${entry.name}/${model.id}` })) : [],
    }))
  }

  resolve(selector, authorizedIds) {
    if (typeof selector !== 'string') throw new Error('Invalid PAC model selection')
    for (const entry of this.list(authorizedIds)) {
      const model = entry.models.find((candidate) => candidate.selector === selector)
      if (model) return { pacId: entry.id, pacName: entry.name, modelId: model.id }
    }
    throw new Error('PAC model is unavailable or unauthorized')
  }
}
