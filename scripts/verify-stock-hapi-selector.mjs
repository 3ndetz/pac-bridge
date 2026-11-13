import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const [appsRoot, ...extra] = process.argv.slice(2)
if (!appsRoot || !isAbsolute(appsRoot) || extra.length) throw new Error('Pass the absolute saas-apps-center checkout path')
const base = await readFile(join(appsRoot, 'workflow', 'Dockerfile.web'), 'utf8')
const pinned = '2161a9ff9652011b270dc135fe763dc4e52b7790'
const delimiter = '\nFROM caddy:2-alpine'
if (!base.includes(pinned) || !base.includes(delimiter)) throw new Error('The stock HAPI web recipe does not match the verified source')
const fixtureDir = fileURLToPath(new URL('../test/fixtures/', import.meta.url))
const temporary = await mkdtemp(join(tmpdir(), 'pac-stock-selector-'))
try {
  const dockerfile = join(temporary, 'Dockerfile')
  const steps = '\nCOPY --from=pac-test /hapi-stock-model-selector.test.tsx /src/web/src/components/NewSession/pacStockSelector.test.tsx\nRUN cd web && node node_modules/vitest/vitest.mjs run src/components/NewSession/pacStockSelector.test.tsx\n'
  await writeFile(dockerfile, base.replace(delimiter, `${steps}${delimiter}`))
  const result = spawnSync('docker', ['buildx', 'build', '--target', 'build', '--output', 'type=cacheonly',
    '--build-context', `pac-test=${resolve(fixtureDir)}`, '-f', dockerfile, appsRoot], { stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Stock selector test failed with exit code ${result.status}`)
} finally {
  try { await unlink(join(temporary, 'Dockerfile')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  await rmdir(temporary)
}
