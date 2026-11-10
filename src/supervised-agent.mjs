import { startAgent } from './acp-transport.mjs'

export async function startSupervisedAgent({ retryMs = 5000, onError = () => {}, tokenProvider, ...options }) {
  if (!Number.isSafeInteger(retryMs) || retryMs < 100 || typeof onError !== 'function' ||
      (tokenProvider !== undefined && typeof tokenProvider !== 'function')) throw new Error('Invalid supervisor configuration')
  let stopped = false
  let active
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
      const agent = await startAgent({ ...options, token, onError, onDisconnect: () => {
        disconnected = true
        if (current === generation) { active = undefined; schedule() }
      } })
      if (stopped || disconnected || current !== generation) agent.close()
      else active = agent
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
      active?.close()
      active = undefined
    },
  }
}
