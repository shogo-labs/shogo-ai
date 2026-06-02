// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Greenfield sweep for three never-loaded shogo-worker files:
 *   lib/runtime-install.ts, commands/project-checkout.ts, commands/project-push.ts
 * Shared mocks: node:fs / node:child_process / node:crypto / node:os /
 * node:stream / node:stream/promises / ../config / ../paths / ../git-cloner /
 * @shogo-ai/sdk/cloud-file-transport, plus a routable global fetch.
 */
import { describe, test, expect, beforeEach, afterEach, mock, afterAll } from 'bun:test'
import { EventEmitter } from 'node:events'

// ── routable global fetch ─────────────────────────────────────────────────────
type FetchHandler = (url: string, init?: any) => any
let fetchHandler: FetchHandler = () => { throw new Error('fetch not configured') }
const origFetch = globalThis.fetch
beforeEach(() => {
  fetchHandler = () => { throw new Error('fetch not configured') }
  ;(globalThis as any).fetch = (url: any, init?: any) => Promise.resolve(fetchHandler(String(url), init))
})
afterEach(() => { (globalThis as any).fetch = origFetch })

// ── controllable node:fs ──────────────────────────────────────────────────────
let existsPredicate: (p: string) => boolean = () => false
let readFileImpl: (p: string) => any = () => ''
const fsWrites: Array<{ path: string; data: string }> = []
const fsRenames: Array<{ from: string; to: string }> = []
const fsRemoves: string[] = []
const fsMkdirs: string[] = []
mock.module('node:fs', () => ({
  existsSync: (p: string) => existsPredicate(String(p)),
  readFileSync: (p: string) => readFileImpl(String(p)),
  writeFileSync: (p: string, data: any) => { fsWrites.push({ path: String(p), data: String(data) }) },
  mkdirSync: (p: string) => { fsMkdirs.push(String(p)) },
  renameSync: (a: string, b: string) => { fsRenames.push({ from: String(a), to: String(b) }) },
  rmSync: (p: string) => { fsRemoves.push(String(p)) },
  chmodSync: () => {},
  createWriteStream: () => ({ on: () => {}, end: () => {}, write: () => true }),
}))

// ── node:crypto (deterministic digest) ────────────────────────────────────────
let computedDigest = 'a'.repeat(64)
mock.module('node:crypto', () => ({
  createHash: () => ({ update: () => ({ digest: () => computedDigest }) }),
}))

// ── node:os / node:stream / node:stream/promises ──────────────────────────────
mock.module('node:os', () => ({ tmpdir: () => '/tmp' }))
mock.module('node:stream', () => ({ Readable: { fromWeb: () => ({}) } }))
let pipelineThrows = false
mock.module('node:stream/promises', () => ({
  pipeline: async () => { if (pipelineThrows) throw new Error('pipeline boom') },
}))

// ── fake child_process.spawn (tar) ────────────────────────────────────────────
let tarExitCode = 0
let tarEmitsError = false
class FakeTar extends EventEmitter {
  stderr = new EventEmitter()
  constructor() {
    super()
    queueMicrotask(() => {
      if (tarEmitsError) { this.emit('error', new Error('spawn failed')); return }
      if (tarExitCode !== 0) this.stderr.emit('data', Buffer.from('tar failure'))
      this.emit('exit', tarExitCode)
    })
  }
}
mock.module('node:child_process', () => ({
  spawn: () => new FakeTar(),
}))

// ── ../config ─────────────────────────────────────────────────────────────────
mock.module('../config.ts', () => ({
  resolveConfig: (o: any = {}) => ({
    apiKey: o.apiKey ?? 'key-123',
    cloudUrl: o.cloudUrl ?? 'https://cloud.shogo.dev',
    projectsDir: '/projects',
  }),
}))

// ── ../paths (serves both runtime-install ./paths and commands ../lib/paths) ────
mock.module('../paths.ts', () => ({
  RUNTIME_BIN: '/runtime/agent-runtime',
  RUNTIME_DIR: '/runtime',
  RUNTIME_VERSION_FILE: '/runtime/version.json',
  ensureRuntimeDir: () => {},
  projectDirFor: (id: string) => `/projects/${id}`,
}))

