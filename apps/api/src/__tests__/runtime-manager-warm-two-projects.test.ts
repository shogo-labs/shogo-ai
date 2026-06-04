// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reproduction: "open 2 projects, click back and forth, one gets ejected".
 *
 * The ejection is NOT time-based — it cannot be the idle reaper, whose window
 * is 45min local / 15min cloud, far longer than the ~minutes a user spends
 * switching. It is COUNT-based: `enforceWorkspacePreviewCap` keeps at most N
 * (=3) `ws:proj:<id>` previews warm and evicts purely by MRU tail, with NO
 * notion of which projects are currently open/visible in the UI.
 *
 * The local heartbeat scheduler (apps/api/src/lib/local-heartbeat-scheduler.ts)
 * starts a runtime for EVERY project whose agentConfig has heartbeatEnabled and
 * is due. The FIX makes those starts `background: true` so they are a fully
 * separate system: never recorded in the preview MRU, never counted toward the
 * cap of 3, and never an eviction victim. A foreground (UI) open promotes a
 * background runtime into the preview set.
 *
 * These tests pin: (1) two open projects alternated never evict, (2) background
 * heartbeat starts no longer eject an open preview, and (3) a background start
 * is itself never the thing evicted.
 *
 * Run: bun test apps/api/src/__tests__/runtime-manager-warm-two-projects.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { RuntimeManager, projectWorkspaceRuntimeKey } from '../lib/runtime/manager'

const prevFlag = process.env.SHOGO_WORKSPACE_RUNTIME

beforeEach(() => {
  process.env.SHOGO_WORKSPACE_RUNTIME = 'true'
})

afterEach(() => {
  if (prevFlag === undefined) delete process.env.SHOGO_WORKSPACE_RUNTIME
  else process.env.SHOGO_WORKSPACE_RUNTIME = prevFlag
})

/**
 * Build a RuntimeManager with the heavy seams stubbed so start() exercises the
 * REAL anchored-keying + recordWorkspaceMru + enforceWorkspacePreviewCap logic
 * without spawning processes or hitting prisma. `attachments` maps anchorId ->
 * the attached project ids returned by resolveAnchorSpawnOpts.
 */
function newManager(attachments: Record<string, string[]> = {}) {
  const rm = new RuntimeManager({ healthCheckInterval: 50 }) as any
  rm.agentManager = { touch: mock(() => {}), stop: mock(async () => {}) }

  rm.resolveAnchorSpawnOpts = async (anchorId: string) => ({
    workspaceId: 'ws-1',
    attachedProjectIds: attachments[anchorId] ?? [],
    localFolders: [],
    readonlyProjectIds: [],
  })

  // Idempotent merged-root rebuild on reuse — no fs.
  rm.buildWorkspaceMergedRoot = async () => {}

  // Stub the spawn: register a running runtime under the merged-root key.
  let port = 37300
  rm.doStartMergedRuntime = async (spec: any) => {
    const p = port++
    const runtime = {
      id: spec.key,
      port: p,
      agentPort: p + 1000,
      status: 'running',
      url: `http://localhost:${p}`,
      startedAt: Date.now(),
      process: null,
      agentProcess: null,
    }
    rm.runtimes.set(spec.key, runtime)
    rm.usedPorts.add(p)
    return rm.toPublicRuntime(runtime)
  }

  // Mimic stop()'s observable effects (drop from runtimes + prune MRU) without
  // the heavy process-tree teardown, and record which key was stopped.
  const stopped: string[] = []
  rm.stop = async (projectId: string) => {
    const key = projectId.startsWith('ws:proj:')
      ? projectId
      : projectWorkspaceRuntimeKey(projectId)
    stopped.push(key)
    const rt = rm.runtimes.get(key)
    if (rt) rt.status = 'stopped'
    rm.runtimes.delete(key)
    const i = rm.workspacePreviewMru.indexOf(key)
    if (i >= 0) rm.workspacePreviewMru.splice(i, 1)
  }

  return { rm, stopped }
}

function liveAnchored(rm: any): string[] {
  return Array.from(rm.runtimes.keys()).filter(
    (k: string) => k.startsWith('ws:proj:') && rm.runtimes.get(k)?.status !== 'stopped',
  )
}

/** The foreground preview set, most-recent-first. */
function previewMru(rm: any): string[] {
  return [...rm.workspacePreviewMru]
}

