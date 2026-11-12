import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import { Duplex } from 'node:stream'
import { createAcpPeer } from '../src/acp-peer.mjs'
import { spawnContained, stopContained } from '../src/spawn-contained.mjs'

if (process.platform === 'win32' || process.env.PAC_TEST_LIVE !== '1') throw new Error('Set PAC_TEST_LIVE=1 on a configured POSIX source to run this paid live check')
const root = await mkdtemp(join(tmpdir(), 'pac-posix-live-')), model = process.env.PAC_TEST_MODEL || 'PAC_testpac/sonnet'
const launcher = join(homedir(), '.local', 'share', 'pac-bridge', 'bin', 'opencode')
let child
try {
  const skill = join(root, '.opencode', 'skills', 'pac-linux-proof'), config = join(root, '.claude')
  await mkdir(skill, { recursive: true }); await mkdir(config, { recursive: true })
  await writeFile(join(skill, 'SKILL.md'), '---\nname: pac-linux-proof\ndescription: Read the Linux proof resource when requested\n---\nRead proof.txt in this skill directory and report its exact contents.\n')
  await writeFile(join(skill, 'proof.txt'), 'PAC_LINUX_SKILL_RESOURCE_48261')
  const hook = String.raw`let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const e=JSON.parse(s);require('fs').appendFileSync(require('path').join(process.env.CLAUDE_PROJECT_DIR,'hook-events.log'),e.hook_event_name+':'+e.tool_name+'\n')})`
  new Function(hook)
  await writeFile(join(root, 'hook.cjs'), hook)
  const handler = { type: 'command', command: process.execPath, args: ['${CLAUDE_PROJECT_DIR}/hook.cjs'], timeout: 15 }
  await writeFile(join(config, 'settings.json'), JSON.stringify({ hooks: {
    PreToolUse: [{ matcher: 'Skill|Read', hooks: [handler] }], PostToolUse: [{ matcher: 'Skill|Read', hooks: [handler] }],
  } }))
  child = spawnContained(launcher, ['acp'], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume(); child.on('error', () => {})
  const updates = []
  const peer = createAcpPeer(Duplex.from({ readable: child.stdout, writable: child.stdin }), {
    onNotification(method, params) { updates.push({ method, params }) },
    onRequest: async (method, params) => {
      if (method !== 'session/request_permission') throw new Error('Unexpected ACP request during live proof')
      const option = params.options?.find(item => item.kind === 'allow_once')
      if (!option) throw new Error('The test permission cannot be approved')
      return { outcome: { outcome: 'selected', optionId: option.optionId } }
    },
  })
  try {
    await peer.call('initialize', { protocolVersion: 1, clientCapabilities: {} }, 90000)
    const session = await peer.call('session/new', { cwd: root, mcpServers: [] }, 90000)
    const option = session.configOptions?.find(item => item.category === 'model' || item.id === 'model')
    if (!option?.options?.some(item => item.value === model)) throw new Error('Requested PAC model was not discovered')
    await peer.call('session/set_config_option', { sessionId: session.sessionId, configId: option.id, value: model }, 30000)
    const result = await peer.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text',
      text: 'Use the pac-linux-proof skill, read its resource, and report its exact contents. Do not modify other files.' }] }, 180000)
    await peer.drainNotifications()
    const text = JSON.stringify(updates), events = (await readFile(join(root, 'hook-events.log'), 'utf8')).trim().split(/\r?\n/)
    if (result?.stopReason !== 'end_turn' || !text.includes('PAC_LINUX_SKILL_RESOURCE_48261') ||
        !events.includes('PreToolUse:Skill') || !events.includes('PostToolUse:Skill') ||
        !events.includes('PreToolUse:Read') || !events.includes('PostToolUse:Read')) throw new Error('Linux skill or hook proof was incomplete')
    console.log(JSON.stringify({ model: true, reply: true, skill: true, resource: true, preAndPostHooks: true }))
  } finally { peer.close() }
} finally {
  if (child && child.exitCode === null) try { stopContained(child) } catch {}
  const actual = await realpath(root), local = relative(await realpath(tmpdir()), actual)
  if (local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`) && local.startsWith('pac-posix-live-')) await rm(actual, { recursive: true, force: true })
}
