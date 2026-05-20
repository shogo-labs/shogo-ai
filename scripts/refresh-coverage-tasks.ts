// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Refresh `coverage/coverage-tasks.json` against a freshly-regenerated
 * `coverage/baselines/apps-api.gaps.json`.
 *
 * The seeder (`scripts/seed-coverage-tasks.ts`) is one-shot — it writes
 * the queue once and refuses to overwrite without `--force`. That works
 * for the initial baseline, but as the queue gets worked off the underlying
 * gaps drift in two ways:
 *
 *   1. Files reach 100% via unrelated work (refactors, other tests, etc.)
 *      while their queue entry remains `pending`. Picking such a task
 *      becomes a no-op fire — wasted commit, wasted review, wasted CI run.
 *   2. The `uncoveredLines` count on a `pending` entry no longer matches
 *      the actual gap (existing tests closed some lines but not all), so
 *      the queue's "smallest first" ordering becomes misleading.
 *
 * Empirical data from the apps/api Phase-1 sweep: 3 of the first 9 tasks
 * picked were already at 100% on the branch — a 33% no-op rate that
 * directly inflates commit volume on the coverage push.
 *
 * This script is the recurring counterpart to the seeder: it reads the
 * current queue + a fresh gaps.json, and for each `pending` task:
 *
 *   • If the file is absent from `gaps.files` (everything covered) OR
 *     its `linePct >= 100` AND `funcPct >= 100`, the task is flipped to
 *     `status: 'done'` with a structured `autoFlipped` audit record.
 *   • Otherwise its `uncoveredLines` / `linePct` are updated in place
 *     so the queue ordering stays accurate.
 *
 * `done` and `deleted` tasks are never touched. The output is written
 * back to the same path with `refreshedAt` bumped; everything else
 * (including `createdAt` on individual tasks) is preserved.
 *
 * Run:
 *
 *     bun run scripts/refresh-coverage-tasks.ts            # dry run
 *     bun run scripts/refresh-coverage-tasks.ts --write    # commit changes
 *
 * Exit code is always 0 unless inputs are missing or malformed — a
 * "nothing changed" run is a valid outcome (e.g. when run twice in a
 * row).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

interface GapEntry {
  file: string
  linesFound: number
  linesHit: number
  funcsFound: number
  funcsHit: number
  linePct: number
  funcPct: number
  uncoveredLines: number
}

interface GapsDoc {
  generatedAt: string
  source?: string
  totals: unknown
  files: GapEntry[]
}

interface QueueTask {
  file: string
  uncoveredLines: number
  linePct: number
  phase: 1 | 2 | 3
  status: 'pending' | 'in_progress' | 'done' | 'deleted'
  createdAt: string
  // Set by this script when a task is auto-flipped to `done` because the
  // underlying file already reached 100% via unrelated work. Distinguishes
  // a real coverage push commit from a queue-bookkeeping flip.
  autoFlipped?: {
    at: string
    reason: 'file_at_100' | 'file_removed_from_gaps'
    measuredLinePct: number
    measuredFuncPct: number
  }
  // Free-form note set by the queue worker on a real fire.
  note?: string
  afterLinePct?: number
}

interface QueueDoc {
  generatedAt: string
  refreshedAt?: string
  total: number
  tasks: QueueTask[]
}

interface RefreshSummary {
  flipped: { file: string; reason: 'file_at_100' | 'file_removed_from_gaps' }[]
  updated: { file: string; before: number; after: number }[]
  unchanged: number
  skipped: { file: string; status: string }[]
}

export function refreshTasks(
  queue: QueueDoc,
  gaps: GapsDoc,
  now: string = new Date().toISOString(),
): { queue: QueueDoc; summary: RefreshSummary } {
  const gapByFile = new Map<string, GapEntry>()
  for (const g of gaps.files) gapByFile.set(g.file, g)

  const summary: RefreshSummary = {
    flipped: [],
    updated: [],
    unchanged: 0,
    skipped: [],
  }

  const nextTasks = queue.tasks.map((task) => {
    if (task.status !== 'pending') {
      summary.skipped.push({ file: task.file, status: task.status })
      return task
    }

    const gap = gapByFile.get(task.file)

    if (!gap) {
      summary.flipped.push({ file: task.file, reason: 'file_removed_from_gaps' })
      return {
        ...task,
        status: 'done' as const,
        autoFlipped: {
          at: now,
          reason: 'file_removed_from_gaps' as const,
          measuredLinePct: 100,
          measuredFuncPct: 100,
        },
      }
    }

    if (gap.linePct >= 100 && gap.funcPct >= 100) {
      summary.flipped.push({ file: task.file, reason: 'file_at_100' })
      return {
        ...task,
        status: 'done' as const,
        autoFlipped: {
          at: now,
          reason: 'file_at_100' as const,
          measuredLinePct: gap.linePct,
          measuredFuncPct: gap.funcPct,
        },
      }
    }

    if (gap.uncoveredLines !== task.uncoveredLines || gap.linePct !== task.linePct) {
      summary.updated.push({
        file: task.file,
        before: task.uncoveredLines,
        after: gap.uncoveredLines,
      })
      return {
        ...task,
        uncoveredLines: gap.uncoveredLines,
        linePct: gap.linePct,
      }
    }

    summary.unchanged++
    return task
  })

  return {
    queue: {
      ...queue,
      refreshedAt: now,
      total: nextTasks.length,
      tasks: nextTasks,
    },
    summary,
  }
}

function formatSummary(s: RefreshSummary): string {
  const lines: string[] = []
  lines.push(`[refresh] auto-flipped to done: ${s.flipped.length}`)
  for (const f of s.flipped) lines.push(`  ✓ ${f.file}  (${f.reason})`)
  lines.push(`[refresh] uncoveredLines updated: ${s.updated.length}`)
  for (const u of s.updated)
    lines.push(`  ~ ${u.file}  ${u.before} → ${u.after}`)
  lines.push(`[refresh] unchanged: ${s.unchanged}`)
  lines.push(`[refresh] skipped (non-pending): ${s.skipped.length}`)
  return lines.join('\n')
}

function main() {
  const root = resolve(import.meta.dir, '..')
  const queuePath = resolve(root, 'coverage/coverage-tasks.json')
  const gapsPath = resolve(root, 'coverage/baselines/apps-api.gaps.json')
  const write = process.argv.includes('--write')

  if (!existsSync(queuePath)) {
    console.error(`[refresh] missing ${queuePath} — run seed-coverage-tasks first`)
    process.exit(1)
  }
  if (!existsSync(gapsPath)) {
    console.error(`[refresh] missing ${gapsPath} — regenerate via coverage-gap-report`)
    process.exit(1)
  }

  const queue = JSON.parse(readFileSync(queuePath, 'utf8')) as QueueDoc
  const gaps = JSON.parse(readFileSync(gapsPath, 'utf8')) as GapsDoc

  const { queue: nextQueue, summary } = refreshTasks(queue, gaps)

  console.log(formatSummary(summary))

  if (!write) {
    console.log('\n[refresh] dry run (pass --write to apply)')
    return
  }

  writeFileSync(queuePath, JSON.stringify(nextQueue, null, 2) + '\n')
  console.log(`\n[refresh] wrote ${queuePath}`)
}

if (import.meta.main) main()
