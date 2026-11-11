// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Sha256MismatchError,
  defaultInstallRoot,
  ensureCodeOssServer,
  readInstalledMarker,
  serverInstallDir,
  type InstallProgress,
} from '../code-oss-server/install'
import type { ServerAsset } from '../code-oss-server/manifest'

const ARTIFACT = 'shogo-ide-server-0feedbf3d9ba-5c20845b4d6c'
const DIR_NAME = '0feedbf3d9ba-5c20845b4d6c'
const scratch = mkdtempSync(join(tmpdir(), 'shogo-ide-install-'))
let archiveBytes: Uint8Array
let sha256: string
let server: ReturnType<typeof Bun.serve>
let requests: string[] = []
let failuresLeft = 0

function tar(): string {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

beforeAll(() => {
  const src = join(scratch, 'server-src')
  mkdirSync(join(src, 'out'), { recursive: true })
  writeFileSync(join(src, 'out', 'server-main.js'), 'console.log("server")\n')
  writeFileSync(join(src, process.platform === 'win32' ? 'node.exe' : 'node'), 'binary')
  // Large enough for several progress events.
  writeFileSync(join(src, 'payload.bin'), Buffer.alloc(512 * 1024, 7))
  const archive = join(scratch, 'server.tar.gz')
  const result = spawnSync(tar(), ['-czf', archive, '-C', src, '.'])
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`)
  archiveBytes = new Uint8Array(readFileSync(archive))
  sha256 = createHash('sha256').update(archiveBytes).digest('hex')

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname
      requests.push(path)
      if (path === '/flaky.tar.gz' && failuresLeft > 0) {
        failuresLeft--
        return new Response('busy', { status: 503 })
      }
      if (path === '/missing.tar.gz') return new Response('nope', { status: 404 })
      if (path === '/slow.tar.gz') {
        await new Promise((r) => setTimeout(r, 2_000))
      }
      return new Response(archiveBytes, { headers: { 'content-length': String(archiveBytes.byteLength) } })
    },
  })
})

afterAll(() => {
  server?.stop(true)
  rmSync(scratch, { recursive: true, force: true })
})

let rootCounter = 0
function freshRoot(): string {
  return join(scratch, `root-${rootCounter++}`)
}

function asset(path = '/server.tar.gz', overrides: Partial<ServerAsset> = {}): ServerAsset {
  return {
    file: `${ARTIFACT}-win32-x64.tar.gz`,
    url: `http://127.0.0.1:${server.port}${path}`,
    sha256,
    size: archiveBytes.byteLength,
    ...overrides,
  }
}

const base = { artifactId: ARTIFACT, target: 'win32-x64' as const, retryDelaysMs: [0, 0] }

describe('ensureCodeOssServer', () => {
  test('downloads, verifies, extracts and marks the install', async () => {
    const installRoot = freshRoot()
    const progress: InstallProgress[] = []
    requests = []
    const result = await ensureCodeOssServer({ ...base, asset: asset(), installRoot, onProgress: (p) => progress.push(p) })
    expect(result).toEqual({ dir: serverInstallDir(installRoot, ARTIFACT), downloaded: true })
    expect(readFileSync(join(result.dir, 'out', 'server-main.js'), 'utf8')).toContain('server')
    expect(readInstalledMarker(result.dir)).toEqual(expect.objectContaining({ artifactId: ARTIFACT, target: 'win32-x64', sha256 }))
    expect(requests).toEqual(['/server.tar.gz'])

    const phases = progress.map((p) => p.phase).filter((p, i, all) => all[i - 1] !== p)
    expect(phases).toEqual(['downloading', 'verifying', 'extracting'])
    const received = progress.filter((p) => p.phase === 'downloading').map((p) => p.received!)
    expect(received).toEqual([...received].sort((a, b) => a - b))
    expect(received.at(-1)).toBe(archiveBytes.byteLength)
    expect(progress.find((p) => p.phase === 'downloading')?.total).toBe(archiveBytes.byteLength)
    expect(readdirSync(installRoot)).toEqual([DIR_NAME])
  })

  test('an installed server is reused without touching the network', async () => {
    const installRoot = freshRoot()
    await ensureCodeOssServer({ ...base, asset: asset(), installRoot })
    requests = []
    const again = await ensureCodeOssServer({ ...base, asset: asset(), installRoot })
    expect(again.downloaded).toBe(false)
    expect(requests).toEqual([])
  })

  test('a marker for another target is reinstalled', async () => {
    const installRoot = freshRoot()
    const { dir } = await ensureCodeOssServer({ ...base, asset: asset(), installRoot })
    writeFileSync(join(dir, '.installed.json'), JSON.stringify({ ...readInstalledMarker(dir), target: 'linux-x64' }))
    requests = []
    expect((await ensureCodeOssServer({ ...base, asset: asset(), installRoot })).downloaded).toBe(true)
    expect(requests).toEqual(['/server.tar.gz'])
  })

  test('a checksum mismatch fails and leaves nothing behind', async () => {
    const installRoot = freshRoot()
    const bad = asset('/server.tar.gz', { sha256: 'f'.repeat(64) })
    await expect(ensureCodeOssServer({ ...base, asset: bad, installRoot })).rejects.toBeInstanceOf(Sha256MismatchError)
    expect(readdirSync(installRoot)).toEqual([])
  })

  test('a 503 is retried and then succeeds', async () => {
    const installRoot = freshRoot()
    failuresLeft = 1
    requests = []
    const result = await ensureCodeOssServer({ ...base, asset: asset('/flaky.tar.gz'), installRoot })
    expect(result.downloaded).toBe(true)
    expect(requests).toEqual(['/flaky.tar.gz', '/flaky.tar.gz'])
  })

  test('gives up after the retries run out', async () => {
    const installRoot = freshRoot()
    failuresLeft = 10
    requests = []
    await expect(ensureCodeOssServer({ ...base, asset: asset('/flaky.tar.gz'), installRoot })).rejects.toThrow(/HTTP 503/)
    expect(requests).toHaveLength(3)
    failuresLeft = 0
  })

  test('a 404 is not retried', async () => {
    const installRoot = freshRoot()
    requests = []
    await expect(ensureCodeOssServer({ ...base, asset: asset('/missing.tar.gz'), installRoot })).rejects.toThrow(/HTTP 404/)
    expect(requests).toEqual(['/missing.tar.gz'])
  })

  test('concurrent calls share one download', async () => {
    const installRoot = freshRoot()
    requests = []
    const [a, b] = await Promise.all([
      ensureCodeOssServer({ ...base, asset: asset(), installRoot }),
      ensureCodeOssServer({ ...base, asset: asset(), installRoot }),
    ])
    expect(a.dir).toBe(b.dir)
    expect(requests).toEqual(['/server.tar.gz'])
  })

  test('an abort cancels the download', async () => {
    const installRoot = freshRoot()
    const controller = new AbortController()
    const pending = ensureCodeOssServer({ ...base, asset: asset('/slow.tar.gz'), installRoot, signal: controller.signal })
    setTimeout(() => controller.abort(), 100)
    await expect(pending).rejects.toThrow()
    expect(existsSync(serverInstallDir(installRoot, ARTIFACT))).toBe(false)
  })

  test('older versions and stray downloads are pruned after an install', async () => {
    const installRoot = freshRoot()
    mkdirSync(join(installRoot, '000000000000-000000000000'), { recursive: true })
    mkdirSync(join(installRoot, '000000000000-111111111111.tmp-dead'), { recursive: true })
    writeFileSync(join(installRoot, '.download-dead.tar.gz'), 'partial')
    writeFileSync(join(installRoot, 'unrelated.txt'), 'keep')
    await ensureCodeOssServer({ ...base, asset: asset(), installRoot })
    expect(readdirSync(installRoot).sort()).toEqual([DIR_NAME, 'unrelated.txt'])
  })
})

describe('defaultInstallRoot', () => {
  test('Windows uses LocalAppData, not the roaming profile', () => {
    expect(defaultInstallRoot('win32', { LOCALAPPDATA: 'C:\\Users\\denis\\AppData\\Local' }, 'C:\\Users\\denis')).toBe(
      'C:\\Users\\denis\\AppData\\Local\\Shogo\\ide-server',
    )
  })

  test('macOS and Linux', () => {
    expect(defaultInstallRoot('darwin', {}, '/Users/d')).toBe('/Users/d/Library/Application Support/Shogo/ide-server')
    expect(defaultInstallRoot('linux', {}, '/home/d')).toBe('/home/d/.local/share/shogo/ide-server')
    expect(defaultInstallRoot('linux', { XDG_DATA_HOME: '/data' }, '/home/d')).toBe('/data/shogo/ide-server')
  })

  // The build caps archive paths at 160 characters (MAX_ARCHIVE_PATH in
  // build-code-oss-server.mjs); together they must stay under MAX_PATH (260).
  test('a long Windows user name still fits MAX_PATH', () => {
    const root = defaultInstallRoot('win32', { LOCALAPPDATA: 'C:\\Users\\firstname.middlename.lastname\\AppData\\Local' }, '')
    const dir = `${root}\\${DIR_NAME}`
    expect(dir.length + 1 + 160).toBeLessThan(260)
  })
})