// ── ../git-cloner ─────────────────────────────────────────────────────────────
let isGitRepoVal = true
let runGitImpl: (args: string[]) => any = async () => ({ stdout: '', stderr: '' })
const gitCalls: { fetchReset: any[]; unshallow: any[] } = { fetchReset: [], unshallow: [] }
let fetchResetImpl: (o: any) => any = async () => ({ commitSha: 'abcdef1234567890' })
let unshallowImpl: (o: any) => any = async () => {}
mock.module('../git-cloner.ts', () => ({
  isGitRepo: () => isGitRepoVal,
  runGit: (args: string[], opts: any) => runGitImpl(args),
  gitFetchAndReset: (o: any) => { gitCalls.fetchReset.push(o); return fetchResetImpl(o) },
  gitFetchUnshallow: (o: any) => { gitCalls.unshallow.push(o); return unshallowImpl(o) },
}))

// ── @shogo-ai/sdk/cloud-file-transport ────────────────────────────────────────
let uploadAllImpl: (o: any) => any = async () => ({ uploaded: 3, deleted: 0, errors: [] })
let lastTransportOpts: any = null
mock.module('@shogo-ai/sdk/cloud-file-transport', () => ({
  CloudFileTransport: class {
    opts: any
    constructor(o: any) { this.opts = o; lastTransportOpts = o }
    uploadAll(args: any) { return uploadAllImpl({ ...args, ctor: this.opts }) }
  },
}))

import {
  detectTarget,
  readInstalledVersion,
  resolveLatestVersion,
  installRuntime,
  getRuntimePaths,
} from '../runtime-install'
import { runProjectCheckout } from '../../commands/project-checkout'
import { runProjectPush } from '../../commands/project-push'

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} }

beforeEach(() => {
  existsPredicate = () => false
  readFileImpl = () => ''
  fsWrites.length = 0; fsRenames.length = 0; fsRemoves.length = 0; fsMkdirs.length = 0
  computedDigest = 'a'.repeat(64)
  pipelineThrows = false
  tarExitCode = 0; tarEmitsError = false
  isGitRepoVal = true
  runGitImpl = async () => ({ stdout: '', stderr: '' })
  fetchResetImpl = async () => ({ commitSha: 'abcdef1234567890' })
  unshallowImpl = async () => {}
  gitCalls.fetchReset.length = 0; gitCalls.unshallow.length = 0
  uploadAllImpl = async () => ({ uploaded: 3, deleted: 0, errors: [] })
  lastTransportOpts = null
})

// ════════════════════════════════════════════════════════════════════════════
// runtime-install.ts
// ════════════════════════════════════════════════════════════════════════════
describe('runtime-install: detectTarget', () => {
  const origPlatform = process.platform
  const origArch = process.arch
  function setEnv(platform: string, arch: string) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
  }
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true })
    Object.defineProperty(process, 'arch', { value: origArch, configurable: true })
  })

  test('darwin/arm64', () => { setEnv('darwin', 'arm64'); expect(detectTarget()).toBe('darwin-arm64') })
  test('linux/x64', () => { setEnv('linux', 'x64'); expect(detectTarget()).toBe('linux-x64') })
  test('win32/x64', () => { setEnv('win32', 'x64'); expect(detectTarget()).toBe('windows-x64') })
  test('unsupported platform throws', () => { setEnv('freebsd', 'x64'); expect(() => detectTarget()).toThrow(/Unsupported platform/) })
  test('unsupported arch throws', () => { setEnv('linux', 'mips'); expect(() => detectTarget()).toThrow(/Unsupported arch/) })
})

describe('runtime-install: readInstalledVersion', () => {
  test('returns null when version file absent', () => {
    existsPredicate = () => false
    expect(readInstalledVersion()).toBeNull()
  })
  test('parses installed version json', () => {
    existsPredicate = () => true
    readFileImpl = () => JSON.stringify({ version: '1.2.3', target: 'linux-x64' })
    expect(readInstalledVersion()?.version).toBe('1.2.3')
  })
  test('returns null on malformed json', () => {
    existsPredicate = () => true
    readFileImpl = () => '{not-json'
    expect(readInstalledVersion()).toBeNull()
  })
})

