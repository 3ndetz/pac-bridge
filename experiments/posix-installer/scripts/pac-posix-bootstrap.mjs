import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, open, readdir, readlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const base = join(homedir(), '.local', 'share', 'pac-bridge-v2')

async function readGeneration(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 || (metadata.mode & 0o077)) throw new Error('Invalid PAC generation')
    const value = await file.readFile('utf8')
    if (!/^[a-f0-9]{40} [a-f0-9]{64}\n$/.test(value)) throw new Error('Invalid PAC generation')
    const [revision, digest] = value.trim().split(' ')
    return { revision, digest }
  } finally { await file.close() }
}

async function selectedRevision() {
  const directory = join(base, 'generations')
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Invalid PAC generation directory')
  const names = (await readdir(directory)).sort()
  if (!names.length) throw new Error('PAC generation is incomplete')
  if (names.some((name, index) => name !== String(index + 1).padStart(16, '0'))) throw new Error('Invalid PAC generation sequence')
  return readGeneration(join(directory, names[names.length - 1]))
}

async function stageDigest(stage) {
  const paths = []
  async function visit(relative) {
    const path = join(stage, relative)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Invalid PAC version directory')
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`
      if (entry.isDirectory()) await visit(child)
      else paths.push(child)
    }
  }
  for (const directory of ['adapters', 'src', 'scripts', 'node_modules']) await visit(directory)
  paths.push('package.json', 'package-lock.json')
  const result = createHash('sha256')
  for (const relative of paths.sort()) {
    if (!/^[A-Za-z0-9._/@+-]+$/.test(relative)) throw new Error('Invalid PAC version path')
    const path = join(stage, relative)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o077)) throw new Error('Invalid PAC version file')
      const content = createHash('sha256').update(await file.readFile()).digest('hex')
      const after = await file.stat()
      const current = await lstat(path)
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.dev !== current.dev || before.ino !== current.ino) throw new Error('PAC version changed during inspection')
      result.update(`${relative}\0${content}\n`, 'ascii')
    } finally { await file.close() }
  }
  return result.digest('hex')
}

const { revision, digest } = await selectedRevision()
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Invalid PAC revision')
const versions = join(base, 'versions')
const version = join(versions, revision)
const versionInfo = await lstat(version)
if (!versionInfo.isSymbolicLink() || versionInfo.uid !== process.getuid()) throw new Error('Invalid PAC version')
const stageName = await readlink(version)
if (!/^\.stage\.[A-Za-z0-9]+$/.test(stageName)) throw new Error('Invalid PAC version')
const stage = join(versions, stageName)
const stageInfo = await lstat(stage)
if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink() || stageInfo.uid !== process.getuid() || (stageInfo.mode & 0o077)) throw new Error('Invalid PAC version')
const completion = await open(join(stage, '.complete'), constants.O_RDONLY | constants.O_NOFOLLOW)
try {
  const metadata = await completion.stat()
  if (!metadata.isFile() || metadata.uid !== process.getuid() || metadata.nlink !== 1 || (metadata.mode & 0o077) || await completion.readFile('utf8') !== `${digest}\n`) throw new Error('Invalid PAC version')
} finally { await completion.close() }
if (await stageDigest(stage) !== digest) throw new Error('PAC version content changed')
const launcher = join(stage, 'scripts', 'pac-posix-launcher.mjs')
const launcherInfo = await lstat(launcher)
if (!launcherInfo.isFile() || launcherInfo.isSymbolicLink() || launcherInfo.uid !== process.getuid() || launcherInfo.nlink !== 1 || (launcherInfo.mode & 0o077)) throw new Error('Invalid PAC launcher')
const child = spawn(process.execPath, [launcher, ...process.argv.slice(2)], {
  env: { ...process.env, PAC_POSIX_GENERATION_PIN: revision }, stdio: 'inherit'
})
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal))
process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject)
  child.once('exit', (code, signal) => resolveExit(code ?? (signal ? 1 : 0)))
})
