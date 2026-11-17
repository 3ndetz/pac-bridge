import { lstat, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

export async function removeOwnedTestRoot(root, prefix) {
  if (typeof prefix !== 'string' || !/^pac-[a-z-]+-$/.test(prefix)) throw new Error('Invalid test root prefix')
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Refusing linked test root')
  const actual = await realpath(root)
  const local = relative(await realpath(tmpdir()), actual)
  if (!local || isAbsolute(local) || local === '..' || local.startsWith('..' + sep) || local.includes(sep) || !local.startsWith(prefix)) throw new Error('Refusing unexpected test cleanup path')
  await rm(actual, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
