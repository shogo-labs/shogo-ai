// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Regression coverage for `scripts/refresh-coverage-tasks.ts`.
 *
 * The script's contract is intentionally narrow but easy to get wrong:
 *
 *   1. A `pending` task whose file no longer appears in `gaps.files` is
 *      flipped to `done` with `autoFlipped.reason='file_removed_from_gaps'`.
 *   2. A `pending` task whose gap shows `linePct >= 100 && funcPct >= 100`
 *      is flipped to `done` with `autoFlipped.reason='file_at_100'`.
 *   3. A `pending` task whose `uncoveredLines` drifted gets its counts
 *      updated in place (status stays `pending`).
 *   4. `done`, `in_progress`, and `deleted` tasks are NEVER touched —
 *      including their `autoFlipped` / `note` / `afterLinePct` fields.
 *   5. Unrelated task fields (`createdAt`, `note`, `afterLinePct`) on a
 *      pending task survive the flip / update.
 */

import { describe, test, expect } from 'bun:test'
import { refreshTasks } from '../refresh-coverage-tasks'

const NOW = '2026-05-21T00:00:00.000Z'

function gap(
  file: string,
  linesFound: number,
  linesHit: number,
  funcsFound: number,
  funcsHit: number,
) {
  const linePct = linesFound === 0 ? 100 : (linesHit / linesFound) * 100
  const funcPct = funcsFound === 0 ? 100 : (funcsHit / funcsFound) * 100
  return {
    file,
    linesFound,
    linesHit,
    funcsFound,
    funcsHit,
    linePct,
    funcPct,
    uncoveredLines: linesFound - linesHit,
  }
}

