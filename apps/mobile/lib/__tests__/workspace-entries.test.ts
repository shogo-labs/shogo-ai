// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * One workspace list (SHO-108), hosted workspaces included (SHO-285).
 *
 * Every row comes from `GET /workspaces`. A workspace hosted on a paired desktop
 * is the same row with a host badge — same key, same id, same switch path.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildWorkspaceEntries,
  cloudWorkspaceKey,
  currentWorkspaceEntry,
  currentWorkspaceKey,
  hostSubtitle,
  type WorkspaceHostInfo,
} from '../workspace-entries'

const workspaces = [
  { id: 'ws-personal', name: 'Russ Personal', kind: 'personal' },
  { id: 'ws-samsara', name: 'Samsara', kind: 'team', hostInstanceId: 'inst-odin' },
  { id: 'ws-acme', name: 'Acme', kind: 'team', hostInstanceId: null },
]

const hosts: WorkspaceHostInfo[] = [
  { instanceId: 'inst-odin', hostname: "Russell's MacBook", kind: 'desktop', presence: 'online', lastSeenAt: null },
]

describe('buildWorkspaceEntries', () => {
  test('lists every workspace once, in the server order, keyed by its one id', () => {
    const entries = buildWorkspaceEntries({ workspaces, hosts })
    expect(entries.map((entry) => entry.key)).toEqual(['cloud:ws-personal', 'cloud:ws-samsara', 'cloud:ws-acme'])
    expect(entries.map((entry) => entry.id)).toEqual(['ws-personal', 'ws-samsara', 'ws-acme'])
  })

  test('badges a hosted workspace with its desktop and presence', () => {
    const samsara = buildWorkspaceEntries({ workspaces, hosts })[1]
    expect(samsara.host).toEqual({
      kind: 'machine',
      instanceId: 'inst-odin',
      hostname: "Russell's MacBook",
      presence: 'online',
      lastSeenAt: null,
    })
    expect(hostSubtitle(samsara.host)).toBe("Host: Russell's MacBook · online")
  })

  test('shows an offline host, and a placeholder before the machine list answers', () => {
    const offline = buildWorkspaceEntries({
      workspaces,
      hosts: [{ ...hosts[0], presence: 'offline', lastSeenAt: '2026-11-01T00:00:00.000Z' }],
    })[1]
    expect(hostSubtitle(offline.host, Date.parse('2026-11-01T00:04:00.000Z'))).toBe(
      "Host: Russell's MacBook · offline · last seen 4 min ago",
    )
    const unknown = buildWorkspaceEntries({ workspaces })[1]
    expect(unknown.host.kind).toBe('machine')
    expect(unknown.host.kind === 'machine' && unknown.host.presence).toBe('offline')
  })

  test('cloud workspaces carry no badge', () => {
    const entries = buildWorkspaceEntries({ workspaces, hosts })
    expect(entries[0].host).toEqual({ kind: 'cloud' })
    expect(entries[2].host).toEqual({ kind: 'cloud' })
    expect(hostSubtitle(entries[0].host)).toBeNull()
  })

  test('never lists a workspace from the machine itself', () => {
    expect(buildWorkspaceEntries({ workspaces: [], hosts })).toEqual([])
  })
})

describe('currentWorkspaceKey', () => {
  test('checks the selected workspace, hosted or not', () => {
    const entries = buildWorkspaceEntries({ workspaces, hosts })
    expect(currentWorkspaceKey({ entries, currentWorkspaceId: 'ws-samsara' })).toBe(cloudWorkspaceKey('ws-samsara'))
    expect(currentWorkspaceEntry({ entries, currentWorkspaceId: 'ws-samsara' })?.name).toBe('Samsara')
    expect(currentWorkspaceKey({ entries, currentWorkspaceId: 'missing' })).toBeNull()
  })
})
