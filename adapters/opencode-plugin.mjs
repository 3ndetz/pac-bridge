import { z } from 'zod'

// Only tag calls to this provider. Auxiliary model calls that bypass this
// hook lack identities and are rejected by the bridge.
export default async function pacBridgePlugin() {
  const questionCalls = new Map()
  return {
    event: async ({ event }) => {
      const props = event?.properties
      if (event?.type === 'question.asked' && typeof props?.id === 'string' && typeof props?.sessionID === 'string' && typeof props?.tool?.callID === 'string') {
        if (questionCalls.size >= 1024) questionCalls.delete(questionCalls.keys().next().value)
        questionCalls.set(props.id, { sessionId: props.sessionID, id: props.tool.callID })
      }
      if (!['question.rejected', 'question.replied'].includes(event?.type)) return
      const entry = questionCalls.get(props?.requestID)
      questionCalls.delete(props?.requestID)
      if (!entry || event.type !== 'question.rejected' || entry.sessionId !== props.sessionID) return
      const base = process.env.PAC_PROVIDER_URL, token = process.env.PAC_PROVIDER_TOKEN
      if (!base || !token) return
      try {
        await fetch(`${base}/pac/approval`, { method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', ...entry }) })
      } catch {}
    },
    config: async (config) => {
      const current = config.permission
      if (typeof current === 'string') {
        config.permission = { '*': current, pac_bridge: current === 'deny' ? 'deny' : 'ask' }
      } else {
        config.permission = { ...(current || {}), pac_bridge: current?.pac_bridge ?? (current?.['*'] === 'deny' ? 'deny' : 'ask') }
      }
    },
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
          const input = details.toolCall?.rawInput
          const rendered = typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input)
          const title = `${details.title}${rendered ? `: ${rendered}` : ''}`.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 512)
          context.metadata({ title, metadata: { toolCall: details.toolCall } })
          let decision = 'deny'
          try {
            await context.ask({ permission: 'pac_bridge', patterns: [title], always: [], metadata: { toolCall: details.toolCall } })
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
    'tool.execute.after': async (input, output) => {
      if (input.tool !== 'question' || !Array.isArray(output.metadata?.answers)) return
      const base = process.env.PAC_PROVIDER_URL
      const token = process.env.PAC_PROVIDER_TOKEN
      if (!base || !token) return
      // The provider accepts only the pending question with the same session
      // and call ID. An unrelated native question has no matching PAC turn.
      try {
        await fetch(`${base}/pac/approval`, { method: 'POST', signal: AbortSignal.timeout(5000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'resolve', id: input.callID, sessionId: input.sessionID, answers: output.metadata.answers }) })
      } catch {}
    },
  }
}
