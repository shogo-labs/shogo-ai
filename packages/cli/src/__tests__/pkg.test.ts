// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for packages/cli/src/pkg.ts — Unix-path coverage.
 * Windows code-paths requiring IS_WINDOWS=true at module load are
 * covered by pkg-windows.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { EventEmitter } from 'events'

// ---------------------------------------------------------------------------
// State variables for mocked modules — factories close over these refs
// ---------------------------------------------------------------------------

let _execSyncImpl: (cmd: string, opts?: any) => string = () => ''
let _spawnFactory: (cmd: string, args: string[], opts: any) => any = () => makeProc({ exitCode: 0 })

let _existsMap: Record<string, boolean> = {}
let _lstatIsSymlink = false
let _readlinkResult = ''

// ---------------------------------------------------------------------------
// mock.module calls (hoisted before imports by Bun)
// ---------------------------------------------------------------------------

mock.module('node:child_process', () => ({
  execSync: (cmd: string, opts?: any) => _execSyncImpl(cmd, opts),
  spawn: (cmd: string, args: string[], opts: any) => _spawnFactory(cmd, args, opts),
}))

mock.module('node:fs', () => ({
  existsSync: (p: string) => !!_existsMap[p],
  readlinkSync: (_p: string) => _readlinkResult,
  lstatSync: (_p: string) => ({ isSymbolicLink: () => _lstatIsSymlink }),
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import {
  isNodeAvailableOnWindows,
  isNodeAvailableOnUnix,
  _resetUnixNodeCache,
  resolveBinInvocation,
  isEresolveStderr,
  PlatformPackageManager,
  NodeMissingError,
  pkg,
} from '../pkg'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProc(opts: {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  error?: Error
}): any {
  const proc: any = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => { setImmediate(() => proc.emit('exit', null)) }
  setImmediate(() => {
    if (opts.error) {
      proc.emit('error', opts.error)
    } else {
      if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout))
      if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
      proc.emit('exit', opts.exitCode ?? 0)
    }
  })
  return proc
}

function makeHangingProc(): any {
  const proc: any = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => { setImmediate(() => proc.emit('exit', null)) }
  return proc
}

beforeEach(() => {
  _execSyncImpl = () => ''
  _spawnFactory = () => makeProc({ exitCode: 0 })
  _existsMap = {}
  _lstatIsSymlink = false
  _readlinkResult = ''
  _resetUnixNodeCache()
  delete process.env.SHOGO_BUN_PATH
})

afterEach(() => { _resetUnixNodeCache() })

// ---------------------------------------------------------------------------
// isNodeAvailableOnWindows
// ---------------------------------------------------------------------------

describe('isNodeAvailableOnWindows', () => {
  test('returns true on non-Windows platforms immediately', () => {
    expect(isNodeAvailableOnWindows('/some/path')).toBe(true)
  })

  test('returns true on non-Windows even with empty pathEnv', () => {
    expect(isNodeAvailableOnWindows('')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isNodeAvailableOnUnix
// ---------------------------------------------------------------------------

describe('isNodeAvailableOnUnix', () => {
  test('returns false on win32', () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
    try {
      expect(isNodeAvailableOnUnix('/usr/bin')).toBe(false)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true, writable: true })
    }
  })

  test('returns true when node exists in a PATH dir', () => {
    _existsMap['/usr/local/bin/node'] = true
    expect(isNodeAvailableOnUnix('/usr/bin:/usr/local/bin')).toBe(true)
  })

  test('returns false when node is not in any PATH dir', () => {
    expect(isNodeAvailableOnUnix('/usr/bin:/usr/local/bin')).toBe(false)
  })

  test('returns false for empty pathEnv', () => {
    expect(isNodeAvailableOnUnix('')).toBe(false)
  })

  test('returns false for undefined pathEnv', () => {
    expect(isNodeAvailableOnUnix(undefined)).toBe(false)
  })

  test('skips empty PATH entries gracefully', () => {
    _existsMap['/usr/bin/node'] = true
    expect(isNodeAvailableOnUnix(':/usr/bin:')).toBe(true)
  })

  test('caches result when called with process.env.PATH', () => {
    const origPath = process.env.PATH
    process.env.PATH = '/my/bin'
    _existsMap['/my/bin/node'] = true
    try {
      const first = isNodeAvailableOnUnix()   // uses process.env.PATH, caches true
      _existsMap = {}                          // wipe — second call should use cache
      const second = isNodeAvailableOnUnix()  // hits cache
      expect(first).toBe(true)
      expect(second).toBe(true)
    } finally {
      process.env.PATH = origPath
      _resetUnixNodeCache()
    }
  })

  test('_resetUnixNodeCache clears cached value', () => {
    const origPath = process.env.PATH
    process.env.PATH = '/my/bin'
    _existsMap['/my/bin/node'] = true
    try {
      isNodeAvailableOnUnix()   // caches true
      _resetUnixNodeCache()
      _existsMap = {}
      expect(isNodeAvailableOnUnix()).toBe(false)
    } finally {
      process.env.PATH = origPath
      _resetUnixNodeCache()
    }
  })
})

// ---------------------------------------------------------------------------
// resolveBinInvocation
// ---------------------------------------------------------------------------

describe('resolveBinInvocation', () => {
  test('returns null when shim does not exist', () => {
    expect(resolveBinInvocation('/workspace', 'vite')).toBeNull()
  })

  test('returns {cmd:shim, argsPrefix:[]} when node is on PATH (L146)', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    _existsMap[shim] = true
    _existsMap['/usr/local/bin/node'] = true
    expect(resolveBinInvocation('/workspace', 'vite')).toEqual({ cmd: shim, argsPrefix: [] })
  })

  test('routes through bun when node missing + shim is absolute symlink (L159)', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    const jsEntry = '/workspace/node_modules/vite/bin/vite.js'
    _existsMap[shim] = true
    _existsMap[jsEntry] = true
    _lstatIsSymlink = true
    _readlinkResult = jsEntry  // absolute
    const result = resolveBinInvocation('/workspace', 'vite')
    expect(result).toEqual({ cmd: 'bun', argsPrefix: [jsEntry] })
  })

  test('uses SHOGO_BUN_PATH when set (L159)', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    const jsEntry = '/workspace/node_modules/vite/bin/vite.js'
    _existsMap[shim] = true
    _existsMap[jsEntry] = true
    _lstatIsSymlink = true
    _readlinkResult = jsEntry
    process.env.SHOGO_BUN_PATH = '/custom/bun'
    expect(resolveBinInvocation('/workspace', 'vite')?.cmd).toBe('/custom/bun')
  })

  test('falls back to direct shim when NOT a symlink (L155)', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    _existsMap[shim] = true
    _lstatIsSymlink = false
    expect(resolveBinInvocation('/workspace', 'vite')).toEqual({ cmd: shim, argsPrefix: [] })
  })

  test('falls back to direct shim when jsEntry does not exist (L158)', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    _existsMap[shim] = true
    _lstatIsSymlink = true
    _readlinkResult = '/nonexistent/vite.js'
    expect(resolveBinInvocation('/workspace', 'vite')).toEqual({ cmd: shim, argsPrefix: [] })
  })

  test('falls back when lstatSync throws (L162 catch)', () => {
    // Override lstatSync to throw for this test only
    const shim = '/workspace/node_modules/.bin/vite'
    _existsMap[shim] = true
    // Temporarily override the module with a throwing lstatSync
    mock.module('node:fs', () => ({
      existsSync: (p: string) => !!_existsMap[p],
      readlinkSync: (_p: string) => _readlinkResult,
      lstatSync: (_p: string) => { throw new Error('lstat failed') },
    }))
    const result = resolveBinInvocation('/workspace', 'vite')
    expect(result).toEqual({ cmd: shim, argsPrefix: [] })
    // Restore state-based mock
    mock.module('node:fs', () => ({
      existsSync: (p: string) => !!_existsMap[p],
      readlinkSync: (_p: string) => _readlinkResult,
      lstatSync: (_p: string) => ({ isSymbolicLink: () => _lstatIsSymlink }),
    }))
  })

  test('resolves relative symlink target against shim dir', () => {
    const shim = '/workspace/node_modules/.bin/vite'
    const jsEntry = '/workspace/node_modules/vite/bin/vite.js'
    _existsMap[shim] = true
    _existsMap[jsEntry] = true
    _lstatIsSymlink = true
    _readlinkResult = '../vite/bin/vite.js'  // relative target
    const result = resolveBinInvocation('/workspace', 'vite')
    expect(result?.argsPrefix[0]).toBe(jsEntry)
  })
})

