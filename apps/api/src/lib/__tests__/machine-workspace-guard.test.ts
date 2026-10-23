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
