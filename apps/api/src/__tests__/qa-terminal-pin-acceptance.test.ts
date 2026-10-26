// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-107 QA acceptance.
 *
 * The card's failure happened in the **desktop** (local mode, Windows smoke),
 * and the desktop API is a different composer from cloud: `apps/api/src/entry.ts`
 * loads `local-server.ts` when `SHOGO_LOCAL_MODE === 'true'` and `server.ts`
 * otherwise. A pin wired into only one of them is inert on the other surface,
 * so the manager-level unit tests stay green while the user still loses the
 * terminal.
 */
import { describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  RuntimeManager,
  projectWorkspaceRuntimeKey,
  workspaceRuntimeKey,
} from '../lib/runtime/manager'
import { buildPtyPodBridgeData } from '../lib/pty-pod-bridge'

/**
 * Every API entrypoint that dispatches a PTY bridge socket must count that
 * socket, on open and on close, so `hasActiveWork()` can pin the runtime.
 * Discovered rather than listed, so a third composer cannot slip through.
 */
function ptyComposers(): Array<{ file: string; source: string; lines: string[] }> {
  const srcDir = join(import.meta.dir, '..')
  const out: Array<{ file: string; source: string; lines: string[] }> = []
  for (const entry of readdirSync(srcDir)) {
    if (!entry.endsWith('.ts')) continue
    const source = readFileSync(join(srcDir, entry), 'utf8')
    const dispatchesPtyBridge =
      (source.includes('isPtyPodBridgeData(') || source.includes('isLocalPtyBridgeData(')) &&
      /(ptyBridge|ptyPodBridge)\.open\(/.test(source)
    if (!dispatchesPtyBridge) continue
    out.push({ file: entry, source, lines: source.split('\n') })
  }
  return out
}

const PIN = /noteTerminalSession|TerminalSession\(/

describe('SHO-107 QA — a live terminal pins its runtime on every API surface', () => {
  test('both the cloud and the local composer are discovered', () => {
    const files = ptyComposers().map((c) => c.file).sort()
    expect(files).toEqual(['local-server.ts', 'server.ts'])
  })

  test('each PTY bridge socket open and close counts the terminal session', () => {
    const offenders: string[] = []
    for (const { file, lines } of ptyComposers()) {
      for (const [i, line] of lines.entries()) {
        if (!/(ptyBridge|ptyPodBridge)\.(open|close)\(/.test(line)) continue
        const window = lines.slice(Math.max(0, i - 6), i + 7).join('\n')
        if (!PIN.test(window)) {
          offenders.push(`${file}:${i + 1} ${line.trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('both composers share one pin implementation, and it really counts', () => {
    const composers = ptyComposers()
    const local = composers.find((c) => c.file === 'local-server.ts')!
    const cloud = composers.find((c) => c.file === 'server.ts')!
    for (const composer of [local, cloud]) {
      expect(composer.source).toContain("from './lib/terminal-session-pin'")
    }
    const pin = readFileSync(join(import.meta.dir, '..', 'lib', 'terminal-session-pin.ts'), 'utf8')
    expect(pin).toContain('noteTerminalSession')

    // One implementation, not two mirrors: no composer may define its own copy.
    const srcDir = join(import.meta.dir, '..')
    const copies = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /function\s+countTerminalSession\s*\(/.test(readFileSync(join(srcDir, f), 'utf8')))
    expect([...copies, 'lib/terminal-session-pin.ts'].sort()).toEqual(['lib/terminal-session-pin.ts'])
  })

  test('every PTY bridge upgrade carries projectId (an omitted id is a silent no-op)', () => {
    const srcDir = join(import.meta.dir, '..')
    const offenders: string[] = []
    for (const entry of readdirSync(srcDir)) {
      if (!entry.endsWith('.ts')) continue
      const lines = readFileSync(join(srcDir, entry), 'utf8').split('\n')
      for (const [i, line] of lines.entries()) {
        if (!line.includes('buildPtyPodBridgeData({')) continue
        const window = lines.slice(i, i + 8).join('\n')
        if (!/projectId[,:]/.test(window)) offenders.push(`${entry}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

function fakeProcess() {
  const proc = {
    killed: false,
    exitCode: null as number | null,
    kill: mock(() => true),
    on: mock((event: string, cb: () => void) => {
      if (event === 'exit') queueMicrotask(cb)
      return proc
    }),
  }
  return proc
}

type PrivateRM = RuntimeManager & {
  runtimes: Map<string, any>
  usedPorts: Set<number>
  agentManager: any
  agentManagedProjects: Set<string>
  workspacePreviewMru: string[]
  workspacePreviewMax: number
  runtimeOwners: Map<string, { workspaceId: string; anchorProjectId?: string }>
  doStartMergedRuntime: any
  enforceWorkspacePreviewCap: () => Promise<void>
  recordWorkspaceMru: (key: string) => void
}

function newLowTierManager(): PrivateRM {
  const prevTier = process.env.SHOGO_HOST_TIER
  const prevMax = process.env.WORKSPACE_PREVIEW_MAX
  delete process.env.WORKSPACE_PREVIEW_MAX
  process.env.SHOGO_HOST_TIER = 'low'
  try {
    const rm = new RuntimeManager({ healthCheckInterval: 50 }) as PrivateRM
    rm.agentManager = {
      touch: mock(() => {}),
      stop: mock(async () => {}),
      refreshActivity: mock(async () => {}),
    }
    return rm
  } finally {
    if (prevTier === undefined) delete process.env.SHOGO_HOST_TIER
    else process.env.SHOGO_HOST_TIER = prevTier
    if (prevMax !== undefined) process.env.WORKSPACE_PREVIEW_MAX = prevMax
  }
}

function seedAnchored(rm: PrivateRM, projectId: string, port: number) {
  const key = projectWorkspaceRuntimeKey(projectId)
  rm.runtimes.set(key, {
    id: key,
    port,
    agentPort: port + 1000,
    status: 'running',
    url: `http://localhost:${port}`,
    startedAt: Date.now(),
    process: null,
    agentProcess: fakeProcess(),
  })
  rm.usedPorts.add(port)
  rm.runtimeOwners.set(key, { workspaceId: 'w-anchor', anchorProjectId: projectId })
  return key
}

describe('SHO-107 QA — the boot sequence that killed the Windows smoke', () => {
  test('an open PTY on the anchored runtime survives the boot LRU sweep (cap=1)', async () => {
    const rm = newLowTierManager()
    expect(rm.workspacePreviewMax).toBe(1)
    // Boot: the anchored runtime the user's terminal lives in, then a second
    // warm key that completes later and makes the anchor the LRU tail.
    const anchor = seedAnchored(rm, 'anchor', 37310)
    const other = seedAnchored(rm, 'other', 37320)
    rm.workspacePreviewMru = [other, anchor]

    // The smoke test's terminal opens over the local PTY bridge, whose data
    // carries projectId. This is the exact call the local composer must make.
    const data = buildPtyPodBridgeData({
      podUrl: 'http://localhost:39999',
      projectId: 'anchor',
      sessionId: 'sess',
      since: 0,
      runtimeToken: 'tok',
    })
    rm.noteTerminalSession(data.projectId!, 1)

    const stopped: string[] = []
    ;(rm as any).stop = mock(async (key: string) => {
      stopped.push(key)
      rm.runtimes.delete(key)
    })
    await rm.enforceWorkspacePreviewCap()

    expect(stopped).toEqual([])
    expect(rm.terminalSessionCount('anchor')).toBe(1)
  })

  test('a workspace resolve joins the in-flight anchor: one spawn, one runtime', async () => {
    const rm = newLowTierManager()
    ;(rm as any).getProjectInfo = mock(async () => ({}))
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => (release = resolve))
    const specs: any[] = []
    ;(rm as any).doStartMergedRuntime = mock(async (spec: any) => {
      specs.push(spec)
      if (spec.key.startsWith('ws:proj:')) {
        rm.runtimeOwners.set(spec.key, { workspaceId: spec.workspaceId, anchorProjectId: 'anchor' })
        await gate
        return {
          id: spec.key,
          port: 37400,
          agentPort: 38400,
          status: 'running',
          url: 'http://localhost:37400',
          startedAt: Date.now(),
          process: null,
          agentProcess: fakeProcess(),
        }
      }
      return {
        id: spec.key,
        port: 37401,
        agentPort: 38401,
        status: 'running',
        url: 'http://localhost:37401',
        startedAt: Date.now(),
        process: null,
        agentProcess: fakeProcess(),
      }
    })

    const anchored = rm.startProjectWorkspace('anchor', { workspaceId: 'w1' } as any)
    // Give the anchored start its first await, exactly like the boot prewarm.
    await new Promise((r) => setTimeout(r, 20))
    const resolved = rm.startWorkspace('w1', { attachedProjectIds: [] })
    await new Promise((r) => setTimeout(r, 30))
    release!()
    const [anchorRuntime, workspaceRuntime] = await Promise.all([anchored, resolved])

    expect(specs.filter((s) => s.key.startsWith('ws:proj:')).length).toBe(1)
    expect(specs.some((s) => s.key === workspaceRuntimeKey('w1'))).toBe(false)
    expect(workspaceRuntime.id).toBe(anchorRuntime.id)
    expect(workspaceRuntime.port).toBe(anchorRuntime.port)
  })

})
