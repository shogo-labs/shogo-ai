// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// SHO-138: the reconcile sweep deletes customer-facing infra, so its decision
// function is pure and pinned here. The asymmetry that matters: a wrong SKIP
// leaves an orphan serving (recoverable, the next sweep catches it), a wrong
// SELECT deletes a live site (not recoverable). Every rule below is one of the
// guards that makes a wrong select impossible.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SWEEP_MIN_AGE_MS,
  mergeProjectRows,
  runPublishedSiteSweep,
  selectOrphanedPublishedSites,
  type ProjectPublishRow,
  type PublishedRuntimeSnapshot,
} from '../published-site-sweep'

const NOW = Date.parse('2026-10-22T12:00:00Z')
const OLD = NOW - DEFAULT_SWEEP_MIN_AGE_MS - 60_000
const YOUNG = NOW - 5 * 60_000

function runtime(over: Partial<PublishedRuntimeSnapshot> = {}): PublishedRuntimeSnapshot {
  return {
    projectId: 'proj-1',
    substrate: 'knative',
    name: 'published-proj-1',
    subdomain: 'my-site',
    createdAtMs: OLD,
    ...over,
  }
}

const unpublishedRow: ProjectPublishRow = { publishedSubdomain: null, publishStatus: 'idle' }

describe('selectOrphanedPublishedSites', () => {
  test('selects a published runtime whose project row is gone from every region', () => {
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: new Map(),
      now: NOW,
    })

    expect(skipped).toEqual([])
    expect(selected).toEqual([
      {
        projectId: 'proj-1',
        substrate: 'knative',
        name: 'published-proj-1',
        subdomain: 'my-site',
        reason: 'project-row-missing',
      },
    ])
  })

  test('never selects a project whose row still has a subdomain', () => {
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: new Map([
        ['proj-1', { publishedSubdomain: 'my-site', publishStatus: 'live' } as ProjectPublishRow],
      ]),
      now: NOW,
    })

    expect(selected).toEqual([])
    expect(skipped[0].reason).toBe('has-subdomain')
  })

  test('never selects a project that is publishing right now', () => {
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: new Map([
        // A real `PublishStatus` member from the window before the publish
        // writes `publishedSubdomain` (QA's acceptance test pins all three).
        ['proj-1', { publishedSubdomain: null, publishStatus: 'uploading' } as ProjectPublishRow],
      ]),
      now: NOW,
    })

    expect(selected).toEqual([])
    expect(skipped[0].reason).toBe('publishing')
  })

  test('never selects a runtime younger than the minimum age', () => {
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime({ createdAtMs: YOUNG })],
      rowsById: new Map([['proj-1', unpublishedRow]]),
      now: NOW,
    })

    expect(selected).toEqual([])
    expect(skipped[0].reason).toBe('too-young')
  })

  test('selects an unpublished row whose runtime is old enough', () => {
    const { selected } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: new Map([['proj-1', unpublishedRow]]),
      now: NOW,
    })

    expect(selected.map((s) => s.reason)).toEqual(['row-unpublished'])
  })

  test('skips a runtime whose subdomain is unknown — a half teardown is worse than none', () => {
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime({ subdomain: null })],
      rowsById: new Map(),
      now: NOW,
    })

    expect(selected).toEqual([])
    expect(skipped[0].reason).toBe('no-subdomain')
  })

  test('a row from ANY region keeps the project alive (cross-region rows are unioned)', () => {
    // The caller unions every region's rows before deciding: a project homed in
    // us-east must never be swept by the eu sweep.
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: { 'proj-1': { publishedSubdomain: 'my-site', publishStatus: 'live' } },
      now: NOW,
    })

    expect(selected).toEqual([])
    expect(skipped.map((s) => s.reason)).toEqual(['has-subdomain'])
  })

  test('one decision per project even when both substrates hold its site', () => {
    const { selected } = selectOrphanedPublishedSites({
      runtimes: [
        runtime(),
        runtime({ substrate: 'metal', name: 'published:proj-1' }),
      ],
      rowsById: new Map(),
      now: NOW,
    })

    expect(selected).toHaveLength(1)
  })
})

/** Sweep deps with everything stubbed; override any field, record teardowns. */
function deps(over: Record<string, unknown> = {}) {
  const tornDown: Array<[string, string]> = []
  return {
    tornDown,
    deps: {
      listRuntimes: async () => [runtime()],
      loadProjectRows: async () => ({ rows: new Map<string, ProjectPublishRow>(), complete: true }),
      teardown: async (projectId: string, subdomain: string) => {
        tornDown.push([projectId, subdomain])
      },
      now: () => NOW,
      ...over,
    },
  }
}

