// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Windows-path coverage for packages/cli/src/pkg.ts.
 *
 * pkg.ts evaluates `const IS_WINDOWS = process.platform === 'win32'` at
 * MODULE LOAD TIME. To make IS_WINDOWS=true, we:
 *   1. Set process.platform='win32' at the top of this file (module-scope
 *      code that runs before the dynamically-imported pkg.ts loads).
 *   2. Dynamically import '../pkg' inside beforeAll() — AFTER the platform
 *      override — so the module registry for this file loads it fresh with
 *      IS_WINDOWS=true.
 *
 * mock.module calls are hoisted before imports and apply to the dynamic
 * import too, so child_process and fs are mocked throughout.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test'
import { EventEmitter } from 'events'
import { join as pathJoin } from 'path'

// ---------------------------------------------------------------------------
// State variables — factories close over these
// ---------------------------------------------------------------------------

let _execSyncImpl: (cmd: string, opts?: any) => string = () => ''
let _spawnFactory: (cmd: string, args: string[], opts: any) => any = () => makeProc({ exitCode: 0 })
let _existsMap: Record<string, boolean> = {}
let _lstatIsSymlink = false
let _readlinkResult = ''

// ---------------------------------------------------------------------------
// mock.module BEFORE any import of pkg.ts (hoisted by Bun)
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
// Helpers (defined before beforeAll so tests can call them synchronously)
// ---------------------------------------------------------------------------

function makeProc(opts: {
  exitCode?: number | null
  stdout?: string
  stderr?: string
  error?: Error
  noAutoExit?: boolean
}): any {
  const proc: any = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => { if (!opts.noAutoExit) setImmediate(() => proc.emit('exit', null)) }
  if (!opts.noAutoExit) {
    setImmediate(() => {
      if (opts.error) {
        proc.emit('error', opts.error)
      } else {
        if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout))
        if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr))
        proc.emit('exit', opts.exitCode ?? 0)
      }
    })
  }
  return proc
}

function makeHangingProc(): any {
  const proc: any = new EventEmitter()
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.kill = () => { setImmediate(() => proc.emit('exit', null)) }
  return proc
}

// ---------------------------------------------------------------------------
// Load pkg with IS_WINDOWS=true
// ---------------------------------------------------------------------------

let mod: typeof import('../pkg')
let _origPlatform: string

beforeAll(async () => {
  _origPlatform = process.platform
  // Override platform BEFORE dynamic import so IS_WINDOWS evaluates to true
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true, writable: true })
  // Query param forces a fresh module load even if '../pkg' is cached by a previous test file
  mod = await import('../pkg?win32=1' as string)
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: _origPlatform, configurable: true, writable: true })
})

beforeEach(() => {
  _execSyncImpl = () => ''
  _spawnFactory = () => makeProc({ exitCode: 0 })
  _existsMap = {}
  _lstatIsSymlink = false
  _readlinkResult = ''
  delete process.env.SHOGO_BUN_PATH
  mod._resetUnixNodeCache()
})

// ---------------------------------------------------------------------------
// isNodeAvailableOnWindows — Windows paths (L59-64)
// ---------------------------------------------------------------------------

