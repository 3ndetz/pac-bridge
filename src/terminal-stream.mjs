export function startTerminalOutputPump({ read, emit, intervalMs = 250, maxProgressBytes = 65536 }) {
  if (typeof read !== 'function' || typeof emit !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 25 ||
      !Number.isSafeInteger(maxProgressBytes) || maxProgressBytes < 4) throw new Error('Invalid terminal output pump')
  let stopped = false
  let timer
  let lastOutput = ''
  let lastTruncated = false
  let failure
  let running = Promise.resolve()
  function tick() {
    running = (async () => {
      try {
        const result = await read()
        if (stopped) return
        if (typeof result?.output !== 'string' || typeof result.truncated !== 'boolean') throw new Error('Invalid terminal output')
        const bytes = Buffer.from(result.output, 'utf8')
        let start = Math.max(0, bytes.length - maxProgressBytes)
        while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
        const progress = { output: bytes.subarray(start).toString('utf8'), truncated: result.truncated || start > 0 }
        if (progress.output !== lastOutput || progress.truncated !== lastTruncated) {
          lastOutput = progress.output
          lastTruncated = progress.truncated
          await emit(progress)
        }
      } catch (error) { failure = error; stopped = true }
      if (!stopped) timer = setTimeout(tick, intervalMs)
    })()
  }
  tick()
  return {
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      await running
      if (failure) throw failure
    },
  }
}