describe('runPublishedSiteSweep', () => {
  test('is a dry run by default — nothing is torn down', async () => {
    const { tornDown, deps: d } = deps()

    const report = await runPublishedSiteSweep(d)

    expect(report.dryRun).toBe(true)
    expect(report.selected).toHaveLength(1)
    expect(report.tornDown).toEqual([])
    expect(tornDown).toEqual([])
  })

  test('apply tears down only the selected projects', async () => {
    const { tornDown, deps: d } = deps()

    const report = await runPublishedSiteSweep(d, { dryRun: false })

    expect(report.tornDown).toEqual([{ projectId: 'proj-1', subdomain: 'my-site' }])
    expect(tornDown).toEqual([['proj-1', 'my-site']])
  })

  test('a failed teardown is reported, not thrown, so the rest of the sweep runs', async () => {
    const seen: string[] = []
    const { deps: d } = deps({
      listRuntimes: async () => [runtime(), runtime({ projectId: 'proj-2', name: 'published-proj-2' })],
      teardown: async (projectId: string) => {
        seen.push(projectId)
        if (projectId === 'proj-1') throw new Error('kube said no')
      },
    })

    const report = await runPublishedSiteSweep(d, { dryRun: false })

    expect(seen).toEqual(['proj-1', 'proj-2'])
    expect(report.failed).toEqual([
      { projectId: 'proj-1', subdomain: 'my-site', error: 'kube said no' },
    ])
    expect(report.tornDown).toEqual([{ projectId: 'proj-2', subdomain: 'my-site' }])
  })
})

describe('mergeProjectRows', () => {
  test('a peer subdomain keeps a site this region thinks is unpublished', () => {
    // prod-US proved this shape is real: the same project id has a row in both
    // regional DBs, and the stale copy can be the one with no subdomain.
    const merged = mergeProjectRows(
      new Map([['proj-1', { publishedSubdomain: null, publishStatus: 'idle' }]]),
      [{ id: 'proj-1', publishedSubdomain: 'my-site', publishStatus: 'live' }],
    )

    expect(merged.get('proj-1')?.publishedSubdomain).toBe('my-site')
  })

  test('a row only another region has keeps the project alive here', () => {
    const merged = mergeProjectRows(new Map(), [
      { id: 'proj-2', publishedSubdomain: null, publishStatus: 'idle' },
    ])

    expect(merged.has('proj-2')).toBe(true)
    expect(merged.get('proj-2')?.publishedSubdomain).toBeNull()
  })

  test('never drops this region\'s subdomain in favour of a peer null', () => {
    const merged = mergeProjectRows(
      new Map([['proj-3', { publishedSubdomain: 'mine', publishStatus: 'live' }]]),
      [{ id: 'proj-3', publishedSubdomain: null, publishStatus: 'idle' }],
    )

    expect(merged.get('proj-3')?.publishedSubdomain).toBe('mine')
  })

  test('merged rows flow into the decision — a peer subdomain means no select', () => {
    const rows = mergeProjectRows(
      new Map([['proj-1', { publishedSubdomain: null, publishStatus: 'idle' }]]),
      [{ id: 'proj-1', publishedSubdomain: 'my-site', publishStatus: 'live' }],
    )
    const { selected } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: rows,
      now: NOW,
    })

    expect(selected).toEqual([])
  })
})

describe('row coverage — the sweep fails closed', () => {
  test('selects nothing when the row load could not cover every region', () => {
    // Without the peer rows, an alive project homed in the other region has no
    // row here and is indistinguishable from a deleted one.
    const { selected, skipped } = selectOrphanedPublishedSites({
      runtimes: [runtime()],
      rowsById: new Map(),
      now: NOW,
      rowCoverageComplete: false,
    })

    expect(selected).toEqual([])
    expect(skipped.map((s) => s.reason)).toEqual(['row-coverage-incomplete'])
  })

  test('apply refuses on incomplete coverage, and says why', async () => {
    const warnings: string[] = []
    const { deps: d, tornDown } = deps({
      loadProjectRows: async () => ({ rows: new Map<string, ProjectPublishRow>(), complete: false }),
      warn: (m: string) => warnings.push(m),
    })

    const report = await runPublishedSiteSweep(d, { dryRun: false })

    expect(report.blocked).toBe('row-coverage-incomplete')
    expect(report.rowCoverageComplete).toBe(false)
    expect(report.tornDown).toEqual([])
    expect(tornDown).toEqual([])
    expect(warnings.join(' ')).toContain('apply refused')
  })

  test('a dry run still reports the inventory it refused to act on', async () => {
    const { deps: d } = deps({
      loadProjectRows: async () => ({ rows: new Map<string, ProjectPublishRow>(), complete: false }),
    })

    const report = await runPublishedSiteSweep(d, {})

    expect(report.dryRun).toBe(true)
    expect(report.blocked).toBeNull()
    expect(report.skipped.map((s) => s.reason)).toEqual(['row-coverage-incomplete'])
  })
})
