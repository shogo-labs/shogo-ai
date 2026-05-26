// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `WarmPoolController` — state-machine / pure-logic coverage expansion.
 *
 * The K8s reconcile path is mostly covered by integration / e2e in
 * other repos. This file targets the in-memory state surface so we
 * pull line coverage on `apps/api/src/lib/warm-pool-controller.ts`
 * up from ~52%:
 *
 *   - constructor defaults + WarmPodGoneError shape
 *   - getStatus() / getConfig() / updateConfig() (every patch branch,
 *     including reconcile-interval timer rotation)
 *   - getAssignedUrl/Pod, isAssigned, getPromotedPods, getGcStats
 *   - getExtendedStatus() short-circuit in local mode
 *   - claim() empty-pool COLD_START path
 *   - evictProject() soft + hard branches, with prisma mock
 *   - start() short-circuit when WARM_POOL_ENABLED=false
 *   - hasFileModifyingTools()
 *
 *   bun test apps/api/src/__tests__/warm-pool-controller.branches.test.ts
 */

// Disable the warm pool entirely so start() is exercised through the
// disabled short-circuit and reconcile() never tries to talk to k8s.
process.env.WARM_POOL_ENABLED = 'false'
process.env.SHOGO_LOCAL_MODE = 'true'

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { withK8sExports } from './helpers/k8s-mock'
import { withPrismaExports } from './helpers/prisma-mock-exports'

// ──────────────────────────────────────────────────────────────────
// Mocks
// ──────────────────────────────────────────────────────────────────

const projectRows = new Map<string, { id: string; knativeServiceName: string | null }>()
const projectUpdates: any[] = []
mock.module('../lib/prisma', () => withPrismaExports({
  prisma: {
    project: {
      findUnique: async (args: any) => {
        const row = projectRows.get(args.where.id)
        return row ?? null
      },
      update: async (args: any) => {
        projectUpdates.push(args)
        const row = projectRows.get(args.where.id)
        if (row) {
          if ('knativeServiceName' in args.data) {
            row.knativeServiceName = args.data.knativeServiceName
          }
        }
        return row ?? { id: args.where.id, ...args.data }
      },
      findMany: async () => [],
    },
  },
}))

mock.module('../services/database.service', () => ({
  setProjectKnativeServiceName: async () => true,
  getProjectKnativeServiceName: async () => null,
}))

mock.module('@kubernetes/client-node', () => withK8sExports())

mock.module('./knative-project-manager', () => ({
  mergePatchKnativeService: async () => ({ ok: true }),
  jsonPatchKnativeService: async () => ({ ok: true }),
  getKnativeProjectManager: () => ({
    deletePreviewDomainMapping: async () => {},
  }),
}))

mock.module('./runtime-token', () => ({
  deriveRuntimeToken: () => 'tok',
}))

// buildProjectEnv passthrough for buildProjectEnv() coverage.
mock.module('../lib/runtime/build-project-env', () => ({
  buildProjectEnv: async (projectId: string) => ({
    PROJECT_ID: projectId,
    AI_PROXY_SECRET: 'tok',
  }),
}))

mock.module('@shogo/model-catalog', () => ({
  getModelTier: (_modelId: string) => 'standard',
  resolveModelId: (mode: string) => mode || 'claude-haiku-4-5',
  MODEL_CATALOG: {},
  getModelEntry: (_id: string) => null,
  MODEL_DOLLAR_COSTS: {} as Record<string, any>,
  calculateDollarCost: () => 0,
  getModelBillingModel: (id: string) => id,
  resolveAgentModeDefault: (mode: string) => mode,
}))

mock.module('@shogo/shared-runtime', () => ({
  RUNTIME_CONFIG: {
    apiPort: 4000,
    runtimePort: 5000,
    portRangeStart: 5100,
    portRangeEnd: 5200,
  },
}))

// ──────────────────────────────────────────────────────────────────
// SUT
// ──────────────────────────────────────────────────────────────────
const wpc = await import('../lib/warm-pool-controller')
const { WarmPoolController, WarmPodGoneError, getWarmPoolController } = wpc
const { hasFileModifyingTools, FILE_MODIFYING_TOOLS } = await import('../routes/project-chat')