describe('runtime-install: resolveLatestVersion', () => {
  const ghBase = 'https://github.com/shogo-ai/shogo/releases/download'

  test('non-github baseUrl throws', async () => {
    await expect(resolveLatestVersion('stable', 'https://cdn.example.com/rt')).rejects.toThrow(/non-GitHub baseUrl/)
  })
  test('stable reads releases/latest tag_name', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ({ tag_name: 'v2.5.1' }) })
    expect(await resolveLatestVersion('stable', ghBase)).toBe('2.5.1')
  })
  test('stable throws on API error', async () => {
    fetchHandler = () => ({ ok: false, status: 503 })
    await expect(resolveLatestVersion('stable', ghBase)).rejects.toThrow(/GitHub API 503/)
  })
  test('stable throws when tag_name missing', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ({}) })
    await expect(resolveLatestVersion('stable', ghBase)).rejects.toThrow(/did not return tag_name/)
  })
  test('beta picks newest matching prerelease', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ([
      { tag_name: 'v3.0.0', prerelease: false },
      { tag_name: 'v3.1.0-beta.2', prerelease: true },
    ]) })
    expect(await resolveLatestVersion('beta', ghBase)).toBe('3.1.0-beta.2')
  })
  test('nightly matches -nightly tags', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ([
      { tag_name: 'v4.0.0-nightly.7', prerelease: true },
    ]) })
    expect(await resolveLatestVersion('nightly', ghBase)).toBe('4.0.0-nightly.7')
  })
  test('prerelease list API error throws', async () => {
    fetchHandler = () => ({ ok: false, status: 500 })
    await expect(resolveLatestVersion('beta', ghBase)).rejects.toThrow(/GitHub API 500/)
  })
  test('no matching prerelease throws', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ([{ tag_name: 'v1.0.0', prerelease: false }]) })
    await expect(resolveLatestVersion('beta', ghBase)).rejects.toThrow(/No beta runtime release/)
  })
  test('malformed tag throws via tagToVersion', async () => {
    fetchHandler = () => ({ ok: true, json: async () => ({ tag_name: 'release-99' }) })
    await expect(resolveLatestVersion('stable', ghBase)).rejects.toThrow(/Unexpected app tag/)
  })
})

describe('runtime-install: installRuntime', () => {
  const ghBase = 'https://github.com/shogo-ai/shogo/releases/download'

  function wireDownload(sha = 'a'.repeat(64)) {
    fetchHandler = (url: string) => {
      if (url.endsWith('.sha256')) return { ok: true, text: async () => `${sha}  shogo-agent-runtime.tar.gz` }
      return { ok: true, body: {} }
    }
  }

  test('short-circuits when same version already installed', async () => {
    existsPredicate = () => true
    readFileImpl = () => JSON.stringify({ version: '1.0.0', target: 'linux-x64', source: 'src-url', sha256: 'dd' })
    const res = await installRuntime({ version: '1.0.0', target: 'linux-x64', logger: silentLogger })
    expect(res.version).toBe('1.0.0')
    expect(res.source).toBe('src-url')
    expect(gitCalls.fetchReset.length).toBe(0)
  })

  test('full install happy path verifies sha + writes version record', async () => {
    // version file absent → no short circuit; staging bin present after extract
    existsPredicate = (p) => p.endsWith('agent-runtime') || p.endsWith('.next') === false && p.includes('extract')
    existsPredicate = (p) => p.includes('extract') && p.endsWith('agent-runtime')
    computedDigest = 'b'.repeat(64)
    wireDownload('b'.repeat(64))
    const res = await installRuntime({ version: '2.0.0', target: 'linux-x64', logger: silentLogger })
    expect(res.version).toBe('2.0.0')
    expect(res.sha256).toBe('b'.repeat(64))
    expect(fsWrites.some((w) => w.path.endsWith('version.json'))).toBe(true)
  })

  test('sha mismatch throws', async () => {
    existsPredicate = (p) => p.includes('extract') && p.endsWith('agent-runtime')
    computedDigest = 'c'.repeat(64)
    wireDownload('d'.repeat(64))
    await expect(installRuntime({ version: '2.0.0', target: 'linux-x64', logger: silentLogger }))
      .rejects.toThrow(/SHA-256 mismatch/)
  })

  test('missing agent-runtime in tarball throws', async () => {
    existsPredicate = () => false
    computedDigest = 'e'.repeat(64)
    wireDownload('e'.repeat(64))
    await expect(installRuntime({ version: '2.0.0', target: 'linux-x64', logger: silentLogger }))
      .rejects.toThrow(/did not contain .\/agent-runtime/)
  })

  test('download HTTP error throws', async () => {
    fetchHandler = () => ({ ok: false, status: 404 })
    await expect(installRuntime({ version: '2.0.0', target: 'linux-x64', logger: silentLogger }))
      .rejects.toThrow(/Download failed: HTTP 404/)
  })

  test('tar exit non-zero throws', async () => {
    existsPredicate = (p) => p.includes('extract') && p.endsWith('agent-runtime')
    tarExitCode = 1
    computedDigest = 'f'.repeat(64)
    wireDownload('f'.repeat(64))
    await expect(installRuntime({ version: '2.0.0', target: 'linux-x64', logger: silentLogger }))
      .rejects.toThrow(/tar exited 1/)
  })

  test('resolves latest version when none provided', async () => {
    existsPredicate = (p) => p.includes('extract') && p.endsWith('agent-runtime')
    computedDigest = '0'.repeat(64)
    fetchHandler = (url: string) => {
      if (url.includes('releases/latest')) return { ok: true, json: async () => ({ tag_name: 'v9.9.9' }) }
      if (url.endsWith('.sha256')) return { ok: true, text: async () => `${'0'.repeat(64)}  x` }
      return { ok: true, body: {} }
    }
    const res = await installRuntime({ target: 'linux-x64', baseUrl: ghBase, logger: silentLogger })
    expect(res.version).toBe('9.9.9')
  })
})

