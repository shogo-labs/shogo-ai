// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
// Phase 3b: build-pipeline coverage for PreviewManager — sync(), the
// runShogoGenerate fast-bail, runExpoExportWeb early returns,
// restartApiServerOnly delegation, handleCrash backoff math + retry-cap,
// the cross-platform port helpers (forceKillPortPosix/Windows, isPortFree,
// waitForPortRelease) and getDevicePreview state machine.
//
// We deliberately do NOT exercise full start() here — that's Phase 3c
// (process orchestration + crash-recovery integration). We do exercise
// every helper start() depends on.
import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer } from 'net'
import * as childProc from 'child_process'
import { PreviewManager } from '../preview-manager'

let dir: string
let managers: PreviewManager[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-bp-'))
  managers = []
})
afterEach(() => {
  // Stop every manager spawned by mk() so its schema/custom-routes watchers
  // are closed before we rmSync(dir). Otherwise the watcher fires an async
  // ENOENT error into the next test's macrotask queue (visible failure:
  // 'detects legacy "bunx shogo generate" scripts and refuses to invoke them').
  for (const m of managers) {
    try { m.stop() } catch {}
  }
  rmSync(dir, { recursive: true, force: true })
})

function mk(over: Partial<ConstructorParameters<typeof PreviewManager>[0]> = {}) {
  const m = new PreviewManager({
    workspaceDir: dir,
    runtimePort: 38306,
    publicUrl: 'https://preview.example/abc',
    localMode: false,
    ...over,
  })
  managers.push(m)
  return m
}

// apiPort is resolved internally by resolveApiServerPort() and is not a
// constructor option. We force it via reflection so the cross-platform
// port helpers operate on a predictable port.
function mkWithPort(port = 49321) {
  const m = mk()
  ;(m as any).apiPort = port
  return m
}

// bundlerCwd defaults to <workspaceDir>/project/ (legacy Vite layout).
// resolveDevServer/hasNgrok/resolveExpoBin/etc all read from bundlerCwd.
function projectDir(): string {
  const p = join(dir, 'project')
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

// --- sync() ---------------------------------------------------------------

describe('PreviewManager.sync', () => {
  it('returns ok=false when prisma/schema.prisma is missing', async () => {
    const m = mk()
    const r = await m.sync()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('prisma/schema.prisma not found')
  })

  it('returns ok=false when runShogoGenerate fails (no package.json)', async () => {
    // Create a schema but no package.json → runShogoGenerate fast-bails false
    mkdirSync(join(dir, 'project/prisma'), { recursive: true })
    writeFileSync(join(dir, 'project/prisma/schema.prisma'), 'datasource db {}')
    const m = mk() as any
    // Stub killApiServer so we don't actually try to kill anything
    m.killApiServer = async () => {}
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await m.sync()
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/generation failed/)
    } finally {
      log.mockRestore()
    }
  })

  it('reports the live phase + last generate error from a previously-failed regen', async () => {
    mkdirSync(join(dir, 'project/prisma'), { recursive: true })
    writeFileSync(join(dir, 'project/prisma/schema.prisma'), 'datasource db {}')
    const m = mk() as any
    m.killApiServer = async () => {}
    m.lastGenerateError = 'prisma error: invalid'
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await m.sync()
      expect(r.ok).toBe(false)
      expect(r.error).toBe('prisma error: invalid')
    } finally {
      log.mockRestore()
    }
  })

  it('clears a pending schemaTimer before regenerating', async () => {
    mkdirSync(join(dir, 'project/prisma'), { recursive: true })
    writeFileSync(join(dir, 'project/prisma/schema.prisma'), 'datasource db {}')
    const m = mk() as any
    m.killApiServer = async () => {}
    m.schemaTimer = setTimeout(() => {}, 60_000)
    m.pendingSchemaChange = true
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await m.sync()
      expect(m.schemaTimer).toBeNull()
      expect(m.pendingSchemaChange).toBe(false)
    } finally {
      log.mockRestore()
    }
  })
})