// ---------------------------------------------------------------------------
// isEresolveStderr
// ---------------------------------------------------------------------------

describe('isEresolveStderr', () => {
  test('matches npm 10+ format', () => {
    expect(isEresolveStderr('npm error code ERESOLVE')).toBe(true)
  })

  test('matches older npm format', () => {
    expect(isEresolveStderr('npm ERR! code ERESOLVE')).toBe(true)
  })

  test('returns false for unrelated errors', () => {
    expect(isEresolveStderr('npm ERR! ENOENT')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// PlatformPackageManager — Unix paths
// ---------------------------------------------------------------------------

const pm = new PlatformPackageManager()

describe('PlatformPackageManager.bunBinary', () => {
  test('returns SHOGO_BUN_PATH when set', () => {
    process.env.SHOGO_BUN_PATH = '/opt/bun'
    expect(pm.bunBinary).toBe('/opt/bun')
  })

  test('falls back to "bun"', () => {
    expect(pm.bunBinary).toBe('bun')
  })
})

describe('PlatformPackageManager.installSync — Unix', () => {
  test('runs bun install (plain)', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm.installSync('/tmp/wd')
    expect(cmds[0]).toMatch(/bun.*install/)
  })

  test('frozen: succeeds on first try, no second call', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm.installSync('/tmp/wd', { frozen: true })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]).toContain('--frozen-lockfile')
  })

  test('frozen: falls back to plain install when frozen fails', () => {
    const cmds: string[] = []
    let callN = 0
    _execSyncImpl = (cmd) => {
      cmds.push(cmd)
      if (callN++ === 0) throw new Error('frozen failed')
      return ''
    }
    pm.installSync('/tmp/wd', { frozen: true })
    expect(cmds).toHaveLength(2)
    expect(cmds[1]).not.toContain('--frozen-lockfile')
  })

  test('rethrows errors from non-frozen install', () => {
    _execSyncImpl = () => { throw new Error('install failed hard') }
    expect(() => pm.installSync('/tmp/wd')).toThrow('install failed hard')
  })
})

describe('PlatformPackageManager.installAsync — Unix (installAsyncBun)', () => {
  test('resolves when bun exits 0', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(pm.installAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('rejects when bun exits non-zero', async () => {
    _spawnFactory = () => makeProc({ exitCode: 1, stderr: 'install error' })
    await expect(pm.installAsync('/tmp/wd', { timeout: 5000 })).rejects.toThrow('install error')
  })

  test('frozen: succeeds first try (one spawn)', async () => {
    let count = 0
    _spawnFactory = () => { count++; return makeProc({ exitCode: 0 }) }
    await pm.installAsync('/tmp/wd', { frozen: true })
    expect(count).toBe(1)
  })

  test('frozen: retries plain when frozen fails', async () => {
    let count = 0
    _spawnFactory = () => {
      count++
      return makeProc({ exitCode: count === 1 ? 1 : 0 })
    }
    await pm.installAsync('/tmp/wd', { frozen: true })
    expect(count).toBe(2)
  })

  test('rejects on spawn error event (L451)', async () => {
    _spawnFactory = () => makeProc({ error: new Error('spawn ENOENT') })
    await expect(pm.installAsync('/tmp/wd')).rejects.toThrow('spawn ENOENT')
  })

  test('rejects on timeout (L440)', async () => {
    _spawnFactory = () => makeHangingProc()
    await expect(pm.installAsync('/tmp/wd', { timeout: 50 })).rejects.toThrow('timed out')
  })
})

describe('PlatformPackageManager.execToolSync', () => {
  test('returns execSync output', () => {
    let captured = ''
    _execSyncImpl = (cmd) => { captured = cmd; return 'tool output' }
    expect(pm.execToolSync('prisma', ['generate'], '/tmp/wd')).toBe('tool output')
    expect(captured).toContain('prisma')
  })

  test('useBunFlag includes --bun in cmd', () => {
    let captured = ''
    _execSyncImpl = (cmd) => { captured = cmd; return '' }
    pm.execToolSync('prisma', [], '/tmp/wd', { useBunFlag: true })
    expect(captured).toContain('--bun')
  })

  test('rethrows on execSync failure', () => {
    _execSyncImpl = () => { throw new Error('tool failed') }
    expect(() => pm.execToolSync('prisma', [], '/tmp/wd')).toThrow('tool failed')
  })
})

describe('PlatformPackageManager.execToolAsync', () => {
  test('resolves with stdout (L573)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0, stdout: 'async output' })
    expect(await pm.execToolAsync('prisma', ['generate'], '/tmp/wd')).toBe('async output')
  })

  test('rejects when exits non-zero (L576)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 1, stderr: 'tool error' })
    await expect(pm.execToolAsync('prisma', ['generate'], '/tmp/wd')).rejects.toThrow('tool error')
  })

  test('rejects on spawn error event (L567)', async () => {
    _spawnFactory = () => makeProc({ error: new Error('spawn ENOENT') })
    await expect(pm.execToolAsync('prisma', [], '/tmp/wd')).rejects.toThrow('spawn ENOENT')
  })

  test('rejects on timeout (L560)', async () => {
    _spawnFactory = () => makeHangingProc()
    await expect(pm.execToolAsync('prisma', ['gen'], '/tmp/wd', { timeout: 50 })).rejects.toThrow('timed out')
  })

  test('useBunFlag adds --bun to spawn args', async () => {
    const argvCaptures: string[][] = []
    _spawnFactory = (_cmd, args) => { argvCaptures.push([...args]); return makeProc({ exitCode: 0 }) }
    await pm.execToolAsync('prisma', ['generate'], '/tmp/wd', { useBunFlag: true })
    expect(argvCaptures[0]).toContain('--bun')
  })

  test('exit with non-zero uses stdout as errMsg when stderr is empty (L576)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 2, stdout: 'stdout-err-msg', stderr: '' })
    await expect(pm.execToolAsync('tool', [], '/tmp/wd')).rejects.toThrow('stdout-err-msg')
  })

  test('exit with code and no output uses "exit <code>" as errMsg (L576)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 99, stdout: '', stderr: '' })
    await expect(pm.execToolAsync('tool', [], '/tmp/wd')).rejects.toThrow('exit 99')
  })
})

