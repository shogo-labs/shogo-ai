// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Nobody runs a machine copy but its own desktop (SHO-185).
 *
 * `Workspace.machineInstanceId` marks a copy. Two kinds of code have to respect
 * it, and both are checked here:
 *
 *   • **Cloud background work** must not select the copy. A heartbeat, a
 *     schedule, a Composio trigger or a digest email that fires for a copied
 *     workspace runs the user's automation twice — once on the machine that is
 *     meant to run it and once on the cloud that only holds a copy.
 *   • **Cloud writes** must refuse it, so the desktop stays the only writer.
 *
 * The per-worker assertions are deliberately source-level. Each of those jobs
 * selects its rows in a different shape (raw SQL, a nested relation, a
 * `distinct` scan), so a mock of one would prove nothing about the others; what
 * matters is that the file still carries the filter at all. The behavioural
 * version — seed a tagged workspace with a due schedule, a heartbeat and a
 * trigger, tick each worker, assert nothing ran — needs a real Postgres and
 * lives in the CI integration job.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOUD_WORKSPACE_ONLY,
  MACHINE_WORKSPACE_ONLY,
  isMachineWorkspace,
  withCloudWorkspaces,
} from '../machine-workspace.ts'

const API_ROOT = join(import.meta.dir, '..', '..', '..')

function source(relative: string): string {
  return readFileSync(join(API_ROOT, relative), 'utf8')
}

/** One function's body, braces matched — a marker has to be in *this* function. */
function functionBody(relative: string, name: string): string {
  const text = source(relative)
  const signature = text.search(new RegExp(`(?:export )?async function ${name}\\(`))
  if (signature < 0) throw new Error(`${name} is not defined in ${relative}`)
  const open = text.indexOf('{', text.indexOf(')', signature))
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open, i + 1)
  }
  throw new Error(`unbalanced braces after ${name} in ${relative}`)
}

describe('the machine-workspace where fragments', () => {
  test('cloud-only selects null, machine-only selects non-null', () => {
    expect(CLOUD_WORKSPACE_ONLY).toEqual({ machineInstanceId: null })
    expect(MACHINE_WORKSPACE_ONLY).toEqual({ machineInstanceId: { not: null } })
  })

  test('withCloudWorkspaces keeps what the caller narrowed and adds the tag', () => {
    expect(withCloudWorkspaces({ homeRegion: 'us' })).toEqual({
      homeRegion: 'us',
      machineInstanceId: null,
    })
  })

  test('isMachineWorkspace reads the tag, and a missing row is not one', () => {
    expect(isMachineWorkspace({ machineInstanceId: 'inst-1' })).toBe(true)
    expect(isMachineWorkspace({ machineInstanceId: null })).toBe(false)
    expect(isMachineWorkspace({})).toBe(false)
    expect(isMachineWorkspace(null)).toBe(false)
  })
})