describe('isNodeAvailableOnWindows — Windows paths', () => {
  test('returns true when npm.cmd exists in WINDOWS_NODE_DIR (L59)', () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    expect(mod.isNodeAvailableOnWindows('C:\\Windows')).toBe(true)
  })

  test('returns false when pathEnv is empty/undefined (L60)', () => {
    expect(mod.isNodeAvailableOnWindows(undefined)).toBe(false)
    expect(mod.isNodeAvailableOnWindows('')).toBe(false)
  })

  test('returns true when npm.cmd found in a PATH dir (L62)', () => {
    _existsMap[pathJoin('C:\\mynode', 'npm.cmd')] = true
    expect(mod.isNodeAvailableOnWindows('C:\\other;C:\\mynode;C:\\more')).toBe(true)
  })

  test('returns false when npm.cmd not found anywhere (L64)', () => {
    expect(mod.isNodeAvailableOnWindows('C:\\no-node;C:\\also-no-node')).toBe(false)
  })

  test('skips empty PATH entries', () => {
    expect(mod.isNodeAvailableOnWindows(';C:\\no-node;')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isNodeAvailableOnUnix returns false on win32 (L85)
// ---------------------------------------------------------------------------

describe('isNodeAvailableOnUnix on win32', () => {
  test('returns false on win32', () => {
    expect(mod.isNodeAvailableOnUnix('/usr/bin')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// resolveBinInvocation — Windows path (L144)
// ---------------------------------------------------------------------------

describe('resolveBinInvocation — Windows', () => {
  test('returns cmd shim directly on Windows (L144)', () => {
    // On Windows, candidates are .CMD / .cmd / .exe
    const shimCMD = pathJoin('C:\\workspace', 'node_modules', '.bin', 'vite.CMD')
    _existsMap[shimCMD] = true
    const result = mod.resolveBinInvocation('C:\\workspace', 'vite')
    expect(result).toEqual({ cmd: shimCMD, argsPrefix: [] })
  })

  test('returns null when no Windows shim candidate exists', () => {
    expect(mod.resolveBinInvocation('C:\\workspace', 'missing')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// spawnEnv — Windows PATH normalisation (L221-232)
// ---------------------------------------------------------------------------

describe('PlatformPackageManager.spawnEnv — Windows', () => {
  test('normalises Path/PATH keys into a single PATH with nodejs prepended (L221-232)', () => {
    // Access private method via a public call that invokes spawnEnv internally
    const cmds: string[] = []
    let capturedEnv: Record<string, string> | undefined
    _execSyncImpl = (cmd, opts?: any) => { cmds.push(cmd); capturedEnv = opts?.env; return '' }
    const pm = new mod.PlatformPackageManager()
    pm.installSync('/tmp/wd', { env: { Path: 'C:\\Windows\\System32' } as any })
    // On Windows, Path should have been normalised to PATH with nodejs prepended
    expect(capturedEnv?.PATH).toContain('C:\\Program Files\\nodejs')
    expect(capturedEnv?.['Path']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// installSync — Windows paths
// ---------------------------------------------------------------------------

describe('PlatformPackageManager.installSync — Windows', () => {
  const pm = () => new mod.PlatformPackageManager()

  test('runs npm.cmd install when Node is available (L248)', () => {
    // Make npm.cmd appear in the default nodejs dir
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    pm().installSync('/tmp/wd')
    expect(cmds[0]).toContain('npm.cmd install')
    expect(cmds[0]).toContain('--loglevel=error')
  })

  test('npm ENOENT → NodeMissingError → falls through to bun copyfile (L257)', () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    let callN = 0
    const cmds: string[] = []
    _execSyncImpl = (cmd) => {
      cmds.push(cmd)
      if (callN++ === 0) {
        const e: any = new Error('npm.cmd not found')
        e.code = 'ENOENT'
        throw e
      }
      return ''
    }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      pm().installSync('/tmp/wd')
      expect(warns.some((w) => w.includes('copyfile'))).toBe(true)
      expect(cmds.length).toBe(2) // first npm attempt, then bun
    } finally {
      console.warn = origWarn
    }
  })

  test('npm ERESOLVE → retries with --legacy-peer-deps (L259-272)', () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    let callN = 0
    const cmds: string[] = []
    _execSyncImpl = (cmd) => {
      cmds.push(cmd)
      if (callN++ === 0) {
        const e: any = new Error('ERESOLVE')
        e.stderr = Buffer.from('npm error code ERESOLVE\npeer dep conflict')
        throw e
      }
      return ''
    }
    pm().installSync('/tmp/wd')
    expect(cmds[1]).toContain('--legacy-peer-deps')
  })

  test('npm other error → rethrows (L273-275)', () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    _execSyncImpl = () => { throw new Error('disk full') }
    expect(() => pm().installSync('/tmp/wd')).toThrow('disk full')
  })

  test('npm unavailable → bun install --backend=copyfile (L278-284)', () => {
    // npm.cmd NOT in WINDOWS_NODE_DIR or PATH
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      pm().installSync('/tmp/wd')
      expect(cmds[0]).toContain('--backend=copyfile')
    } finally {
      console.warn = origWarn
    }
  })

  test('installSyncBunCopyfile frozen path (L322-330)', () => {
    const cmds: string[] = []
    let callN = 0
    _execSyncImpl = (cmd) => {
      cmds.push(cmd)
      if (callN++ === 0) throw new Error('frozen failed')  // frozen fails
      return ''
    }
    pm().installSync('/tmp/wd', { frozen: true })
    expect(cmds[0]).toContain('--frozen-lockfile')
    expect(cmds[0]).toContain('--backend=copyfile')
    expect(cmds[1]).toContain('--backend=copyfile')
    expect(cmds[1]).not.toContain('--frozen-lockfile')
  })
})

// ---------------------------------------------------------------------------
// installAsync — Windows paths
// ---------------------------------------------------------------------------

describe('PlatformPackageManager.installAsync — Windows', () => {
  const pm = () => new mod.PlatformPackageManager()

  test('npm available → installAsyncWindowsNpm — exit 0 succeeds (L389)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(pm().installAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('npm exits non-zero with ERESOLVE → retries with --legacy-peer-deps (L400)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    let callN = 0
    const argvCaptures: string[][] = []
    _spawnFactory = (_cmd, args) => {
      argvCaptures.push([...args])
      const code = callN++ === 0 ? 1 : 0
      const stderr = callN === 1 ? 'npm error code ERESOLVE peer dep' : ''
      return makeProc({ exitCode: code, stderr })
    }
    await pm().installAsync('/tmp/wd')
    expect(argvCaptures[1]).toContain('--legacy-peer-deps')
  })

  test('npm exits non-zero without ERESOLVE → rejects (L410)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    _spawnFactory = () => makeProc({ exitCode: 1, stderr: 'real install error' })
    await expect(pm().installAsync('/tmp/wd')).rejects.toThrow('exited with code')
  })

  test('npm ERESOLVE retry fails → rejects (L406)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    let callN = 0
    _spawnFactory = () => makeProc({ exitCode: 1, stderr: callN++ === 0 ? 'ERESOLVE peer' : 'still failed' })
    await expect(pm().installAsync('/tmp/wd')).rejects.toThrow()
  })

  test('spawn error ENOENT → NodeMissingError → bun copyfile fallback (L382-383)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    let callN = 0
    _spawnFactory = () => {
      if (callN++ === 0) {
        const err: any = new Error('ENOENT npm.cmd')
        err.code = 'ENOENT'
        return makeProc({ error: err })
      }
      return makeProc({ exitCode: 0 })
    }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      await pm().installAsync('/tmp/wd')
      expect(warns.some((w) => w.includes('copyfile'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  test('npm unavailable → installAsyncBunCopyfile directly (L353)', async () => {
    // npm.cmd NOT found
    _spawnFactory = () => makeProc({ exitCode: 0 })
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      await pm().installAsync('/tmp/wd')
      expect(warns.some((w) => w.includes('copyfile'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })

  test('installAsyncWindowsNpm timeout → rejects (L371)', async () => {
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    _spawnFactory = () => makeHangingProc()
    await expect(pm().installAsync('/tmp/wd', { timeout: 50 })).rejects.toThrow('timed out')
  })

  test('npm "not recognized" stderr → NodeMissingError → bun copyfile fallback (L391)', async () => {
    // NodeMissingError from L391 is caught by installAsync's .catch and triggers
    // installAsyncBunCopyfile → resolves (not rejects)
    _existsMap[pathJoin('C:\\Program Files\\nodejs', 'npm.cmd')] = true
    _spawnFactory = (cmd) => {
      if (cmd === 'npm.cmd') {
        return makeProc({ exitCode: 1, stderr: 'npm.cmd is not recognized as an internal or external command' })
      }
      return makeProc({ exitCode: 0 })  // bun fallback succeeds
    }
    const warns: string[] = []
    const origWarn = console.warn
    console.warn = (...a: any[]) => warns.push(a.join(' '))
    try {
      await expect(pm().installAsync('/tmp/wd')).resolves.toBeUndefined()
      expect(warns.some((w) => w.includes('copyfile'))).toBe(true)
    } finally {
      console.warn = origWarn
    }
  })
})

// ---------------------------------------------------------------------------
// execToolSync — Windows cmd construction (L490-492)
// ---------------------------------------------------------------------------

describe('PlatformPackageManager.execToolSync — Windows cmd (L490)', () => {
  test('uses npx <tool> on Windows', () => {
    let captured = ''
    _execSyncImpl = (cmd) => { captured = cmd; return '' }
    const p = new mod.PlatformPackageManager()
    p.execToolSync('prisma', ['generate'], '/tmp/wd')
    expect(captured).toMatch(/^npx prisma generate/)
  })
})

// ---------------------------------------------------------------------------
// execToolAsync — Windows IS_WINDOWS block (L533-537)
// ---------------------------------------------------------------------------

describe('PlatformPackageManager.execToolAsync — Windows (L533)', () => {
  test('spawns via shell with npx on Windows', async () => {
    const spawnCmds: string[] = []
    _spawnFactory = (cmd) => { spawnCmds.push(cmd); return makeProc({ exitCode: 0 }) }
    const p = new mod.PlatformPackageManager()
    await p.execToolAsync('prisma', ['generate'], '/tmp/wd')
    // On Windows, cmd is the npx string, spawn is called with shell=true
    expect(spawnCmds[0]).toMatch(/npx prisma/)
  })
})

// ---------------------------------------------------------------------------
// Cover installAsyncBun callbacks in the ?win32=1 module instance
// (npm unavailable → installAsyncBunCopyfile → installAsyncBun)
// ---------------------------------------------------------------------------

describe('installAsyncBun callbacks in Windows module (L440, L451)', () => {
  test('timeout callback fires (L440) via bun copyfile path', async () => {
    // npm unavailable → installAsyncBunCopyfile → installAsyncBun with timeout=50ms
    _spawnFactory = () => makeHangingProc()
    await expect(mod.pkg.installAsync('/tmp/wd', { timeout: 50 })).rejects.toThrow('timed out')
  })

  test('error event fires (L451) via bun copyfile path', async () => {
    _spawnFactory = () => makeProc({ error: new Error('bun ENOENT') })
    await expect(mod.pkg.installAsync('/tmp/wd')).rejects.toThrow('bun ENOENT')
  })
})

// ---------------------------------------------------------------------------
// Cover execToolAsync callbacks in Windows module (L560, L567, L587-591)
// ---------------------------------------------------------------------------

describe('execToolAsync callbacks in Windows module (L560, L567, L587)', () => {
  test('timeout fires (L560)', async () => {
    _spawnFactory = () => makeHangingProc()
    await expect(mod.pkg.execToolAsync('prisma', ['gen'], '/tmp/wd', { timeout: 50 })).rejects.toThrow('timed out')
  })

  test('error event fires (L567)', async () => {
    _spawnFactory = () => makeProc({ error: new Error('spawn err') })
    await expect(mod.pkg.execToolAsync('prisma', [], '/tmp/wd')).rejects.toThrow('spawn err')
  })

  test('exit 0 resolves with stdout (L589-590)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0, stdout: 'ok output' })
    await expect(mod.pkg.execToolAsync('prisma', [], '/tmp/wd')).resolves.toBe('ok output')
  })

  test('exit non-zero rejects with errMsg (L591-593)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 1, stderr: 'failed' })
    await expect(mod.pkg.execToolAsync('prisma', [], '/tmp/wd')).rejects.toThrow('failed')
  })

  test('exit non-zero with empty stderr uses stdout (L592)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 1, stdout: 'stdout-err', stderr: '' })
    await expect(mod.pkg.execToolAsync('tool', [], '/tmp/wd')).rejects.toThrow('stdout-err')
  })

  test('exit non-zero with no output uses "exit N" (L592)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 7, stdout: '', stderr: '' })
    await expect(mod.pkg.execToolAsync('tool', [], '/tmp/wd')).rejects.toThrow('exit 7')
  })
})

// ---------------------------------------------------------------------------
// Cover prisma convenience wrappers in Windows module (L595-628)
// ---------------------------------------------------------------------------

describe('Prisma wrappers in Windows module (L595-628)', () => {
  test('prismaGenerate calls execToolSync (L595)', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    mod.pkg.prismaGenerate('/tmp/wd')
    expect(cmds.some((c) => c.includes('prisma'))).toBe(true)
  })

  test('prismaDbPush (L600)', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    mod.pkg.prismaDbPush('/tmp/wd')
    expect(cmds.some((c) => c.includes('db'))).toBe(true)
  })

  test('prismaDbPush with acceptDataLoss (L602)', () => {
    const cmds: string[] = []
    _execSyncImpl = (cmd) => { cmds.push(cmd); return '' }
    mod.pkg.prismaDbPush('/tmp/wd', { acceptDataLoss: true })
    expect(cmds.some((c) => c.includes('--accept-data-loss'))).toBe(true)
  })

  test('prismaGenerateAsync resolves (L609)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(mod.pkg.prismaGenerateAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('prismaDbPushAsync resolves (L617)', async () => {
    _spawnFactory = () => makeProc({ exitCode: 0 })
    await expect(mod.pkg.prismaDbPushAsync('/tmp/wd')).resolves.toBeUndefined()
  })

  test('prismaDbPushAsync with acceptDataLoss (L622)', async () => {
    // On Windows, execToolAsync embeds args into the npx cmd string, not argv
    const cmdCaptures: string[] = []
    _spawnFactory = (cmd) => { cmdCaptures.push(cmd); return makeProc({ exitCode: 0 }) }
    await mod.pkg.prismaDbPushAsync('/tmp/wd', { acceptDataLoss: true })
    expect(cmdCaptures[0]).toContain('--accept-data-loss')
  })
})