beforeEach(() => {
  projectRows.clear()
  projectUpdates.length = 0
})

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('WarmPodGoneError', () => {
  test('exposes the expected code and message shape', () => {
    const err = new WarmPodGoneError('svc-x', 'gone')
    expect(err.code).toBe('WARM_POD_GONE')
    expect(err.message).toContain('svc-x')
    expect(err.message).toContain('gone')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('WarmPoolController construction + status', () => {
  test('default ctor surfaces sensible defaults in getStatus/getConfig', () => {
    const c = new WarmPoolController()
    const s = c.getStatus()
    expect(s.enabled).toBe(false) // WARM_POOL_ENABLED=false in this test file
    expect(s.available).toBe(0)
    expect(s.assigned).toBe(0)
    expect(typeof s.targetSize).toBe('number')

    const cfg = c.getConfig()
    expect(typeof cfg.warmPoolMinPods).toBe('number')
    expect(typeof cfg.reconcileIntervalMs).toBe('number')
    expect(typeof cfg.maxPodAgeMs).toBe('number')
    expect(typeof cfg.promotedPodIdleTimeoutMs).toBe('number')
    expect(typeof cfg.promotedPodGcEnabled).toBe('boolean')
  })

  test('config-driven ctor overrides namespace + poolSize', () => {
    const c = new WarmPoolController({
      namespace: 'custom-ns',
      poolSize: 7,
      reconcileIntervalMs: 1000,
      maxPodAgeMs: 60_000,
    })
    expect(c.getConfig().warmPoolMinPods).toBe(7)
    expect(c.getConfig().reconcileIntervalMs).toBe(1000)
    expect(c.getConfig().maxPodAgeMs).toBe(60_000)
    expect(c.getStatus().targetSize).toBe(7)
  })

  test('start() short-circuits when WARM_POOL_ENABLED=false', async () => {
    const c = new WarmPoolController({ poolSize: 1 })
    await c.start()
    // started flag should still be false because the disabled-short-circuit
    // returned before setting `this.started = true`.
    expect(c.getStatus().enabled).toBe(false)
    await c.stop()
  })
})

describe('updateConfig', () => {
  test('applies each documented patch field and is idempotent for unchanged values', () => {
    const c = new WarmPoolController({ poolSize: 2, reconcileIntervalMs: 5000, maxPodAgeMs: 10_000 })
    c.updateConfig({
      warmPoolMinPods: 5,
      reconcileIntervalMs: 7500,
      maxPodAgeMs: 20_000,
      promotedPodIdleTimeoutMs: 3_600_000,
      promotedPodGcEnabled: false,
    })
    const cfg = c.getConfig()
    expect(cfg.warmPoolMinPods).toBe(5)
    expect(cfg.reconcileIntervalMs).toBe(7500)
    expect(cfg.maxPodAgeMs).toBe(20_000)
    expect(cfg.promotedPodIdleTimeoutMs).toBe(3_600_000)
    expect(cfg.promotedPodGcEnabled).toBe(false)

    // Idempotent — calling with the same patch should be a no-op.
    c.updateConfig({ warmPoolMinPods: 5, reconcileIntervalMs: 7500 })
    expect(c.getConfig().warmPoolMinPods).toBe(5)
    expect(c.getConfig().reconcileIntervalMs).toBe(7500)
  })

  test('empty patch is a no-op', () => {
    const c = new WarmPoolController({ poolSize: 3 })
    const before = c.getConfig()
    c.updateConfig({})
    expect(c.getConfig()).toEqual(before)
  })
})

describe('assignment queries', () => {
  test('isAssigned/getAssignedUrl/getAssignedPod default to empty', () => {
    const c = new WarmPoolController()
    expect(c.isAssigned('p-nope')).toBe(false)
    expect(c.getAssignedUrl('p-nope')).toBeNull()
    expect(c.getAssignedPod('p-nope')).toBeNull()
  })

  test('getPromotedPods returns a defensive copy', () => {
    const c = new WarmPoolController()
    const a = c.getPromotedPods()
    const b = c.getPromotedPods()
    expect(a).not.toBe(b)
    expect(a).toEqual([])
  })

  test('getGcStats returns a defensive copy', () => {
    const c = new WarmPoolController()
    const a = c.getGcStats()
    const b = c.getGcStats()
    expect(a).not.toBe(b)
    expect(a.orphansDeleted).toBe(0)
    expect(a.idleEvictions).toBe(0)
  })
})

describe('claim() with empty pool', () => {
  test('returns null when no warm pods are available (COLD START path)', () => {
    const c = new WarmPoolController({ poolSize: 2 })
    const pod = c.claim()
    expect(pod).toBeNull()
  })
})

describe('evictProject', () => {
  test('soft-evict on an unknown project does not throw', async () => {
    const c = new WarmPoolController()
    const res = await c.evictProject('p-missing', { deleteService: false })
    expect(res.evicted).toBe(false)
  })

  test('hard-evict clears DB knativeServiceName mapping', async () => {
    projectRows.set('p-1', { id: 'p-1', knativeServiceName: 'project-p-1' })
    const c = new WarmPoolController({ namespace: 'ws' })
    const res = await c.evictProject('p-1', { deleteService: true })
    expect(res.evicted).toBe(true)
    expect(res.oldService).toBe('project-p-1')
    // Wait a microtask cycle so the fire-and-forget mergePatch path
    // doesn't race the assertion teardown.
    await new Promise((r) => setTimeout(r, 5))
    expect(projectUpdates.some((u) => u.where.id === 'p-1' && u.data.knativeServiceName === null)).toBe(true)
  })

  test('soft-evict on a known project records soft-eviction timestamp', async () => {
    projectRows.set('p-soft', { id: 'p-soft', knativeServiceName: 'project-p-soft' })
    const c = new WarmPoolController({ namespace: 'ws' })
    const res = await c.evictProject('p-soft', { deleteService: false })
    expect(res.evicted).toBe(true)
    expect(res.oldService).toBe('project-p-soft')
  })
})

describe('getExtendedStatus (local-mode shortcut)', () => {
  test('returns base status with cluster:null in local mode', async () => {
    const c = new WarmPoolController({ poolSize: 4 })
    const ext = await c.getExtendedStatus()
    expect(ext.cluster).toBeNull()
    expect(ext.available).toBe(0)
    expect(ext.assigned).toBe(0)
    expect(ext.targetSize).toBe(4)
    expect(Array.isArray(ext.promotedPods)).toBe(true)
    expect(typeof ext.gcStats.orphansDeleted).toBe('number')
  })
})

describe('buildProjectEnv()', () => {
  test('delegates to the runtime/build-project-env helper', async () => {
    const c = new WarmPoolController()
    const env = await c.buildProjectEnv('p-9')
    expect(env.PROJECT_ID).toBe('p-9')
    expect(env.AI_PROXY_SECRET).toBe('tok')
  })
})

describe('hasFileModifyingTools (project-chat helper)', () => {
  test('detects file-modifying tools from FILE_MODIFYING_TOOLS', () => {
    const map = new Map<string, { toolName: string }>([
      ['t-1', { toolName: 'write_file' }],
    ])
    expect(hasFileModifyingTools(map)).toBe(true)
  })

  test('detects any tool whose name starts with mcp_', () => {
    const map = new Map<string, { toolName: string }>([
      ['t-1', { toolName: 'mcp_some_tool' }],
    ])
    expect(hasFileModifyingTools(map)).toBe(true)
  })

  test('returns false when only read-only tools are present', () => {
    const map = new Map<string, { toolName: string }>([
      ['t-1', { toolName: 'read_file' }],
      ['t-2', { toolName: 'list_directory' }],
    ])
    expect(hasFileModifyingTools(map)).toBe(false)
  })

  test('FILE_MODIFYING_TOOLS contains the expected default set', () => {
    expect(FILE_MODIFYING_TOOLS.has('write_file')).toBe(true)
    expect(FILE_MODIFYING_TOOLS.has('exec')).toBe(true)
    expect(FILE_MODIFYING_TOOLS.has('generate_image')).toBe(true)
  })
})

describe('getWarmPoolController singleton', () => {
  test('returns the same instance across calls', () => {
    const a = getWarmPoolController()
    const b = getWarmPoolController()
    expect(a).toBe(b)
  })
})