describe('every cloud worker that selects workspace-owned rows skips the copy', () => {
  const workers: Array<{ file: string; why: string; marker: RegExp }> = [
    {
      file: 'src/lib/heartbeat-scheduler.ts',
      why: 'a heartbeat on the copy would fire the same agent a second time',
      // The claim is one raw statement; the join to workspaces is where the tag lives.
      marker: /w\."machineInstanceId" IS NULL/,
    },
    {
      file: 'src/jobs/run-agent-schedule-dispatch.ts',
      why: 'a schedule on the copy would run twice and bill the cloud',
      marker: /machineInstanceId: null/,
    },
    {
      file: 'src/services/composio-triggers.service.ts',
      why: 'a trigger on the copy would fire the same automation twice',
      marker: /workspace: \{ machineInstanceId: null \}/,
    },
    {
      file: 'src/services/chat-digest.ts',
      why: 'a digest for the copy would email about messages the cloud never got',
      marker: /machineInstanceId: \{ not: null \}/,
    },
    {
      file: 'src/server.ts',
      why: 'warming the copy would start a runtime for a workspace this pod cannot serve',
      marker: /where: \{ machineInstanceId: null \}/,
    },
    {
      file: 'src/services/conversation-agent-dispatcher.ts',
      why: 'a queued wake in a copy would run the agent on the cloud as well as the desktop',
      marker: /\.\.\.\(await notMachineWorkspaceWhere\(\)\)/,
    },
    {
      file: 'src/services/chat-items.ts',
      why: 'a scheduled message or reminder for the copy would post from the cloud',
      marker: /machineWorkspaceIds\(\)/,
    },
    {
      file: 'src/services/conversation-semantic.ts',
      why: 'indexing a copy would embed messages the cloud never owns',
      marker: /\.\.\.\(await notMachineWorkspaceWhere\(\)\)/,
    },
    {
      file: 'src/services/conversation-file-index.ts',
      why: 'chunking or embedding a copy would write an index the desktop owns',
      marker: /withCloudWorkspaces\(home \?\? \{\}\)/,
    },
    {
      file: 'src/services/chat-queue-dispatcher.service.ts',
      why: 'a queue row for a copy would dispatch the agent on the cloud',
      marker: /cloudSessionIds/,
    },
  ]

  for (const worker of workers) {
    test(`${worker.file} — ${worker.why}`, () => {
      expect(worker.marker.test(source(worker.file))).toBe(true)
    })
  }

  test('Composio covers both of its scans — the fire path and the reconcile', () => {
    const file = source('src/services/composio-triggers.service.ts')
    const cloudOnly = file.match(/machineInstanceId: null/g) ?? []
    expect(cloudOnly.length).toBeGreaterThanOrEqual(2)
  })

  test('both reply-settling sweeps refuse the copy themselves, not just their file', () => {
    // Round 3: the file-level marker was satisfied by the *wake* sweep while
    // these two settled a copy's live run, flipping it to `error` behind the
    // desktop. A marker per function is what the next one needs.
    for (const name of ['settleOrphanedAgentReplies', 'sweepDeadAgentReplies']) {
      expect(functionBody('src/services/conversation-agent-dispatcher.ts', name)).toContain(
        'await notMachineWorkspaceWhere()',
      )
    }
  })
})

/**
 * The workers that need no filter, and why. Each one either never names a
 * workspace row of its own or is handed the id by an event the cloud cannot
 * receive for a copy — so a filter here would be decoration, not protection.
 */
describe('the workers that cannot select a copied row, and why', () => {
  const exempt: Array<{ file: string; why: string; evidence: RegExp }> = [
    {
      file: 'src/lib/analytics-digest-collector.ts',
      why: 'the daily digest runs over platform-wide analytics aggregates, not per-workspace rows, so there is no workspace to filter on',
      evidence: /getUserFunnel|getUserActivityTable/,
    },
    {
      file: 'src/lib/live-session-meter.ts',
      why: 'it meters the workspaceId on a usage event; the runtime that emits those events for a copy is the desktop, so the cloud never receives one',
      evidence: /workspaceId: payload\.workspaceId/,
    },
    {
      file: 'src/lib/voice-meter.ts',
      why: 'same shape as the live-session meter: it is called with a workspace from a voice event, and a copy’s calls are metered on the desktop',
      evidence: /params\.workspaceId/,
    },
    {
      file: 'src/services/published-site-sweep.ts',
      why: 'it reconciles what the publishing substrate reports as deployed, keyed by project id; a copy has no cloud publish row because the write guard refuses to publish one',
      evidence: /loadProjectRows/,
    },
  ]

  for (const entry of exempt) {
    test(`${entry.file} — ${entry.why}`, () => {
      const file = source(entry.file)
      // The reason has to still be true: the file must still start from the
      // input it is supposed to, not a workspace scan we forgot to filter.
      expect(entry.evidence.test(file)).toBe(true)
      expect(/prisma\.workspace\.findMany\(\s*\{\s*where: \{\s*\}\s*\}\)/.test(file)).toBe(false)
    })
  }
})

describe('the write guard is mounted, and stays mounted', () => {
  test('server.ts mounts it on every /api route', () => {
    const server = source('src/server.ts')
    expect(server).toContain("app.use('/api/*', machineWorkspaceWriteGuard())")
    // …before the routes, or a write would reach its handler first.
    const guardAt = server.indexOf("machineWorkspaceWriteGuard())")
    const routesAt = server.indexOf("app.route('/api', ")
    expect(guardAt).toBeGreaterThan(0)
    expect(routesAt).toBeGreaterThan(guardAt)
  })

  test('the ingest and the relay are the only exempt writes', () => {
    const guard = source('src/lib/machine-workspace.ts')
    // `/sync` is how the copy is filled; `/w/` is the live relay itself.
    expect(guard).toContain('/^\\/api\\/machines\\/[^/]+\\/(sync|w\\/)/')
  })
})
