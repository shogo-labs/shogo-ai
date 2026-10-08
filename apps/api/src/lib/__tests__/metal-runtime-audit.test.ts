// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * The production detector for the placement invariant (one runtime per project,
 * in its home region). Pure finders, the orchestrating audit, and the wiring
 * into the fleet reconciler tick.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import {
  _resetRuntimeAudit,
  auditMetalRuntimes,
  findDuplicateRuntimes,
  findOutsideHomeRuntimes,
  getLastRuntimeAudit,
  projectIdOfRuntimeKey,
  type RuntimeRow,
} from '../metal-runtime-audit'
import { MetalFleetReconciler } from '../metal-fleet-reconciler'
import { MetalPlacementRegistry } from '../metal-placement-registry'

const row = (projectId: string, host: string, ready: boolean, region = 'us'): RuntimeRow => ({
  projectId,
  host,
  ready,
  region,
})

describe('projectIdOfRuntimeKey', () => {
  it('maps project runtime keys and skips keys with no single project', () => {
    expect(projectIdOfRuntimeKey('p1')).toBe('p1')
    expect(projectIdOfRuntimeKey('ws:proj:p1')).toBe('p1')
    expect(projectIdOfRuntimeKey('ws:workspace-1')).toBeNull()
    expect(projectIdOfRuntimeKey('published:p1')).toBeNull()
  })
})

describe('findDuplicateRuntimes', () => {
  it('reports nothing for one host per key', () => {
    expect(findDuplicateRuntimes([row('p1', 'h1', true), row('p2', 'h2', false), row('p3', 'h1', true)])).toEqual([])
  })

  it('two hosts RUNNING the same key is a split-brain', () => {
    expect(findDuplicateRuntimes([row('p1', 'h2', true), row('p1', 'h1', true)])).toEqual([
      { kind: 'duplicate_host', key: 'p1', severity: 'split', hosts: ['h1', 'h2'] },
    ])
  })

  it('a running VM plus a snapshot on another host is a stale copy', () => {
    expect(findDuplicateRuntimes([row('p1', 'h1', true), row('p1', 'h2', false)])[0]).toMatchObject({
      severity: 'stale_copy',
    })
  })

  it('two snapshots on different hosts is still a duplicate (stale copy)', () => {
    expect(findDuplicateRuntimes([row('p1', 'h1', false), row('p1', 'h2', false)])[0]).toMatchObject({
      severity: 'stale_copy',
    })
  })

  it('a host listing a key twice is not a duplicate', () => {
    expect(findDuplicateRuntimes([row('p1', 'h1', true), row('p1', 'h1', false)])).toEqual([])
  })

  it('published runtimes are skipped', () => {
    expect(findDuplicateRuntimes([row('published:p1', 'h1', true), row('published:p1', 'h2', true)])).toEqual([])
  })
})

describe('findOutsideHomeRuntimes', () => {
  const homes = new Map<string, string | null>([
    ['p_eu', 'eu-1'],
    ['p_us', 'us-1'],
    ['p_legacy', null],
    ['p_foreign', 'ap-9'],
  ])
  const peers = ['eu-1', 'us-1']

  it('flags a project running in a region other than its workspace home', () => {
    const v = findOutsideHomeRuntimes([row('p_eu', 'h1', true)], 'us-1', homes, peers)
    expect(v).toEqual([
      { kind: 'outside_home_region', key: 'p_eu', projectId: 'p_eu', region: 'us-1', homeRegion: 'eu-1', hosts: ['h1'] },
    ])
  })

  it('is quiet for projects in their home region, legacy null homes and unknown homes', () => {
    const rows = [row('p_us', 'h1', true), row('p_legacy', 'h1', true), row('p_foreign', 'h2', true), row('p_unknown', 'h2', true)]
    expect(findOutsideHomeRuntimes(rows, 'us-1', homes, peers)).toEqual([])
  })

  it('understands workspace-anchored project keys and skips published/workspace keys', () => {
    const rows = [row('ws:proj:p_eu', 'h1', true), row('published:p_eu', 'h1', true), row('ws:w1', 'h1', true)]
    const v = findOutsideHomeRuntimes(rows, 'us-1', homes, peers)
    expect(v.map((x: any) => x.key)).toEqual(['ws:proj:p_eu'])
  })
})

