// Reuse the local Codex Telegram sender without copying its credentials.
const fs = require('node:fs')
const path = require('node:path')
async function main() {
  const modulePath = process.env.PAC_CODEX_TELEGRAM_MODULE
  if (!modulePath || !path.isAbsolute(modulePath)) throw new Error('Local Telegram sender is not configured')
  const event = JSON.parse(fs.readFileSync(0, 'utf8'))
  if (event?.hook_event_name !== 'Stop' || typeof event.session_id !== 'string' || typeof event.turn_id !== 'string' || typeof event.last_assistant_message !== 'string') throw new Error('Invalid completion notification')
  const sender = require(modulePath)
  if (typeof sender.notify !== 'function') throw new Error('Local Telegram sender has no notify function')
  await sender.notify(event)
}
main().catch(() => { process.exitCode = 1 })
