import { writeFile } from 'node:fs/promises'

export async function recordMcpAudit(path) {
  await writeFile(path, 'called', { flag: 'wx' })
}