describe('auditMetalRuntimes', () => {
  let errors: string[]
  let errSpy: ReturnType<typeof spyOn>
  beforeEach(() => {
    _resetRuntimeAudit()
    errors = []
    errSpy = spyOn(console, 'error').mockImplementation((...a: any[]) => {
      errors.push(a.join(' '))
    })
  })
  afterEach(() => errSpy.mockRestore())

  it('reports duplicates and logs each violation at error level', async () => {
    const report = await auditMetalRuntimes({
      listRuntimes: async () => [row('p1', 'h1', true), row('p1', 'h2', true), row('p2', 'h1', true)],
      region: null,
    })
    expect(report?.runtimes).toBe(3)
    expect(report?.violations).toHaveLength(1)
    expect(getLastRuntimeAudit()).toBe(report)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('INVARIANT VIOLATION duplicate_host (split): p1 is held by h1, h2')
  })

  it('adds the home-region check when this control plane has a region and peers', async () => {
    const report = await auditMetalRuntimes({
      listRuntimes: async () => [row('p_eu', 'h1', true)],
      region: 'us-1',
      peerIds: ['eu-1', 'us-1'],
      loadHomeRegions: async (ids) => {
        expect(ids).toEqual(['p_eu'])
        return new Map([['p_eu', 'eu-1']])
      },
    })
    expect(report?.violations.map((v) => v.kind)).toEqual(['outside_home_region'])
    expect(errors[0]).toContain('p_eu runs in us-1')
  })

  it('does not look up home regions in single-region mode', async () => {
    let looked = false
    await auditMetalRuntimes({
      listRuntimes: async () => [row('p1', 'h1', true)],
      region: null,
      loadHomeRegions: async () => {
        looked = true
        return new Map()
      },
    })
    expect(looked).toBe(false)
  })

  it('a failing home-region lookup still reports duplicates', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const report = await auditMetalRuntimes({
      listRuntimes: async () => [row('p1', 'h1', true), row('p1', 'h2', true)],
      region: 'us-1',
      peerIds: ['eu-1', 'us-1'],
      loadHomeRegions: async () => {
        throw new Error('db down')
      },
    })
    warn.mockRestore()
    expect(report?.violations.map((v) => v.kind)).toEqual(['duplicate_host'])
  })

  it('a clean fleet reports an empty violation list (and clears the last report)', async () => {
    await auditMetalRuntimes({ listRuntimes: async () => [row('p1', 'h1', true), row('p1', 'h2', true)], region: null })
    const clean = await auditMetalRuntimes({ listRuntimes: async () => [row('p1', 'h1', true)], region: null })
    expect(clean?.violations).toEqual([])
    expect(getLastRuntimeAudit()?.violations).toEqual([])
  })

  it('never throws: a failing fleet query yields null and keeps the previous report', async () => {
    const prev = await auditMetalRuntimes({ listRuntimes: async () => [row('p1', 'h1', true)], region: null })
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const res = await auditMetalRuntimes({
      listRuntimes: async () => {
        throw new Error('hosts down')
      },
      region: null,
    })
    warn.mockRestore()
    expect(res).toBeNull()
    expect(getLastRuntimeAudit()).toBe(prev)
  })
})

describe('MetalFleetReconciler runs the audit every tick', () => {
  it('a duplicate on the fleet is detected during reconcileOnce', async () => {
    _resetRuntimeAudit()
    const errSpy = spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const controller = {
        getFleetStatus: async () => ({ hosts: [] }),
        listProjects: async () => [
          { projectId: 'p1', ready: true, host: 'h1', region: 'us' },
          { projectId: 'p1', ready: false, host: 'h2', region: 'us' },
        ],
      } as any
      const registry = new MetalPlacementRegistry(() => null)
      const reconciler = new MetalFleetReconciler(controller, registry, { isConfigured: () => false } as any)

      const plan = await reconciler.reconcileOnce()

      expect(plan).not.toBeNull()
      expect(getLastRuntimeAudit()?.violations).toEqual([
        { kind: 'duplicate_host', key: 'p1', severity: 'stale_copy', hosts: ['h1', 'h2'] },
      ])
    } finally {
      errSpy.mockRestore()
      logSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('a failing audit does not break reconciliation', async () => {
    _resetRuntimeAudit()
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = spyOn(console, 'log').mockImplementation(() => {})
    try {
      const controller = {
        getFleetStatus: async () => ({ hosts: [] }),
        listProjects: async () => {
          throw new Error('boom')
        },
      } as any
      const reconciler = new MetalFleetReconciler(
        controller,
        new MetalPlacementRegistry(() => null),
        { isConfigured: () => false } as any,
      )
      expect(await reconciler.reconcileOnce()).not.toBeNull()
    } finally {
      warnSpy.mockRestore()
      logSpy.mockRestore()
    }
  })
})
