import { readFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

// A stable entry point for new child processes of an already running runner.
// It never changes the active process or the version used by existing chats.
const home = join(homedir(), '.hapi-servermall', 'pac-bridge')
const pointer = JSON.parse((await readFile(join(home, 'provider-current.json'), 'utf8')).replace(/^\uFEFF/, ''))
if (!/^[a-f0-9]{40}$/.test(pointer?.revision) || typeof pointer.namedProviders !== 'boolean' || typeof pointer.legacyMigration !== 'boolean' || (pointer.legacyMigration && !pointer.namedProviders)) throw new Error('Invalid PAC provider pointer')
const version = join(home, 'provider-versions', pointer.revision)
process.env.PAC_HAPI_PROVIDER_EXPERIMENT = '1'
for (const [key, enabled] of [['PAC_NAMED_PROVIDERS_EXPERIMENT', pointer.namedProviders], ['PAC_LEGACY_MIGRATION_EXPERIMENT', pointer.legacyMigration]]) {
  if (enabled) process.env[key] = '1'; else delete process.env[key]
}
const exists = async file => access(file).then(() => true, () => false)
const notify = join(home, 'notify')
delete process.env.PAC_TURN_NOTIFY_SCRIPT
delete process.env.PAC_CODEX_TELEGRAM_MODULE
let sender = join(notify, 'tg-notify.cjs')
if (!await exists(sender)) sender = join(notify, 'telegram-notify.cjs')
if (await exists(sender)) process.env.PAC_TURN_NOTIFY_SCRIPT = sender
else {
  const file = join(notify, 'codex-telegram-module.txt')
  if (await exists(file)) {
    const module = (await readFile(file, 'utf8')).trim()
    if (isAbsolute(module) && await exists(module)) {
      process.env.PAC_CODEX_TELEGRAM_MODULE = module
      process.env.PAC_TURN_NOTIFY_SCRIPT = join(version, 'adapters', 'codex-telegram-notify.cjs')
    } else process.stderr.write('PAC Telegram sender is unavailable; notifications are disabled.\n')
  }
}
await import(pathToFileURL(join(version, 'adapters', 'pac-hapi-opencode.mjs')).href)