describe('runtime-install: getRuntimePaths', () => {
  test('returns the three runtime paths', () => {
    const p = getRuntimePaths()
    expect(p.runtimeBin).toBe('/runtime/agent-runtime')
    expect(p.versionFile).toBe('/runtime/version.json')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// commands/project-checkout.ts
// ════════════════════════════════════════════════════════════════════════════
describe('project-checkout', () => {
  test('throws without projectId', async () => {
    await expect(runProjectCheckout('', {})).rejects.toThrow(/projectId is required/)
  })
  test('throws when local dir missing', async () => {
    existsPredicate = () => false
    await expect(runProjectCheckout('p1', {})).rejects.toThrow(/does not exist/)
  })
  test('throws when not a git repo', async () => {
    existsPredicate = () => true
    isGitRepoVal = false
    await expect(runProjectCheckout('p1', {})).rejects.toThrow(/not a git repo/)
  })
  test('no --at fast-forwards to remote HEAD', async () => {
    existsPredicate = () => true
    await runProjectCheckout('p1', {})
    expect(gitCalls.fetchReset.length).toBe(1)
    expect(gitCalls.fetchReset[0].branch).toBeUndefined()
  })
  test('--unshallow runs unshallow before reset', async () => {
    existsPredicate = () => true
    await runProjectCheckout('p1', { unshallow: true })
    expect(gitCalls.unshallow.length).toBe(1)
  })
  test('--at as resolvable SHA fetches that commit', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => {
      if (args[0] === 'rev-parse') return { stdout: 'deadbeefdeadbeef\n', stderr: '' }
      return { stdout: '', stderr: '' }
    }
    await runProjectCheckout('p1', { at: 'deadbeef' })
    expect(gitCalls.fetchReset[0].branch).toBe('deadbeefdeadbeef')
  })
  test('--at falls back to checkpoint-name lookup', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => {
      if (args[0] === 'rev-parse') throw new Error('not a sha')
      return { stdout: '', stderr: '' }
    }
    fetchHandler = () => ({ ok: true, json: async () => ({
      checkpoints: [{ id: 'c1', commitSha: 'cafebabecafebabe', name: 'My Save', commitMessage: 'x', createdAt: 'now' }],
      hasMore: false,
    }) })
    await runProjectCheckout('p1', { at: 'My Save' })
    expect(gitCalls.fetchReset[0].branch).toBe('cafebabecafebabe')
  })
  test('--at fetch failure triggers unshallow retry', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => (args[0] === 'rev-parse' ? { stdout: 'aa11bb22\n', stderr: '' } : { stdout: '', stderr: '' })
    let calls = 0
    fetchResetImpl = async () => { calls++; if (calls === 1) throw new Error('outside shallow window'); return { commitSha: 'aa11bb22' } }
    await runProjectCheckout('p1', { at: 'aa11bb22' })
    expect(gitCalls.unshallow.length).toBe(1)
  })
  test('--at fetch failure with --unshallow set throws', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => (args[0] === 'rev-parse' ? { stdout: 'aa11bb22\n', stderr: '' } : { stdout: '', stderr: '' })
    fetchResetImpl = async () => { throw new Error('nope') }
    await expect(runProjectCheckout('p1', { at: 'aa11bb22', unshallow: true })).rejects.toThrow(/Cannot reach commit/)
  })
})

