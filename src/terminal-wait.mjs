export async function waitForTerminal({ wait, timeoutMs = 120000, signal }) {
  if (typeof wait !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
    throw new Error('Invalid terminal wait configuration')
  }
  if (signal?.aborted) throw new Error('Terminal command cancelled; outcome may be unknown')
  let timer
  let abort
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Terminal command timed out; outcome may be unknown')), timeoutMs) })
    const cancellation = signal ? new Promise((_, reject) => {
      abort = () => reject(new Error('Terminal command cancelled; outcome may be unknown'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    }) : new Promise(() => {})
    return await Promise.race([wait(), timeout, cancellation])
  } finally {
    if (timer) clearTimeout(timer)
    if (abort) signal.removeEventListener('abort', abort)
  }
}
