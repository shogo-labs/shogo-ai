// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-120 QA acceptance — the app never shows a `shogo worker` VM as a workspace
 * host, whichever spelling the cloud uses.
 *
 * Two endpoints describe the same VM and they spell its kind differently:
 *
 *   `GET /api/machines`  emits the Prisma enum  → `cli_worker`
 *   `GET /api/instances` emits the wire form    → `cli-worker` (`formatInstanceKind`)
 *
 * The dev's tests each feed one spelling to one function: `workspace-entries`
 * gets `cli_worker`, `computeRemoteProxyBaseUrl` gets `cli-worker`. Nothing
 * proved the pair holds for a row that came from the other endpoint, which is
 * exactly how fix C would rot — one normalisation quietly dropped and the VM
 * reappears as a workspace host in the switcher, or, worse, gets a
 * `remoteProxyBaseUrl` and 502s every data call again.
 *
 *   bun test ./apps/mobile/lib/__tests__/qa-cli-worker-not-a-host.acceptance.test.ts
 */

import { describe, test, expect } from 'bun:test'
import { computeRemoteProxyBaseUrl } from '@shogo/shared-app/hooks'
import {
  buildWorkspaceEntries,
  isExecutionOnlyMachine,
  machineInstanceForEntry,
  type MachineGroupData,
} from '../workspace-entries'

const RELAY = 'https://studio.shogo.ai/api/machines/i-mac/w/lw-9'

/** A paired desktop, as `/api/machines` reports it. */
const desktop: MachineGroupData = {
  id: 'i-mac',
  name: "Russell's Mac",
  kind: 'desktop',
  status: 'online',
  stale: false,
  lastSeenAt: '2026-10-21T05:00:00.000Z',
  workspaces: [{ id: 'lw-9', name: 'Personal', kind: 'personal' }],
}

/** The same VM as `/api/machines` would emit it — enum spelling. */
const vmFromMachines: MachineGroupData = {
  id: 'i-vm',
  name: 'Dev VM',
  kind: 'cli_worker',
  status: 'online',
  stale: false,
  lastSeenAt: '2026-10-21T05:00:00.000Z',
  workspaces: [{ id: 'lw-vm', name: 'VM Workspace', kind: 'team' }],
}

/** …and with the `/instances` spelling, for a caller that mixed the two up. */
const vmFromInstances: MachineGroupData = { ...vmFromMachines, kind: 'cli-worker' }

const cloud = [{ id: 'ws-personal', name: 'Personal', kind: 'personal' }]
const base = {
  instanceId: 'i-mac',
  name: "Russell's Mac",
  hostname: "Russell's Mac",
  workspaceId: 'ws-personal',
  kind: 'desktop' as const,
  source: 'machine' as const,
  localWorkspaceId: 'lw-9',
  localWorkspaceName: 'Personal',
}

describe('SHO-120 — a shogo worker is a runtime, never a workspace host', () => {
  test('neither spelling of a cli-worker contributes a switcher row', () => {
    const entries = buildWorkspaceEntries({
      workspaces: cloud,
      machines: [desktop, vmFromMachines, vmFromInstances],
    })
    expect(entries.map((e) => e.key)).toEqual(['cloud:ws-personal', 'machine:i-mac:lw-9'])
    // The VM's own workspace must not appear under any key or name.
    expect(entries.some((e) => e.id === 'lw-vm')).toBe(false)
    expect(entries.some((e) => e.name === 'VM Workspace')).toBe(false)
    expect(entries.filter((e) => e.host.kind === 'machine')).toHaveLength(1)
  })

  test('the desktop keeps its relay and the VM never gets one', () => {
    const entries = buildWorkspaceEntries({ workspaces: cloud, machines: [desktop] })
    const machineEntry = entries.find((e) => e.host.kind === 'machine')!
    const desktopInstance = machineInstanceForEntry(machineEntry, 'ws-personal')!

    // Positive control: a real computer tunnels — without this the test could
    // pass by returning null for everything.
    expect(desktopInstance.kind).toBe('desktop')
    expect(computeRemoteProxyBaseUrl(desktopInstance, RELAY)).toBe(RELAY)

    // A stale selection that still points at the VM (the pre-fix persisted
    // context, `source: 'machine'`) must be refused before the machine branch.
    expect(
      computeRemoteProxyBaseUrl({ ...base, instanceId: 'i-vm', kind: 'cli-worker', localWorkspaceId: 'lw-vm' }, RELAY),
    ).toBeNull()
    // …and so must the VM chosen as a project runtime, which is the path that
    // legitimately reaches it (`/api/instances/:id/p`, not the machine relay).
    expect(
      computeRemoteProxyBaseUrl(
        { ...base, instanceId: 'i-vm', kind: 'cli-worker', source: undefined },
        'https://studio.shogo.ai/api/instances/i-vm/p',
      ),
    ).toBeNull()
  })

  test('isExecutionOnlyMachine understands both wire spellings and nothing else', () => {
    expect(isExecutionOnlyMachine({ kind: 'cli_worker' })).toBe(true)
    expect(isExecutionOnlyMachine({ kind: 'cli-worker' })).toBe(true)
    expect(isExecutionOnlyMachine({ kind: 'CLI_WORKER' })).toBe(true)
    expect(isExecutionOnlyMachine({ kind: 'desktop' })).toBe(false)
    expect(isExecutionOnlyMachine({ kind: undefined })).toBe(false)
    expect(isExecutionOnlyMachine(null)).toBe(false)
  })
})
