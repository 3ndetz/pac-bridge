// Track loaded paths separately for the main conversation and each subagent.
export function createInstructionLedger({ maxOwners = 512, maxPathsPerOwner = 4096 } = {}) {
  if (!Number.isSafeInteger(maxOwners) || maxOwners < 1 || !Number.isSafeInteger(maxPathsPerOwner) || maxPathsPerOwner < 1) throw new Error('Invalid instruction ledger limits')
  const owners = new Map()
  function owner(agentId) {
    if (agentId !== undefined && (typeof agentId !== 'string' || !agentId || agentId.length > 512)) throw new Error('Invalid instruction owner')
    const key = agentId === undefined ? 'main' : `agent:${agentId}`
    if (!owners.has(key)) {
      if (owners.size >= maxOwners) throw new Error('Instruction owner limit exceeded')
      owners.set(key, new Set())
    }
    return owners.get(key)
  }
  return {
    unseen(agentId, entries) {
      if (!Array.isArray(entries)) throw new Error('Invalid instruction entries')
      const paths = owner(agentId)
      return entries.filter((entry) => !paths.has(entry.path))
    },
    mark(agentId, entries) {
      const paths = owner(agentId)
      const next = new Set(entries.map((entry) => entry.path).filter((path) => !paths.has(path)))
      if (paths.size + next.size > maxPathsPerOwner) throw new Error('Instruction path limit exceeded')
      for (const path of next) paths.add(path)
    },
  }
}
