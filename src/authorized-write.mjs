export async function authorizedWrite({ signal, authorize, connected, write }) {
  const allowed = await authorize()
  if (signal.aborted) throw new Error('Workspace write cancelled before it started')
  if (!allowed) throw new Error('Workspace write not authorized')
  if (!connected()) throw new Error('PAC disconnected; workspace write was not started')
  return write()
}
