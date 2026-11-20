// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Who may invite to a workspace (SHO-454).
 *
 * The matrix is the card's acceptance criterion 6: owners and admins are
 * unchanged under both policies; an Editor invites as Editor or Viewer while
 * the policy is `members` and not at all while it is `admins`; a Viewer never
 * invites. Unknown stored values fall back to the permissive default.
 */
import { describe, expect, test } from 'bun:test'
import { ALL_PERMISSIONS, resolveAccess, type WorkspaceRole } from '@shogo/authz'
import { canGrantWorkspaceRole, canInviteToWorkspace, normalizeInvitePolicy } from '../workspace-invite-policy'
import type { AccessContext } from '../authz/access'

function accessFor(workspaceRole: WorkspaceRole): AccessContext {
  const effective = resolveAccess({ workspaceRole })
  return {
    ...effective,
    workspaceId: 'ws_1',
    projectId: null,
    exists: true,
    visibility: null,
    legacyAllowed: true,
  }
}

const owner = accessFor('owner')
const admin = accessFor('admin')
const editor = accessFor('member')
const viewer = accessFor('viewer')

const membersPolicy = { invitePolicy: 'members' }
const adminsPolicy = { invitePolicy: 'admins' }
const unsetPolicy = { invitePolicy: null }

describe('normalizeInvitePolicy', () => {
  test('only "admins" restricts; null and unknown values are the permissive default', () => {
    expect(normalizeInvitePolicy('admins')).toBe('admins')
    expect(normalizeInvitePolicy('members')).toBe('members')
    expect(normalizeInvitePolicy(null)).toBe('members')
    expect(normalizeInvitePolicy(undefined)).toBe('members')
    expect(normalizeInvitePolicy('nonsense')).toBe('members')
  })
})

describe('canInviteToWorkspace — owners and admins are unchanged', () => {
  for (const [name, access] of [
    ['owner', owner],
    ['admin', admin],
  ] as const) {
    for (const policy of [unsetPolicy, membersPolicy, adminsPolicy]) {
      test(`${name} may invite under ${policy.invitePolicy ?? 'unset'}`, () => {
        expect(canInviteToWorkspace(access, policy)).toBe(true)
        expect(canInviteToWorkspace(access, policy, 'member')).toBe(true)
        expect(canInviteToWorkspace(access, policy, 'viewer')).toBe(true)
      })
    }
  }

  test('an admin may not hand out owner, and an owner may', () => {
    expect(canInviteToWorkspace(admin, membersPolicy, 'owner')).toBe(false)
    expect(canInviteToWorkspace(owner, membersPolicy, 'owner')).toBe(true)
  })

  test('an admin may invite as admin', () => {
    expect(canInviteToWorkspace(admin, membersPolicy, 'admin')).toBe(true)
  })
})

describe('canInviteToWorkspace — an Editor', () => {
  test('may invite while the policy is unset or "members"', () => {
    expect(canInviteToWorkspace(editor, unsetPolicy)).toBe(true)
    expect(canInviteToWorkspace(editor, membersPolicy)).toBe(true)
  })

  test('may grant Editor or Viewer only', () => {
    expect(canInviteToWorkspace(editor, membersPolicy, 'member')).toBe(true)
    expect(canInviteToWorkspace(editor, membersPolicy, 'viewer')).toBe(true)
    expect(canInviteToWorkspace(editor, membersPolicy, 'admin')).toBe(false)
    expect(canInviteToWorkspace(editor, membersPolicy, 'owner')).toBe(false)
  })

  test('may not invite at all while the policy is "admins"', () => {
    expect(canInviteToWorkspace(editor, adminsPolicy)).toBe(false)
    expect(canInviteToWorkspace(editor, adminsPolicy, 'member')).toBe(false)
    expect(canInviteToWorkspace(editor, adminsPolicy, 'viewer')).toBe(false)
  })
})

describe('canInviteToWorkspace — a Viewer', () => {
  test('never invites, under either policy', () => {
    for (const policy of [unsetPolicy, membersPolicy, adminsPolicy]) {
      expect(canInviteToWorkspace(viewer, policy)).toBe(false)
      expect(canInviteToWorkspace(viewer, policy, 'member')).toBe(false)
      expect(canInviteToWorkspace(viewer, policy, 'viewer')).toBe(false)
    }
  })
})

describe('canInviteToWorkspace — bad input', () => {
  test('an unknown role is refused for everyone', () => {
    expect(canInviteToWorkspace(owner, membersPolicy, 'superuser')).toBe(false)
    expect(canInviteToWorkspace(editor, membersPolicy, 'superuser')).toBe(false)
  })

  test('a missing workspace row falls back to the permissive default', () => {
    expect(canInviteToWorkspace(editor, null)).toBe(true)
    expect(canInviteToWorkspace(editor, undefined, 'member')).toBe(true)
  })
})

describe('canGrantWorkspaceRole — a manager with no workspace role', () => {
  // A tunnel request from the desktop: the cloud proxy already authorized the
  // caller, so `computeAccess` hands it every permission but leaves
  // `workspaceRole` null. Comparing against a null role refused every role,
  // which is why creating a link or an invitation 403'd on desktop.
  const tunnel: AccessContext = {
    ...resolveAccess({}),
    permissions: new Set(ALL_PERMISSIONS),
    workspaceRole: null,
    workspaceId: 'ws_1',
    projectId: null,
    exists: true,
    visibility: null,
    legacyAllowed: true,
  }

  test('may grant Editor, Viewer and Admin', () => {
    for (const role of ['admin', 'member', 'viewer']) {
      expect(canGrantWorkspaceRole(tunnel, role)).toBe(true)
      expect(canInviteToWorkspace(tunnel, membersPolicy, role)).toBe(true)
    }
  })

  test('may not mint an owner — that rule is unchanged', () => {
    expect(canGrantWorkspaceRole(tunnel, 'owner')).toBe(false)
    expect(canInviteToWorkspace(tunnel, membersPolicy, 'owner')).toBe(false)
  })

  test('an unknown role is still refused', () => {
    expect(canGrantWorkspaceRole(tunnel, 'superuser')).toBe(false)
  })

  test('a caller with a real role still hits the no-escalation ceiling', () => {
    expect(canGrantWorkspaceRole(admin, 'admin')).toBe(true)
    expect(canGrantWorkspaceRole(admin, 'owner')).toBe(false)
    expect(canGrantWorkspaceRole(editor, 'admin')).toBe(false)
    expect(canGrantWorkspaceRole(viewer, 'viewer')).toBe(false)
  })
})