describe('Prisma convenience wrappers', () => {
  test('prismaGenerate calls execToolSync', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm.prismaGenerate('/tmp/wd')
    expect(cmds.some((c) => c.includes('prisma') && c.includes('generate'))).toBe(true)
  })

  test('prismaDbPush calls execToolSync with db push', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm.prismaDbPush('/tmp/wd')
    expect(cmds.some((c) => c.includes('db') && c.includes('push'))).toBe(true)
  })

  test('prismaDbPush with acceptDataLoss adds flag', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm.prismaDbPush('/tmp/wd', { acceptDataLoss: true })
    expect(cmds.some((c) => c.includes('--accept-data-loss'))).toBe(true)
  })

  test('prismaGenerateAsync resolves', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(pm.prismaGenerateAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('prismaDbPushAsync resolves', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(pm.prismaDbPushAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('prismaDbPushAsync with acceptDataLoss passes flag in args', async () => {
    const argvCaptures: string[][] = []
    _spawnFactory = (_cmd, args) => { argvCaptures.push([...args]); return makeProc({ exitCode: 0 }) }
    await pm.prismaDbPushAsync('/tmp/wd', { acceptDataLoss: true })
    expect(argvCaptures[0]).toContain('--accept-data-loss')
  })
})

describe('NodeMissingError', () => {
  test('has correct code and name', () => {
    const e = new NodeMissingError()
    expect(e.code).toBe('NODE_NOT_INSTALLED')
    expect(e.name).toBe('NodeMissingError')
    expect(e.message).toContain('Node.js')
  })
})

describe('pkg singleton', () => {
  test('is a PlatformPackageManager', () => {
    expect(pkg).toBeInstanceOf(PlatformPackageManager)
  })
})