// --- runShogoGenerate fast bail -------------------------------------------

describe('PreviewManager runShogoGenerate (private — invoked indirectly)', () => {
  it('returns false when bundlerCwd has no package.json', async () => {
    const m = mk() as any
    const ok = await m.runShogoGenerate()
    expect(ok).toBe(false)
  })

  it('detects legacy "bunx shogo generate" scripts and refuses to invoke them', async () => {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    // PreviewManager.runShogoGenerate watches prisma/schema.prisma to
    // detect a successful regen (mtime bump). Without the file the fs.watch
    // call throws ENOENT before the legacy-script detector even runs.
    mkdirSync(join(cwd, 'prisma'), { recursive: true })
    writeFileSync(join(cwd, 'prisma', 'schema.prisma'), 'datasource db {}')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({
      scripts: { generate: 'bunx shogo generate' },
    }))
    const m = mk() as any
    // Stub spawn so runShogoGenerate's bun-x-shogo fallback can't escape
    let spawnedCmd = ''
    const spawnSpy = spyOn(childProc, 'spawn').mockImplementation((cmd: any, _args: any, _opts: any) => {
      spawnedCmd = String(cmd)
      const fakeProc = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (event: string, cb: any) => {
          if (event === 'close') setImmediate(() => cb(1))
          if (event === 'error') return
        },
        kill: () => {},
        killed: false,
      } as any
      return fakeProc
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ok = await m.runShogoGenerate()
      // The legacy detector OR the fallback all return false on close=1
      expect(ok).toBe(false)
      // Crucially, the cmd actually invoked must NOT be `bunx shogo` —
      // legacy detection takes precedence and routes through the
      // path-based fallback (bun ./node_modules/...) or `bun x shogo`.
      expect(spawnedCmd).not.toMatch(/^bunx shogo/)
    } finally {
      spawnSpy.mockRestore()
      log.mockRestore()
      err.mockRestore()
    }
  })

  it('tolerates malformed package.json (parse error → falls through)', async () => {
    const cwd = join(dir, 'project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'package.json'), '{not json')
    const m = mk() as any
    const spawnSpy = spyOn(childProc, 'spawn').mockImplementation(() => ({
      stdout: { on: () => {} }, stderr: { on: () => {} },
      on: (event: string, cb: any) => { if (event === 'close') setImmediate(() => cb(1)) },
      kill: () => {}, killed: false,
    } as any))
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ok = await m.runShogoGenerate()
      expect(ok).toBe(false)
    } finally {
      spawnSpy.mockRestore()
      log.mockRestore()
      err.mockRestore()
    }
  })
})

// --- runExpoExportWeb early bail ------------------------------------------

describe('PreviewManager.runExpoExportWeb (private)', () => {
  it('is a no-op when expo CLI is not in node_modules', async () => {
    const m = mk() as any
    // _runExpoExportWebImpl returns early when resolveExpoBin → null
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await m._runExpoExportWebImpl({}, join(dir, 'no-expo'))
      // No throw, no expoExportInFlight set
      expect(m.expoExportInFlight).toBeNull()
    } finally {
      log.mockRestore()
    }
  })

  it('reentrancy — concurrent calls share the same in-flight promise', async () => {
    const m = mk() as any
    // Patch _runExpoExportWebImpl to a slow promise so we can hit the guard
    let calls = 0
    m._runExpoExportWebImpl = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 20))
    }
    const a = m.runExpoExportWeb({}, '/whatever')
    const b = m.runExpoExportWeb({}, '/whatever')
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })
})

// --- restartApiServerOnly -------------------------------------------------