describe('project-checkout: resolveCheckpointByName branches', () => {
  test('checkpoint list HTTP error throws', async () => {
    existsPredicate = () => true
    runGitImpl = async () => { throw new Error('not a sha') }
    fetchHandler = () => ({ ok: false, status: 403 })
    await expect(runProjectCheckout('p1', { at: 'foo' })).rejects.toThrow(/Failed to list checkpoints: HTTP 403/)
  })
  test('no matching checkpoint throws', async () => {
    existsPredicate = () => true
    runGitImpl = async () => { throw new Error('not a sha') }
    fetchHandler = () => ({ ok: true, json: async () => ({ checkpoints: [], hasMore: false }) })
    await expect(runProjectCheckout('p1', { at: 'foo' })).rejects.toThrow(/No checkpoint matches/)
  })
  test('matches by commitSha prefix', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => { if (args[0] === 'rev-parse') throw new Error('not a sha'); return { stdout: '', stderr: '' } }
    fetchHandler = () => ({ ok: true, json: async () => ({
      checkpoints: [{ id: 'c', commitSha: 'feed00001111', name: null, commitMessage: null, createdAt: 'n' }],
      hasMore: false,
    }) })
    await runProjectCheckout('p1', { at: 'feed0000' })
    expect(gitCalls.fetchReset[0].branch).toBe('feed00001111')
  })
  test('matches by commitMessage substring', async () => {
    existsPredicate = () => true
    runGitImpl = async (args) => { if (args[0] === 'rev-parse') throw new Error('not a sha'); return { stdout: '', stderr: '' } }
    fetchHandler = () => ({ ok: true, json: async () => ({
      checkpoints: [{ id: 'c', commitSha: '99887766aabb', name: null, commitMessage: 'Fix the LOGIN bug', createdAt: 'n' }],
      hasMore: false,
    }) })
    await runProjectCheckout('p1', { at: 'login' })
    expect(gitCalls.fetchReset[0].branch).toBe('99887766aabb')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// commands/project-push.ts
// ════════════════════════════════════════════════════════════════════════════
describe('project-push', () => {
  test('throws without projectId', async () => {
    await expect(runProjectPush('', {})).rejects.toThrow(/projectId is required/)
  })
  test('throws when source dir missing', async () => {
    existsPredicate = () => false
    await expect(runProjectPush('p1', {})).rejects.toThrow(/Source directory does not exist/)
  })
  test('happy path uploads and prints success summary', async () => {
    existsPredicate = () => true
    uploadAllImpl = async () => ({ uploaded: 5, deleted: 0, errors: [] })
    await runProjectPush('p1', {})
    expect(lastTransportOpts.projectId).toBe('p1')
  })
  test('deleteRemote flag forwarded to uploadAll', async () => {
    existsPredicate = () => true
    let seen: any = null
    uploadAllImpl = async (o) => { seen = o; return { uploaded: 1, deleted: 2, errors: [] } }
    await runProjectPush('p1', { deleteRemote: true })
    expect(seen.deleteRemote).toBe(true)
  })
  test('include csv parsed into array', async () => {
    existsPredicate = () => true
    await runProjectPush('p1', { include: 'src, dist ,, README.md' })
    expect(lastTransportOpts.include).toEqual(['src', 'dist', 'README.md'])
  })
  test('error summary prints first 5 + overflow note', async () => {
    existsPredicate = () => true
    const errors = Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, message: 'boom' }))
    uploadAllImpl = async () => ({ uploaded: 0, deleted: 0, errors })
    await runProjectPush('p1', {})
    expect(lastTransportOpts.projectId).toBe('p1')
  })
  test('onProgress callback handles upload/delete/other + byte formats', async () => {
    existsPredicate = () => true
    uploadAllImpl = async (o) => {
      const cb = o.ctor.onProgress
      cb({ kind: 'upload', index: 0, total: 3, path: 'a', bytes: 512 })          // <1KB
      cb({ kind: 'delete', index: 1, total: 3, path: 'b', bytes: 2048 })         // KB
      cb({ kind: 'scan', index: 2, total: 0, path: 'c', bytes: 5 * 1024 * 1024 }) // MB, total 0
      cb({ kind: 'upload', index: 2, total: 3, path: 'd', bytes: null })          // no bytes
      return { uploaded: 1, deleted: 1, errors: [] }
    }
    await runProjectPush('p1', {})
    expect(lastTransportOpts.projectId).toBe('p1')
  })
})

afterAll(() => {
  mock.restore()
})
