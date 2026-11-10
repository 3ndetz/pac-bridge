import { z } from 'zod'

// Only tag calls to this provider. Auxiliary model calls that bypass this
// hook lack identities and are rejected by the bridge.
export default async function pacBridgePlugin() {
  return {
    tool: {
      pac_approval: {
        description: 'Ask the user to approve or reject a pending PAC operation.',
        args: { id: z.string().uuid() },
        async execute({ id }, context) {
          const base = process.env.PAC_PROVIDER_URL
          const token = process.env.PAC_PROVIDER_TOKEN
          if (!base || !token) throw new Error('PAC approval service is unavailable')
          async function exchange(action, extra = {}) {
            const response = await fetch(`${base}/pac/approval`, { method: 'POST', signal: action === 'resolve' ? AbortSignal.timeout(5000) : context.abort,
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ action, id, sessionId: context.sessionID, ...extra }) })
            if (!response.ok) throw new Error('PAC approval is no longer available')
            return response.json()
          }
          const details = await exchange('inspect')
          let decision = 'deny'
          try {
            await context.ask({ permission: 'pac_bridge', patterns: [details.title], always: [], metadata: { toolCall: details.toolCall } })
            decision = 'allow'
          } catch {}
          await exchange('resolve', { decision })
          return decision === 'allow' ? 'PAC action approved.' : 'PAC action rejected.'
        },
      },
    },
    'chat.headers': async (input, output) => {
      if (input.model?.providerID !== 'pacbridge') return
      if (typeof input.sessionID !== 'string' || typeof input.message?.id !== 'string') throw new Error('PAC session identity is unavailable')
      output.headers['x-pac-session-id'] = input.sessionID
      output.headers['x-pac-message-id'] = input.message.id
    },
  }
}
