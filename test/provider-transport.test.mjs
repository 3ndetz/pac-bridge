import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, link, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { providerRelayOverride, applyProviderRelayOverride } from '../src/provider-transport.mjs'

const revision = 'a'.repeat(40)
test('deployment transport is optional, revision-bound and requires an uncredentialed TLS endpoint', () => {
  assert.equal(providerRelayOverride({revision}, revision), undefined)
  assert.equal(providerRelayOverride({revision, relayUrl:'wss://relay.example:8792'}, revision), 'wss://relay.example:8792/')
  for (const relayUrl of ['ws://relay.example:8792', 'wss://user:secret@relay.example', 'wss://relay.example/?token=x', 'wss://relay.example/#x', 'wss://relay.example/other', 'bad']) assert.throws(() => providerRelayOverride({revision, relayUrl}, revision))
  assert.throws(() => providerRelayOverride({revision:'b'.repeat(40),relayUrl:'wss://relay.example'}, revision))
})

test('only new opted-in HAPI processes receive the selected transport and unsafe pointers fail closed', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pac-provider-transport-'))
  try {
    const directory = join(home, '.hapi-servermall', 'pac-bridge')
    await mkdir(directory, {recursive:true})
    const path = join(directory, 'provider-current.json')
    const entryUrl = pathToFileURL(join(directory, 'provider-versions', revision, 'adapters', 'pac-hapi-opencode.mjs')).href
    await writeFile(path, JSON.stringify({revision,relayUrl:'wss://relay.example:8792'}))
    const existing = {HOME:home,USERPROFILE:home,PAC_RELAY_URL:'wss://old.example'}
    await applyProviderRelayOverride({entryUrl,env:existing})
    assert.equal(existing.PAC_RELAY_URL,'wss://old.example')
    const next = {...existing,PAC_HAPI_PROVIDER_EXPERIMENT:'1'}
    await applyProviderRelayOverride({entryUrl,env:next})
    assert.equal(next.PAC_RELAY_URL,'wss://relay.example:8792/')
    assert.equal(existing.PAC_RELAY_URL,'wss://old.example')
    await assert.rejects(applyProviderRelayOverride({entryUrl,env:{...next,PAC_ENDPOINTS_FILE:join(home,'endpoints.json')}}), /single PAC/)
    await assert.rejects(applyProviderRelayOverride({entryUrl:entryUrl.replace(revision,'b'.repeat(40)),env:next}), /revision mismatch/)
    await link(path,join(directory,'linked.json'))
    await assert.rejects(applyProviderRelayOverride({entryUrl,env:next}), /Invalid PAC/)
    await rm(join(directory,'linked.json'))
    await writeFile(path,Buffer.from([0xff]))
    await assert.rejects(applyProviderRelayOverride({entryUrl,env:next}))
    await writeFile(path,' '.repeat(4097))
    await assert.rejects(applyProviderRelayOverride({entryUrl,env:next}), /Invalid PAC/)
  } finally {
    const target = await realpath(home), parent = await realpath(tmpdir())
    assert.ok(target.startsWith(parent + sep))
    assert.ok(target.split(sep).at(-1).startsWith('pac-provider-transport-'))
    await rm(target,{recursive:true,force:true})
  }
})