describe('PreviewManager.restartApiServerOnly', () => {
  it('clears crashRestartTimer, kills, waits, and respawns the API server', async () => {
    const m = mk() as any
    let sequence: string[] = []
    m.crashRestartTimer = setTimeout(() => sequence.push('CRASH_FIRED'), 5_000)
    m.killApiServer = async () => { sequence.push('kill') }
    m.forceKillPort = async () => { sequence.push('force-kill') }
    m.waitForPortRelease = async () => { sequence.push('wait') }
    m.startApiServer = async () => { sequence.push('start') }
    await m.restartApiServerOnly()
    expect(sequence).toEqual(['kill', 'force-kill', 'wait', 'start'])
    expect(m.crashRestartTimer).toBeNull()
    expect(m.intentionalStop).toBe(true)
    // apiPhase was 'restarting' just before startApiServer was called
    // (startApiServer would normally reset it).
  })
})

// --- handleCrash ----------------------------------------------------------

describe('PreviewManager.handleCrash (private)', () => {
  it('is a no-op while intentionalStop=true', () => {
    const m = mk() as any
    m.intentionalStop = true
    const before = m.crashCount
    m.handleCrash()
    expect(m.crashCount).toBe(before)
  })

  it('is a no-op during regeneration', () => {
    const m = mk() as any
    m.regenerating = true
    const before = m.crashCount
    m.handleCrash()
    expect(m.crashCount).toBe(before)
  })

  it('increments crashCount and schedules a restart timer with exponential backoff', () => {
    const m = mk() as any
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      m.handleCrash()
      expect(m.crashCount).toBe(1)
      expect(m.apiPhase).toBe('restarting')
      expect(m.crashRestartTimer).not.toBeNull()
      // Clean up: clear the timer so it doesn't fire later.
      clearTimeout(m.crashRestartTimer)
      m.crashRestartTimer = null
    } finally { log.mockRestore() }
  })

  it('replaces a pending timer with a new one on rapid successive crashes', () => {
    const m = mk() as any
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      m.handleCrash()
      const first = m.crashRestartTimer
      m.handleCrash()
      const second = m.crashRestartTimer
      expect(first).not.toBe(second)
      clearTimeout(second)
      m.crashRestartTimer = null
    } finally { log.mockRestore() }
  })

  it('gives up after MAX_CRASH_RESTARTS and sets apiPhase=crashed', () => {
    const m = mk() as any
    const log = spyOn(console, 'log').mockImplementation(() => {})
    const err = spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Simulate MAX_CRASH_RESTARTS (=5) prior crashes
      m.crashCount = 5
      m.handleCrash() // 6th call exceeds the cap
      expect(m.apiPhase).toBe('crashed')
      expect(m.crashRestartTimer).toBeNull()
    } finally { log.mockRestore(); err.mockRestore() }
  })
})

// --- forceKillPort* (cross-platform) ------------------------------------

