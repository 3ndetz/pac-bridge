export function watchSourceDisconnect(stream, onDisconnect) {
  let disconnected = false
  const disconnect = () => {
    if (disconnected) return
    disconnected = true
    onDisconnect()
  }
  stream.once('end', disconnect)
  stream.once('close', disconnect)
}