describe('two open projects under back-and-forth', () => {
  test('control: with only the two open projects, neither is ever evicted (cap=3)', async () => {
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')
    const keyB = projectWorkspaceRuntimeKey('B')

    await rm.start('A')
    await rm.start('B')

    for (let i = 0; i < 12; i++) {
      await rm.start('A')
      rm.touch('A')
      await rm.start('B')
      rm.touch('B')
    }

    expect(rm.runtimes.has(keyA)).toBe(true)
    expect(rm.runtimes.has(keyB)).toBe(true)
    expect(stopped).toEqual([])
  })

  test('fix: background heartbeat starts of OTHER projects never evict the two open projects', async () => {
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')
    const keyB = projectWorkspaceRuntimeKey('B')

    // User opens A, then B (foreground previews).
    await rm.start('A')
    await rm.start('B')

    // The local heartbeat scheduler fires for OTHER projects (background starts).
    await rm.start('C', { background: true })
    await rm.start('D', { background: true })

    // Both open previews stay warm; nothing was evicted.
    expect(stopped).toEqual([])
    expect(rm.runtimes.has(keyA)).toBe(true)
    expect(rm.runtimes.has(keyB)).toBe(true)

    // The background runtimes exist but are a separate system — not in the
    // preview MRU and not counted toward the cap of 3.
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('C'))).toBe(true)
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('D'))).toBe(true)
    expect(previewMru(rm).sort()).toEqual([keyA, keyB].sort())
  })

  test('fix: three open previews + a background start never evicts a real preview', async () => {
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')

    await rm.start('A') // foreground
    await rm.start('B') // foreground
    await rm.start('C') // foreground (at cap=3)
    expect(stopped).toEqual([])

    await rm.start('Z', { background: true }) // heartbeat — separate system

    // The oldest *preview* (A) is NOT evicted by a background start.
    expect(stopped).toEqual([])
    expect(rm.runtimes.has(keyA)).toBe(true)
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('Z'))).toBe(true)
  })

  test('fix: a heartbeat-triggered touch() does not pull a background runtime into the preview set', async () => {
    const { rm } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')

    await rm.start('A') // foreground preview
    await rm.start('Z', { background: true }) // background

    // A heartbeat-triggered agent turn flows model calls through touch().
    rm.touch('Z')

    // Z stays out of the preview MRU despite the touch.
    expect(previewMru(rm)).toEqual([keyA])
  })

  test('fix: opening a background runtime in the UI promotes it to a warm preview', async () => {
    const { rm } = newManager()
    const keyZ = projectWorkspaceRuntimeKey('Z')

    await rm.start('Z', { background: true }) // heartbeat warmed it first
    expect(previewMru(rm)).toEqual([])

    await rm.start('Z') // user opens it → promote to preview

    expect(previewMru(rm)).toEqual([keyZ])
    expect(rm.runtimes.get(keyZ)?.background).toBe(false)
  })

  test('fix: many background heartbeat starts are bounded by their OWN cap and never evict foreground', async () => {
    // Default WORKSPACE_BACKGROUND_MAX=2. Open two foreground previews, then
    // let the heartbeat warm a long stream of OTHER projects. Foreground must
    // stay intact, and the background pool must stay bounded (so it can never
    // crowd the worker's global maxRuntimes and force a preview eviction).
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')
    const keyB = projectWorkspaceRuntimeKey('B')

    await rm.start('A')
    await rm.start('B')

    for (const id of ['C', 'D', 'E', 'F', 'G']) {
      await rm.start(id, { background: true })
    }

    // Foreground previews untouched.
    expect(rm.runtimes.has(keyA)).toBe(true)
    expect(rm.runtimes.has(keyB)).toBe(true)
    expect(previewMru(rm).sort()).toEqual([keyA, keyB].sort())

    // Background pool is bounded to its own cap (2) — the oldest backgrounds
    // were evicted among themselves, never a preview.
    const liveBg = liveAnchored(rm).filter(
      (k) => rm.runtimes.get(k)?.background === true,
    )
    expect(liveBg.length).toBe(2)
    // Everything that was stopped was a background runtime, never A or B.
    expect(stopped).not.toContain(keyA)
    expect(stopped).not.toContain(keyB)
    // Total live runtimes stay small (2 fg + 2 bg) — well under the worker cap.
    expect(liveAnchored(rm).length).toBe(4)
  })

  test('reproduction: a warm switch-back that does NOT refresh recency lets the viewed project drift to LRU and get evicted', async () => {
    // This is the "Spawning agent-runtime for ws:proj:… on switch-back" bug.
    // `/sandbox/url` short-circuits on an already-running runtime and so never
    // calls start() — the only path that refreshes the preview MRU. The viewed
    // project's recency goes stale and the next foreground start evicts it.
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')
    const keyB = projectWorkspaceRuntimeKey('B')
    const keyC = projectWorkspaceRuntimeKey('C')

    await rm.start('A') // open A → MRU=[A]
    await rm.start('B') // open B → MRU=[B,A]
    await rm.start('C') // open C → MRU=[C,B,A] (at cap=3)

    // User switches BACK to A. The real /sandbox/url path here is a pure
    // status() short-circuit — NO start(), NO MRU refresh. A stays at the tail.
    // (We deliberately do NOT call markPreviewActive to model the pre-fix path.)
    expect(previewMru(rm)).toEqual([keyC, keyB, keyA]) // A is the LRU tail

    // A speculative foreground prewarm of a NEW project lands.
    await rm.start('D') // → evicts the LRU tail = A, the project on screen.

    expect(stopped).toEqual([keyA]) // ← the bug: the viewed project was torn down
  })

  test('fix: markPreviewActive on switch-back keeps the actively-viewed project warm (never the LRU victim)', async () => {
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')
    const keyB = projectWorkspaceRuntimeKey('B')

    await rm.start('A') // open A → MRU=[A]
    await rm.start('B') // open B → MRU=[B,A]
    await rm.start('C') // open C → MRU=[C,B,A] (at cap=3)

    // User switches BACK to A. /sandbox/url now marks the preview active, which
    // refreshes A to the front of the MRU even though no respawn happened.
    rm.markPreviewActive('A')
    expect(previewMru(rm)[0]).toBe(keyA)

    // A speculative foreground prewarm of a NEW project lands.
    await rm.start('D') // → evicts the genuine LRU (B), NOT the viewed project A.

    expect(stopped).toEqual([keyB])
    expect(rm.runtimes.has(keyA)).toBe(true) // the project on screen survives
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('D'))).toBe(true)
  })

  test('fix: markPreviewActive promotes a heartbeat-warmed runtime opened in the UI into the protected preview set', async () => {
    const { rm } = newManager()
    const keyZ = projectWorkspaceRuntimeKey('Z')

    // Heartbeat warmed Z in the background; it is NOT a preview yet.
    await rm.start('Z', { background: true })
    expect(previewMru(rm)).toEqual([])
    expect(rm.runtimes.get(keyZ)?.background).toBe(true)

    // User opens Z in the UI → /sandbox/url short-circuits (Z already running)
    // so start() never runs; markPreviewActive must do the promotion itself.
    rm.markPreviewActive('Z')

    expect(rm.runtimes.get(keyZ)?.background).toBe(false)
    expect(previewMru(rm)).toEqual([keyZ])
    // No longer tracked in the background pool.
    expect([...rm.workspaceBackgroundMru]).not.toContain(keyZ)
  })

  test('fix: markPreviewActive is a safe no-op for a project with no running runtime', async () => {
    const { rm, stopped } = newManager()
    // Nothing started — must not throw, must not evict, must not create entries.
    rm.markPreviewActive('nope')
    expect(stopped).toEqual([])
    expect(previewMru(rm)).toEqual([])
  })

  test('fix: the warm-3 cap still applies to FOREGROUND opens (background-exclusion is scoped)', async () => {
    const { rm, stopped } = newManager()
    const keyA = projectWorkspaceRuntimeKey('A')

    // Four foreground opens with a background start interleaved — the cap of 3
    // still evicts the oldest *foreground* preview (A), and the background
    // runtime is untouched by that eviction.
    await rm.start('A')
    await rm.start('B')
    await rm.start('Z', { background: true })
    await rm.start('C')
    await rm.start('D')

    expect(stopped).toEqual([keyA])
    expect(rm.runtimes.has(projectWorkspaceRuntimeKey('Z'))).toBe(true) // never evicted
    expect(previewMru(rm).length).toBe(3)
  })
})
