// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Invite links and invitation resend (SHO-454).
 *
 * Two things the dialog depends on: a link's lifetime is exactly what the
 * caller asked for (7 days by default, 30 on request, never on `null`, and a
 * 400 for anything else), and only the right people can resend an invitation.
 */
import { describe, expect, test } from 'bun:test'
import { resolveAccess, type WorkspaceRole } from '@shogo/authz'
import { createLinkBody, linkExpiresAt } from '../invite-links'
import { canResendInvitation } from '../invitation-resend'
import type { AccessContext } from '../../lib/authz'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-20T00:00:00.000Z')

function accessFor(workspaceRole: WorkspaceRole): AccessContext {
  return {
    ...resolveAccess({ workspaceRole }),
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

describe('linkExpiresAt', () => {
  test('defaults to seven days', () => {
    expect(linkExpiresAt(undefined, NOW)?.toISOString()).toBe(new Date(NOW + 7 * DAY).toISOString())
  })

  test('honours thirty days', () => {
    expect(linkExpiresAt(30, NOW)?.toISOString()).toBe(new Date(NOW + 30 * DAY).toISOString())
  })

  test('null means a link that never expires', () => {
    expect(linkExpiresAt(null, NOW)).toBeNull()
  })
})

describe('createLinkBody', () => {
  test('accepts 7, 30, null and an omitted lifetime', () => {
    for (const expiresInDays of [7, 30, null, undefined]) {
      const parsed = createLinkBody.safeParse({ workspaceId: 'ws_1', expiresInDays })
      expect(parsed.success).toBe(true)
    }
  })

  test('rejects any other lifetime instead of silently changing it', () => {
    for (const expiresInDays of [0, 1, 5, 90, -7]) {
      expect(createLinkBody.safeParse({ workspaceId: 'ws_1', expiresInDays }).success).toBe(false)
    }
  })

  test('still requires a project or a workspace', () => {
    expect(createLinkBody.safeParse({ expiresInDays: 7 }).success).toBe(false)
  })
})

describe('canResendInvitation — workspace invitations', () => {
  const invitation = { projectId: null, invitedBy: 'user_editor', role: 'member' }

  test('a manager may resend anyone’s invitation', () => {
    for (const access of [owner, admin]) {
      expect(
        canResendInvitation({ access, userId: 'someone_else', invitation, workspace: { invitePolicy: 'admins' } }),
      ).toBe(true)
    }
  })

  test('an Editor may resend their own invitation while the policy allows it', () => {
    expect(
      canResendInvitation({ access: editor, userId: 'user_editor', invitation, workspace: { invitePolicy: null } }),
    ).toBe(true)
  })

  test('an Editor may not resend once the policy is admins-only', () => {
    expect(
      canResendInvitation({ access: editor, userId: 'user_editor', invitation, workspace: { invitePolicy: 'admins' } }),
    ).toBe(false)
  })

  test('an Editor may not resend someone else’s invitation', () => {
    expect(
      canResendInvitation({ access: editor, userId: 'user_editor', invitation: { ...invitation, invitedBy: 'other' }, workspace: { invitePolicy: null } }),
    ).toBe(false)
  })

  test('an Editor may not resend an invitation that grants admin', () => {
    expect(
      canResendInvitation({
        access: editor,
        userId: 'user_editor',
        invitation: { ...invitation, role: 'admin' },
        workspace: { invitePolicy: null },
      }),
    ).toBe(false)
  })

  test('a Viewer may never resend, even their own', () => {
    expect(
      canResendInvitation({ access: viewer, userId: 'user_editor', invitation, workspace: { invitePolicy: null } }),
    ).toBe(false)
  })
})

describe('canResendInvitation — project invitations', () => {
  const invitation = { projectId: 'proj_1', invitedBy: 'user_editor', role: 'member' }
  const onProject = (workspaceRole: WorkspaceRole): AccessContext => ({
    ...resolveAccess({ workspaceRole, project: { visibility: 'workspace' } }),
    workspaceId: 'ws_1',
    projectId: 'proj_1',
    exists: true,
    visibility: 'workspace',
    legacyAllowed: true,
  })

  test('needs project.members:manage, not the workspace invite policy', () => {
    expect(canResendInvitation({ access: onProject('owner'), userId: 'x', invitation, workspace: null })).toBe(true)
    expect(canResendInvitation({ access: onProject('admin'), userId: 'x', invitation, workspace: null })).toBe(true)
    expect(
      canResendInvitation({ access: onProject('member'), userId: 'user_editor', invitation, workspace: null }),
    ).toBe(false)
    expect(
      canResendInvitation({ access: onProject('viewer'), userId: 'user_editor', invitation, workspace: null }),
    ).toBe(false)
  })
})