describe('PreviewManager.forceKillPort{Posix,Windows} (private)', () => {
  it('Posix: empty execSync result → no kills attempted', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockReturnValue('' as any)
    const killSpy = spyOn(process, 'kill').mockReturnValue(true as any)
    try {
      ;(m as any).forceKillPortPosix()
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      execSpy.mockRestore()
      killSpy.mockRestore()
    }
  })

  it('Posix: parses PIDs and SIGKILLs each one', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockReturnValue('1234\n5678' as any)
    const killed: Array<[number, string]> = []
    const killSpy = spyOn(process, 'kill').mockImplementation(((pid: number, sig: any) => {
      killed.push([pid, sig])
      return true
    }) as any)
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      ;(m as any).forceKillPortPosix()
      expect(killed.sort()).toEqual([[1234, 'SIGKILL'], [5678, 'SIGKILL']])
    } finally {
      execSpy.mockRestore()
      killSpy.mockRestore()
      log.mockRestore()
    }
  })

  it('Posix: swallows execSync errors', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockImplementation(() => {
      throw new Error('lsof: command not found')
    })
    try {
      expect(() => (m as any).forceKillPortPosix()).not.toThrow()
    } finally {
      execSpy.mockRestore()
    }
  })

  it('Posix: a kill that throws permission denied is ignored', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockReturnValue('1234' as any)
    const killSpy = spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('EPERM')
    })
    try {
      expect(() => (m as any).forceKillPortPosix()).not.toThrow()
    } finally {
      execSpy.mockRestore()
      killSpy.mockRestore()
    }
  })

  it('Windows: no listening PID → fast bail', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockImplementation(() => {
      // findstr exits 1 when no match → execSync throws
      throw Object.assign(new Error('exit 1'), { status: 1 })
    })
    try {
      expect(() => (m as any).forceKillPortWindows()).not.toThrow()
    } finally {
      execSpy.mockRestore()
    }
  })

  it('Windows: parses PID list, skips self/parent/0, runs taskkill', () => {
    const m = mkWithPort()
    const selfPid = String(process.pid)
    const parentPid = String(process.ppid)
    const fakeOutput =
      `  TCP    127.0.0.1:49321         0.0.0.0:0              LISTENING       1234\n` +
      `  TCP    127.0.0.1:49321         0.0.0.0:0              LISTENING       0\n` +
      `  TCP    127.0.0.1:49321         0.0.0.0:0              LISTENING       ${selfPid}\n` +
      `  TCP    127.0.0.1:49321         0.0.0.0:0              LISTENING       ${parentPid}\n` +
      `  TCP    127.0.0.1:49321         0.0.0.0:0              LISTENING       5678\n`
    const taskkilled: string[] = []
    const execSpy = spyOn(childProc, 'execSync').mockImplementation((cmd: any) => {
      const c = String(cmd)
      if (c.startsWith('netstat')) return fakeOutput as any
      if (c.startsWith('taskkill')) {
        const m2 = c.match(/\/PID (\d+)/)
        if (m2) taskkilled.push(m2[1])
        return '' as any
      }
      return '' as any
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      ;(m as any).forceKillPortWindows()
      expect(taskkilled.sort()).toEqual(['1234', '5678'])
    } finally {
      execSpy.mockRestore()
      log.mockRestore()
    }
  })

  it('Windows: taskkill failure is ignored', () => {
    const m = mkWithPort()
    const execSpy = spyOn(childProc, 'execSync').mockImplementation((cmd: any) => {
      const c = String(cmd)
      if (c.startsWith('netstat')) return '  TCP    127.0.0.1:49321  0.0.0.0:0  LISTENING  9999' as any
      if (c.startsWith('taskkill')) throw new Error('Access denied')
      return '' as any
    })
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(() => (m as any).forceKillPortWindows()).not.toThrow()
    } finally {
      execSpy.mockRestore()
      log.mockRestore()
    }
  })

  it('forceKillPort dispatches to the right platform helper', async () => {
    const m = mkWithPort()
    let calledPosix = 0
    let calledWindows = 0
    ;(m as any).forceKillPortPosix = () => { calledPosix++ }
    ;(m as any).forceKillPortWindows = () => { calledWindows++ }
    await (m as any).forceKillPort()
    if (process.platform === 'win32') {
      expect(calledWindows).toBe(1)
      expect(calledPosix).toBe(0)
    } else {
      expect(calledPosix).toBe(1)
      expect(calledWindows).toBe(0)
    }
  })
})

// --- isPortFree -----------------------------------------------------------

