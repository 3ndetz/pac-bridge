// HAPI identifies its disposable model-list client in the first ACP request.
// Put every byte back so ordinary ACP sessions receive the original stream.
export async function isHapiModelProbe(input, maxBytes = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, finished = false
    const done = (error, probe = false, replay = true) => {
      if (finished) return
      finished = true
      input.removeListener('readable', onReadable)
      input.removeListener('end', onEnd)
      input.removeListener('error', onError)
      if (replay && bytes) input.unshift(Buffer.concat(chunks))
      if (error) reject(error); else resolve(probe)
    }
    const onError = (error) => done(error, false, false)
    const onEnd = () => done(null, false, false)
    const onReadable = () => {
      let chunk
      while ((chunk = input.read()) !== null) {
        if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk)
        chunks.push(chunk); bytes += chunk.length
        if (bytes > maxBytes) return done(new Error('ACP initialization exceeds the size limit'), false, false)
        if (chunk.indexOf(10) < 0) continue
        const buffer = Buffer.concat(chunks), newline = buffer.indexOf(10)
        try {
          const msg = JSON.parse(buffer.subarray(0, newline).toString('utf8'))
          return done(null, msg?.jsonrpc === '2.0' && (typeof msg.id === 'string' || typeof msg.id === 'number') && msg.method === 'initialize' && msg.params?.protocolVersion === 1 && msg.params?.clientInfo?.name === 'hapi-opencode-models')
        } catch { return done(null, false) }
      }
    }
    input.on('readable', onReadable)
    input.once('end', onEnd)
    input.once('error', onError)
    onReadable()
  })
}
