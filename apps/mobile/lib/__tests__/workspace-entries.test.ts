// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One workspace list (SHO-108).
 *
 * The switcher has one list of `WorkspaceEntry`, cloud workspaces and a paired
 * computer's own workspaces alike, and exactly one of its rows is the current
 * one — the machine's while its workspace is in view, never the cloud workspace
 * that happens to be selected behind it.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildWorkspaceEntries,
  cloudWorkspaceKey,
  currentWorkspaceEntry,
  currentWorkspaceKey,
  machineInstanceForEntry,
  machineWorkspaceKey,
  type MachineGroupData,
} from '../workspace-entries'

const cloudWorkspaces = [
  { id: 'ws-personal', name: 'Russ Personal', kind: 'personal' },
  { id: 'ws-acme', name: 'Acme', kind: 'team' },
]

const odin: MachineGroupData = {
  id: 'inst-odin',
  name: 'odin',
  status: 'online',
  stale: false,
  lastSeenAt: '2026-10-21T05:00:00.000Z',
  workspaces: [
    { id: 'lw-main', name: 'Samsara', kind: 'team', projectCount: 4 },
    { id: 'lw-home', name: 'Home', kind: 'personal', projectCount: 1 },
  ],
}

const offlineHost: MachineGroupData = {
  id: 'inst-imac',
  name: 'Studio iMac',
  status: 'offline',
  stale: true,
  lastSeenAt: '2026-10-20T18:00:00.000Z',
  workspaces: [{ id: 'lw-archive', name: 'Archive', kind: 'team' }],
}

/**
 * A `shogo worker` VM. The cloud reports it as a device, but it serves
 * `/agent/*` only — no workspaces to open (SHO-120).
 */
const workerVm: MachineGroupData = {
  id: 'inst-vm',
  name: 'Dev VM',
  kind: 'cli_worker',
  status: 'online',
  stale: false,
  lastSeenAt: '2026-10-21T05:00:00.000Z',
  workspaces: [{ id: 'lw-vm', name: 'VM Workspace', kind: 'team' }],
}

describe('buildWorkspaceEntries', () => {
  test('a cli-worker never becomes a workspace host', () => {
    const entries = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [workerVm] })
    expect(entries.map((entry) => entry.key)).toEqual([
      cloudWorkspaceKey('ws-personal'),
      cloudWorkspaceKey('ws-acme'),
    ])
    expect(entries.some((entry) => entry.host.kind === 'machine')).toBe(false)
  })

  test('one list: cloud rows in the server order, then each machine’s rows', () => {
    const entries = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [odin] })

    expect(entries.map((entry) => entry.key)).toEqual([
      cloudWorkspaceKey('ws-personal'),
      cloudWorkspaceKey('ws-acme'),
      machineWorkspaceKey('inst-odin', 'lw-main'),
      machineWorkspaceKey('inst-odin', 'lw-home'),
    ])
    expect(entries.map((entry) => entry.name)).toEqual(['Russ Personal', 'Acme', 'Samsara', 'Home'])
  })

  test('a machine entry carries its host, kind and presence — nothing else differs', () => {
    const entries = buildWorkspaceEntries({ workspaces: [], machines: [odin] })
    const samsara = entries[0]

    expect(samsara.host).toEqual({
      kind: 'machine',
      instanceId: 'inst-odin',
      hostname: 'odin',
      presence: 'online',
      stale: false,
      lastSeenAt: '2026-10-21T05:00:00.000Z',
    })
    // Same fields a cloud row has, and the same id space rules.
    expect(samsara.id).toBe('lw-main')
    expect(samsara.kind).toBe('team')
  })

  test('an offline host keeps its last-known rows, marked stale', () => {
    const entries = buildWorkspaceEntries({ workspaces: [], machines: [offlineHost] })
    expect(entries).toHaveLength(1)
    expect(entries[0].host.kind).toBe('machine')
    if (entries[0].host.kind === 'machine') {
      expect(entries[0].host.presence).toBe('offline')
      expect(entries[0].host.stale).toBe(true)
    }
  })

  test('a machine with nothing to show contributes no rows', () => {
    const entries = buildWorkspaceEntries({
      workspaces: cloudWorkspaces,
      machines: [{ id: 'inst-empty', name: 'new machine', status: 'offline', workspaces: [] }],
    })
    expect(entries).toHaveLength(2)
  })

  test('the order is stable across identical builds (no resort-on-render)', () => {
    const first = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [odin, offlineHost] })
    const second = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [odin, offlineHost] })
    expect(second.map((entry) => entry.key)).toEqual(first.map((entry) => entry.key))
  })

  test('machine ids never collide with cloud ids in the list', () => {
    const entries = buildWorkspaceEntries({
      workspaces: [{ id: 'lw-main', name: 'Impostor', kind: 'team' }],
      machines: [odin],
    })
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
  })
})