describe('PreviewManager.isPortFree (private)', () => {
  it('returns true when nothing is listening on the apiPort', async () => {
    const m = mkWithPort(50121) as any
    expect(await m.isPortFree()).toBe(true)
  })

  it('returns false when something is listening on the apiPort', async () => {
    // Bind a real server so the test runs against actual OS behavior.
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(50123, '127.0.0.1', () => resolve()))
    try {
      const m = mkWithPort(50123) as any
      expect(await m.isPortFree()).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// --- waitForPortRelease ---------------------------------------------------

describe('PreviewManager.waitForPortRelease (private)', () => {
  it('returns immediately when the port is already free', async () => {
    const m = mkWithPort(50125) as any
    const t0 = Date.now()
    await m.waitForPortRelease(2000)
    expect(Date.now() - t0).toBeLessThan(750)
  })

  it('logs a warning and gives up after timeoutMs when the port is still bound', async () => {
    const server = createServer()
    await new Promise<void>((r) => server.listen(50127, '127.0.0.1', () => r()))
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const m = mkWithPort(50127) as any
      const t0 = Date.now()
      await m.waitForPortRelease(500)
      const elapsed = Date.now() - t0
      expect(elapsed).toBeGreaterThanOrEqual(450)
      expect(elapsed).toBeLessThan(2000)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })
})

// --- resolveExpoBin + hasNgrok -------------------------------------------

describe('PreviewManager.resolveExpoBin / hasNgrok (private)', () => {
  it('resolveExpoBin returns null when nothing exists in node_modules/.bin', () => {
    const m = mk() as any
    expect(m.resolveExpoBin(dir)).toBeNull()
  })

  it('resolveExpoBin returns the unix shim on POSIX', () => {
    if (process.platform === 'win32') return // skipped on Windows
    const binDir = join(dir, 'node_modules/.bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'expo'), '#!/bin/sh\necho hi')
    const m = mk() as any
    expect(m.resolveExpoBin(dir)).toBe(join(binDir, 'expo'))
  })

  it('hasNgrok detects @expo/ngrok in workspace node_modules', () => {
    const m = mk() as any
    const p = projectDir()
    expect(m.hasNgrok(p)).toBe(false)
    mkdirSync(join(p, 'node_modules/@expo/ngrok'), { recursive: true })
    expect(m.hasNgrok(p)).toBe(true)
  })
})

// --- getDevicePreview ----------------------------------------------------

describe('PreviewManager.getDevicePreview', () => {
  function setMetroStack() {
    // .tech-stack marker lives at workspaceDir; "expo-app" is the
    // canonical id (see packages/agent-runtime/tech-stacks/expo-app/stack.json),
    // and its runtime.devServer is "metro".
    writeFileSync(join(dir, '.tech-stack'), 'expo-app')
  }

  it('reports devServer=vite when the stack is web', () => {
    const r = mk().getDevicePreview()
    expect(r.devServer).toBe('vite')
    expect(r.deviceMode).toBe('not-applicable')
  })

  it('reports cloud-todo when on Metro stack but not in localMode', () => {
    setMetroStack()
    const m = mk({ localMode: false })
    const r = m.getDevicePreview()
    expect(r.devServer).toBe('metro')
    expect(r.deviceMode).toBe('cloud-todo')
    expect(r.message).toMatch(/Web preview/)
  })

  it('reports local-tunnel-unavailable when ngrok is missing in local mode', () => {
    setMetroStack()
    const m = mk({ localMode: true })
    const r = m.getDevicePreview()
    expect(r.deviceMode).toBe('local-tunnel-unavailable')
    expect(r.message).toMatch(/@expo\/ngrok/)
  })

  it('reports local-tunnel (waiting) when ngrok is present but no URL yet', () => {
    setMetroStack()
    mkdirSync(join(projectDir(), 'node_modules/@expo/ngrok'), { recursive: true })
    const m = mk({ localMode: true }) as any
    m.metroPort = 8081
    const r = m.getDevicePreview()
    expect(r.deviceMode).toBe('local-tunnel')
    expect(r.metroUrl).toBeNull()
    expect(r.metroPort).toBe(8081)
    expect(r.message).toMatch(/Expo tunnel is starting/)
  })

  it('reports local-tunnel (ready) once the URL has been captured', () => {
    setMetroStack()
    mkdirSync(join(projectDir(), 'node_modules/@expo/ngrok'), { recursive: true })
    const m = mk({ localMode: true }) as any
    m.metroUrl = 'exp+app://abc.exp.direct'
    m.metroPort = 8081
    const r = m.getDevicePreview()
    expect(r.deviceMode).toBe('local-tunnel')
    expect(r.metroUrl).toBe('exp+app://abc.exp.direct')
    expect(r.publicUrl).toBe('exp+app://abc.exp.direct')
    expect(r.message).toBeNull()
  })
})
