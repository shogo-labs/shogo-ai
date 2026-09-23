// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { pickTeamWorkspace } from '../team-workspace'

const workspaces = [
  { id: 'ws-personal', kind: 'personal' },
  { id: 'ws-invited', kind: 'team' },
  { id: 'ws-own', kind: 'team' },
]

describe('pickTeamWorkspace', () => {
  test('prefers the team workspace the user owns', () => {
    const memberships = [
      { workspaceId: 'ws-invited', userId: 'u-1', role: 'member' },
      { workspaceId: 'ws-own', userId: 'u-1', role: 'owner' },
    ]
    expect(pickTeamWorkspace(workspaces, memberships, 'u-1')?.id).toBe('ws-own')
  })

  test("ignores other users' owner rows", () => {
    const memberships = [{ workspaceId: 'ws-own', userId: 'u-2', role: 'owner' }]
    expect(pickTeamWorkspace(workspaces, memberships, 'u-1')?.id).toBe('ws-invited')
  })

  test('falls back to the first non-personal workspace', () => {
    expect(pickTeamWorkspace(workspaces, [], 'u-1')?.id).toBe('ws-invited')
  })

  test('returns undefined when there is no team workspace', () => {
    expect(pickTeamWorkspace([{ id: 'ws-personal', kind: 'personal' }], [], 'u-1')).toBeUndefined()
  })
})
