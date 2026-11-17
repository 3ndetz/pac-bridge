import { startAgent } from './acp-transport.mjs'

export async function startSupervisedAgent({ retryMs = 5000, onError = () => {}, tokenProvider, ...options }) {
  if (!Number.isSafeInteger(retryMs) || retryMs < 100 || typeof onError !== 'function' ||
      (tokenProvider !== undefined && typeof tokenProvider !== 'function')) throw new Error('Invalid supervisor configuration')
  let stopped = false
  const ownedAgents = new Set()
  let retry
  let generation = 0
  function schedule() {
    if (stopped || retry) return
    retry = setTimeout(() => { retry = null; void connect() }, retryMs)
  }
  async function connect() {
    if (stopped) return
    const current = ++generation
    let disconnected = false
    try {
      const token = tokenProvider ? await tokenProvider() : options.token
      if (stopped || current !== generation) return
      const agent = await startAgent({ ...options, token, onError, onDisconnect: ({ closed }) => {
        disconnected = true
        // A lost registration does not prove its child processes exited.
        // Re-register only after that owner has drained; never overlap an
        // unresolved old generation with a newly accepting controller.
        void closed.then(() => { if (!stopped && current === generation) schedule() })
      } })
      ownedAgents.add(agent)
      void agent.closed.then(() => ownedAgents.delete(agent))
      if (stopped || disconnected || current !== generation) agent.close()
    } catch (error) {
      if (!stopped) { onError(error); schedule() }
    }
  }
  await connect()
  return {
    close() {
      stopped = true
      generation++
      if (retry) clearTimeout(retry)
      for (const agent of ownedAgents) agent.close()
    },
  }
}
