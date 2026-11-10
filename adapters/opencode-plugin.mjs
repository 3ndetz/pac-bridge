// Only tag calls to this provider. Auxiliary model calls that bypass this
// hook lack identities and are rejected by the bridge.
export default async function pacBridgePlugin() {
  return {
    'chat.headers': async (input, output) => {
      if (input.model?.providerID !== 'pacbridge') return
      if (typeof input.sessionID !== 'string' || typeof input.message?.id !== 'string') throw new Error('PAC session identity is unavailable')
      output.headers['x-pac-session-id'] = input.sessionID
      output.headers['x-pac-message-id'] = input.message.id
    },
  }
}