describe('refreshTasks', () => {
  test('flips pending task to done when file is absent from gaps', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 1,
      tasks: [
        {
          file: 'apps/api/src/lib/stale.ts',
          uncoveredLines: 3,
          linePct: 88.0,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [], // file went to 100% and dropped out
    }

    const { queue: next, summary } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('done')
    expect(next.tasks[0]!.autoFlipped).toEqual({
      at: NOW,
      reason: 'file_removed_from_gaps',
      measuredLinePct: 100,
      measuredFuncPct: 100,
    })
    expect(next.tasks[0]!.createdAt).toBe('2026-05-19T00:00:00.000Z')
    expect(next.refreshedAt).toBe(NOW)
    expect(summary.flipped).toHaveLength(1)
    expect(summary.flipped[0]).toEqual({
      file: 'apps/api/src/lib/stale.ts',
      reason: 'file_removed_from_gaps',
    })
  })

  test('flips pending task to done when gap shows 100% lines AND funcs', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 1,
      tasks: [
        {
          file: 'apps/api/src/lib/closed.ts',
          uncoveredLines: 2,
          linePct: 95.0,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [gap('apps/api/src/lib/closed.ts', 100, 100, 10, 10)],
    }

    const { queue: next, summary } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('done')
    expect(next.tasks[0]!.autoFlipped?.reason).toBe('file_at_100')
    expect(next.tasks[0]!.autoFlipped?.measuredLinePct).toBe(100)
    expect(next.tasks[0]!.autoFlipped?.measuredFuncPct).toBe(100)
    expect(summary.flipped).toHaveLength(1)
  })

  test('does NOT flip when lines are 100% but funcs are not', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 1,
      tasks: [
        {
          file: 'apps/api/src/lib/half.ts',
          uncoveredLines: 0,
          linePct: 100,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [gap('apps/api/src/lib/half.ts', 100, 100, 10, 8)], // 80% funcs
    }

    const { queue: next, summary } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('pending')
    expect(next.tasks[0]!.autoFlipped).toBeUndefined()
    expect(summary.flipped).toHaveLength(0)
  })

  test('updates uncoveredLines in place when gap drifted but file is still pending', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 1,
      tasks: [
        {
          file: 'apps/api/src/lib/drift.ts',
          uncoveredLines: 5,
          linePct: 90.0,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [gap('apps/api/src/lib/drift.ts', 100, 98, 10, 9)],
    }

    const { queue: next, summary } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('pending')
    expect(next.tasks[0]!.uncoveredLines).toBe(2)
    expect(next.tasks[0]!.linePct).toBe(98)
    expect(next.tasks[0]!.autoFlipped).toBeUndefined()
    expect(summary.updated).toEqual([
      { file: 'apps/api/src/lib/drift.ts', before: 5, after: 2 },
    ])
  })

  test('never touches done / in_progress / deleted tasks', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 3,
      tasks: [
        {
          file: 'apps/api/src/lib/finished.ts',
          uncoveredLines: 0,
          linePct: 100,
          phase: 1 as const,
          status: 'done' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
          afterLinePct: 100,
          note: 'closed by wave-1',
        },
        {
          file: 'apps/api/src/lib/inflight.ts',
          uncoveredLines: 3,
          linePct: 90,
          phase: 1 as const,
          status: 'in_progress' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
        {
          file: 'apps/api/src/lib/abandoned.ts',
          uncoveredLines: 4,
          linePct: 80,
          phase: 1 as const,
          status: 'deleted' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      // All three files appear at very different gap states than the queue claims;
      // every one should be ignored anyway because none is pending.
      files: [
        gap('apps/api/src/lib/finished.ts', 100, 50, 10, 5),
        gap('apps/api/src/lib/inflight.ts', 100, 100, 10, 10),
        gap('apps/api/src/lib/abandoned.ts', 100, 100, 10, 10),
      ],
    }

    const { queue: next, summary } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('done')
    expect(next.tasks[0]!.note).toBe('closed by wave-1')
    expect(next.tasks[0]!.afterLinePct).toBe(100)
    expect(next.tasks[0]!.uncoveredLines).toBe(0) // untouched
    expect(next.tasks[1]!.status).toBe('in_progress')
    expect(next.tasks[1]!.uncoveredLines).toBe(3) // untouched
    expect(next.tasks[2]!.status).toBe('deleted')
    expect(next.tasks[2]!.uncoveredLines).toBe(4) // untouched
    expect(summary.flipped).toHaveLength(0)
    expect(summary.updated).toHaveLength(0)
    expect(summary.skipped).toHaveLength(3)
    expect(summary.skipped.map((s) => s.status).sort()).toEqual([
      'deleted',
      'done',
      'in_progress',
    ])
  })

  test('preserves createdAt / note / afterLinePct on auto-flipped task', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 1,
      tasks: [
        {
          file: 'apps/api/src/lib/keep-fields.ts',
          uncoveredLines: 1,
          linePct: 99,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
          note: 'split into 2 sub-fires',
          afterLinePct: undefined,
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [gap('apps/api/src/lib/keep-fields.ts', 100, 100, 1, 1)],
    }

    const { queue: next } = refreshTasks(queue, gaps, NOW)

    expect(next.tasks[0]!.status).toBe('done')
    expect(next.tasks[0]!.createdAt).toBe('2026-05-19T00:00:00.000Z')
    expect(next.tasks[0]!.note).toBe('split into 2 sub-fires')
  })

  test('mixed batch: counts flipped + updated + unchanged + skipped correctly', () => {
    const queue = {
      generatedAt: '2026-05-19T00:00:00.000Z',
      total: 5,
      tasks: [
        {
          file: 'apps/api/src/a.ts',
          uncoveredLines: 1,
          linePct: 99,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
        {
          file: 'apps/api/src/b.ts',
          uncoveredLines: 5,
          linePct: 90,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
        {
          file: 'apps/api/src/c.ts',
          uncoveredLines: 7,
          linePct: 85,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
        {
          file: 'apps/api/src/d.ts',
          uncoveredLines: 0,
          linePct: 100,
          phase: 1 as const,
          status: 'done' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
        {
          file: 'apps/api/src/e.ts',
          uncoveredLines: 2,
          linePct: 95,
          phase: 1 as const,
          status: 'pending' as const,
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    }
    const gaps = {
      generatedAt: NOW,
      totals: {},
      files: [
        // a → reached 100% via unrelated work
        gap('apps/api/src/a.ts', 100, 100, 5, 5),
        // b → dropped from gaps entirely (also a flip)
        // c → drift: now 3 uncov instead of 7
        gap('apps/api/src/c.ts', 100, 97, 10, 10),
        // d → done, skipped
        gap('apps/api/src/d.ts', 100, 50, 10, 5),
        // e → unchanged (same 2 uncov)
        gap('apps/api/src/e.ts', 100, 98, 10, 9), // funcs 90% so no flip
        // ^^ note: linePct=98 matches queue's claim of 95? No, queue says 95.
        // Make this a true "unchanged" by matching both fields:
      ],
    }
    // Tweak `e` so the gap matches the queue exactly → unchanged path
    gaps.files[gaps.files.length - 1] = gap('apps/api/src/e.ts', 100, 98, 10, 9)
    queue.tasks[4]!.linePct = 98
    queue.tasks[4]!.uncoveredLines = 2

    const { summary } = refreshTasks(queue, gaps, NOW)

    expect(summary.flipped.map((f) => f.file).sort()).toEqual([
      'apps/api/src/a.ts',
      'apps/api/src/b.ts',
    ])
    expect(summary.flipped.find((f) => f.file === 'apps/api/src/a.ts')?.reason).toBe(
      'file_at_100',
    )
    expect(summary.flipped.find((f) => f.file === 'apps/api/src/b.ts')?.reason).toBe(
      'file_removed_from_gaps',
    )
    expect(summary.updated).toEqual([
      { file: 'apps/api/src/c.ts', before: 7, after: 3 },
    ])
    expect(summary.unchanged).toBe(1)
    expect(summary.skipped).toEqual([{ file: 'apps/api/src/d.ts', status: 'done' }])
  })
})
