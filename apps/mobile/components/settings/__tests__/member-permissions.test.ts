// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  assignableRoles,
  canChangeRole,
  canLeave,
  canManageMembers,
  canRemove,
  getErrorMessage,
} from '../people/member-permissions'

describe('canManageMembers', () => {
  test('owners and admins only', () => {
    expect(canManageMembers('owner')).toBe(true)
    expect(canManageMembers('admin')).toBe(true)
    expect(canManageMembers('member')).toBe(false)
    expect(canManageMembers('viewer')).toBe(false)
    expect(canManageMembers(undefined)).toBe(false)
  })
})

describe('assignableRoles', () => {
  test('only owners can grant the owner role', () => {
    expect(assignableRoles('owner')).toEqual(['owner', 'admin', 'member', 'viewer'])
    expect(assignableRoles('admin')).toEqual(['admin', 'member', 'viewer'])
    expect(assignableRoles('member')).toEqual([])
  })
})

describe('canRemove', () => {
  test('owners and admins can remove regular members', () => {
    expect(canRemove({ viewerRole: 'owner', targetRole: 'member', isSelf: false }).allowed).toBe(true)
    expect(canRemove({ viewerRole: 'admin', targetRole: 'viewer', isSelf: false }).allowed).toBe(true)
  })

  test('members and viewers cannot remove anyone', () => {
    for (const viewerRole of ['member', 'viewer']) {
      const res = canRemove({ viewerRole, targetRole: 'member', isSelf: false })
      expect(res.allowed).toBe(false)
      expect(res.reason).toBeTruthy()
    }
  })

  test('only owners can remove owners', () => {
    expect(canRemove({ viewerRole: 'owner', targetRole: 'owner', isSelf: false }).allowed).toBe(true)
    const res = canRemove({ viewerRole: 'admin', targetRole: 'owner', isSelf: false })
    expect(res.allowed).toBe(false)
    expect(res.reason).toBe('Only owners can remove owners')
  })

  test('removing yourself goes through leave instead', () => {
    expect(canRemove({ viewerRole: 'owner', targetRole: 'owner', isSelf: true }).allowed).toBe(false)
  })
})

describe('canChangeRole', () => {
  test('managers can change other members', () => {
    expect(canChangeRole({ viewerRole: 'admin', targetRole: 'member', isSelf: false }).allowed).toBe(true)
  })

  test('nobody changes their own role, and admins cannot touch owners', () => {
    expect(canChangeRole({ viewerRole: 'owner', targetRole: 'owner', isSelf: true }).allowed).toBe(false)
    expect(canChangeRole({ viewerRole: 'admin', targetRole: 'owner', isSelf: false }).allowed).toBe(false)
  })

  test('members and viewers cannot change roles', () => {
    expect(canChangeRole({ viewerRole: 'member', targetRole: 'viewer', isSelf: false }).allowed).toBe(false)
  })
})

describe('canLeave', () => {
  test('anyone can leave when they have other workspaces', () => {
    expect(canLeave({ viewerRole: 'member', workspaceCount: 2, otherOwnerCount: 0 }).allowed).toBe(true)
    expect(canLeave({ viewerRole: 'owner', workspaceCount: 2, otherOwnerCount: 1 }).allowed).toBe(true)
  })

  test('cannot leave your only workspace', () => {
    const res = canLeave({ viewerRole: 'member', workspaceCount: 1, otherOwnerCount: 1 })
    expect(res.allowed).toBe(false)
    expect(res.reason).toContain('only workspace')
  })

  test('the last owner cannot leave', () => {
    const res = canLeave({ viewerRole: 'owner', workspaceCount: 3, otherOwnerCount: 0 })
    expect(res.allowed).toBe(false)
    expect(res.reason).toContain('last owner')
  })
})

describe('getErrorMessage', () => {
  test('prefers the server error message, then Error.message, then the fallback', () => {
    expect(getErrorMessage({ details: { error: { message: 'Cannot remove the last owner' } } }, 'x')).toBe(
      'Cannot remove the last owner',
    )
    expect(getErrorMessage(new Error('boom'), 'x')).toBe('boom')
    expect(getErrorMessage({}, 'fallback')).toBe('fallback')
  })
})