describe('currentWorkspaceKey', () => {
  const entries = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [odin] })

  test('the open machine workspace is the checked row', () => {
    const key = currentWorkspaceKey({
      entries,
      currentWorkspaceId: 'ws-acme',
      activeInstance: {
        instanceId: 'inst-odin',
        name: 'odin',
        hostname: 'odin',
        workspaceId: 'ws-acme',
        source: 'machine',
        localWorkspaceId: 'lw-main',
      },
    })
    expect(key).toBe(machineWorkspaceKey('inst-odin', 'lw-main'))
  })

  test('no cloud workspace is checked while the machine’s is in view', () => {
    const key = currentWorkspaceKey({
      entries,
      currentWorkspaceId: 'ws-acme',
      activeInstance: {
        instanceId: 'inst-odin',
        name: 'odin',
        hostname: 'odin',
        workspaceId: 'ws-acme',
        source: 'machine',
        localWorkspaceId: 'lw-main',
      },
    })
    expect(key).not.toBe(cloudWorkspaceKey('ws-acme'))
  })

  test('without a machine, the selected cloud workspace is the checked row', () => {
    expect(
      currentWorkspaceKey({ entries, currentWorkspaceId: 'ws-personal', activeInstance: null }),
    ).toBe(cloudWorkspaceKey('ws-personal'))
  })

  test('a stale machine selection falls back to the cloud workspace', () => {
    const key = currentWorkspaceKey({
      entries,
      currentWorkspaceId: 'ws-acme',
      activeInstance: {
        instanceId: 'inst-gone',
        name: 'gone',
        hostname: 'gone',
        workspaceId: 'ws-acme',
        source: 'machine',
        localWorkspaceId: 'lw-gone',
      },
    })
    expect(key).toBe(cloudWorkspaceKey('ws-acme'))
  })

  test('the entry accessor follows the same row', () => {
    const entry = currentWorkspaceEntry({ entries, currentWorkspaceId: 'ws-acme', activeInstance: null })
    expect(entry?.name).toBe('Acme')
    expect(entry?.host.kind).toBe('cloud')
  })
})

describe('machineInstanceForEntry', () => {
  test('a machine row selects that computer’s own workspace, name and kind', () => {
    const entries = buildWorkspaceEntries({ workspaces: cloudWorkspaces, machines: [odin] })
    const samsara = entries[2]
    expect(machineInstanceForEntry(samsara, 'ws-acme')).toEqual({
      instanceId: 'inst-odin',
      name: 'odin',
      hostname: 'odin',
      workspaceId: 'ws-acme',
      kind: 'desktop',
      source: 'machine',
      localWorkspaceId: 'lw-main',
      localWorkspaceName: 'Samsara',
      localWorkspaceKind: 'team',
    })
  })

  test('a cloud row selects nothing extra', () => {
    const entries = buildWorkspaceEntries({ workspaces: cloudWorkspaces })
    expect(machineInstanceForEntry(entries[0], 'ws-personal')).toBeNull()
  })
})
