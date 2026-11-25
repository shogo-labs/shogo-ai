// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `RuntimeManager.runningWorkspaceRuntime` (SHO-526).
 *
 * A workspace with an attached project is served by that project's
 * project-anchored runtime (`ws:proj:<anchor>`, SHO-107), not by a `ws:<id>`
 * slot. The tunnel resolver asks this one question synchronously, so it has to
 * answer for both slots — otherwise a workspace that is visibly up reads as
 * "not running" forever and every image in its chat 502s.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

mock.module('child_process', () => ({
  execSync: () => '',
  execFile: () => {},
  execFileSync: () => '',
  exec: () => {},
  spawnSync: () => ({ status: 0, stdout: '', stderr: '', error: null }),
  spawn: mock(() => ({
    stdout: { on: () => {} },
    stderr: { on: () => {} },
    on: () => {},
    kill: () => true,
    killed: false,
    exitCode: null,
  })),
}))

const { RuntimeManager } = await import('../lib/runtime/manager')

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rt',
    port: 4100,
    agentPort: 4100,
    status: 'running',
    url: 'http://localhost:4100',
    startedAt: new Date(),
    lastHealthCheck: null,
    ...overrides,
  }
}

let rm: any

beforeEach(() => {
  rm = new RuntimeManager({ domainSuffix: 'apps.example' })
})

afterEach(() => {
  rm = null
})

describe('runningWorkspaceRuntime', () => {
  test('answers from the ws:<id> slot when that is what is up', () => {
    rm.runtimes.set('ws:ws-1', runtime({ agentPort: 4100 }))

    expect(rm.runningWorkspaceRuntime('ws-1')).toMatchObject({ status: 'running', agentPort: 4100 })
  })

  test('answers from the workspace\u2019s project-anchored slot (SHO-107)', () => {
    rm.runtimeOwners.set('ws:proj:p-1', { workspaceId: 'ws-1', anchorProjectId: 'p-1' })
    rm.runtimes.set('ws:proj:p-1', runtime({ agentPort: 4200 }))

    expect(rm.runningWorkspaceRuntime('ws-1')).toMatchObject({ status: 'running', agentPort: 4200 })
  })

  test('never borrows another workspace\u2019s anchored runtime', () => {
    rm.runtimeOwners.set('ws:proj:p-2', { workspaceId: 'ws-other', anchorProjectId: 'p-2' })
    rm.runtimes.set('ws:proj:p-2', runtime({ agentPort: 4300 }))

    expect(rm.runningWorkspaceRuntime('ws-1')).toBeNull()
  })

  test('a runtime that is starting or has no port does not count as running', () => {
    rm.runtimes.set('ws:ws-1', runtime({ status: 'starting', agentPort: undefined }))
    expect(rm.runningWorkspaceRuntime('ws-1')).toBeNull()

    rm.runtimes.set('ws:ws-2', runtime({ status: 'running', agentPort: undefined }))
    expect(rm.runningWorkspaceRuntime('ws-2')).toBeNull()
  })
})
