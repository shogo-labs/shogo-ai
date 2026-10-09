// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hand-written access matrix. Expected sets are spelled out literally and
 * never derived from the role maps, so a wrong map fails here instead of
 * being copied into the expectation.
 */

import { describe, expect, test } from 'bun:test'
import {
  ALL_PERMISSIONS,
  canAssignProjectRole,
  canAssignWorkspaceRole,
  permissionList,
  resolveAccess,
  toProjectRole,
  type AccessFacts,
  type Permission,
} from '../index'

const WS_OWNER: Permission[] = [
  'workspace:read', 'workspace:update', 'workspace:delete', 'workspace.members:read',
  'workspace.members:manage', 'workspace.owners:manage', 'workspace.billing:manage',
  'workspace.settings:manage', 'workspace.api_keys:manage', 'workspace.analytics:read', 'project:create',
]
const WS_ADMIN: Permission[] = [
  'workspace:read', 'workspace:update', 'workspace.members:read', 'workspace.members:manage',
  'workspace.settings:manage', 'workspace.api_keys:manage', 'workspace.analytics:read', 'project:create',
]
const WS_MEMBER: Permission[] = ['workspace:read', 'workspace.members:read', 'project:create']
const WS_VIEWER: Permission[] = ['workspace:read', 'workspace.members:read']

const P_ADMIN: Permission[] = [
  'project:read', 'project:update', 'project:delete', 'project.members:manage',
  'project:publish', 'project.settings:manage', 'project.credentials:manage', 'project:export',
]
const P_EDITOR: Permission[] = ['project:read', 'project:update', 'project:publish', 'project:export']
const P_VIEWER: Permission[] = ['project:read']

interface Row {
  name: string
  facts: AccessFacts
  expected: Permission[]
  projectRole: 'admin' | 'member' | 'viewer' | null
  isGuest?: boolean
}

const open = (projectRole: Row['projectRole'] = null) => ({ visibility: 'workspace' as const, projectRole })
const restricted = (projectRole: Row['projectRole'] = null) => ({ visibility: 'restricted' as const, projectRole })

const rows: Row[] = [
  // Workspace scope only
  { name: 'owner @ workspace', facts: { workspaceRole: 'owner' }, expected: WS_OWNER, projectRole: null },
  { name: 'admin @ workspace', facts: { workspaceRole: 'admin' }, expected: WS_ADMIN, projectRole: null },
  { name: 'member @ workspace', facts: { workspaceRole: 'member' }, expected: WS_MEMBER, projectRole: null },
  { name: 'viewer @ workspace', facts: { workspaceRole: 'viewer' }, expected: WS_VIEWER, projectRole: null },
  {
    name: 'billing-admin member @ workspace',
    facts: { workspaceRole: 'member', isBillingAdmin: true },
    expected: [...WS_MEMBER, 'workspace.billing:manage'],
    projectRole: null,
  },
  {
    name: 'billing-admin admin @ workspace',
    facts: { workspaceRole: 'admin', isBillingAdmin: true },
    expected: [...WS_ADMIN, 'workspace.billing:manage'],
    projectRole: null,
  },
  { name: 'outsider @ workspace', facts: {}, expected: [], projectRole: null },
  { name: 'billing flag without membership grants nothing', facts: { isBillingAdmin: true }, expected: [], projectRole: null },

  // Open project
  { name: 'owner @ open', facts: { workspaceRole: 'owner', project: open() }, expected: [...WS_OWNER, ...P_ADMIN], projectRole: 'admin' },
  { name: 'admin @ open', facts: { workspaceRole: 'admin', project: open() }, expected: [...WS_ADMIN, ...P_ADMIN], projectRole: 'admin' },
  { name: 'member @ open', facts: { workspaceRole: 'member', project: open() }, expected: [...WS_MEMBER, ...P_EDITOR], projectRole: 'member' },
  { name: 'viewer @ open', facts: { workspaceRole: 'viewer', project: open() }, expected: [...WS_VIEWER, ...P_VIEWER], projectRole: 'viewer' },
  {
    name: 'viewer + project admin @ open takes the higher role',
    facts: { workspaceRole: 'viewer', project: open('admin') },
    expected: [...WS_VIEWER, ...P_ADMIN],
    projectRole: 'admin',
  },
  {
    name: 'member + project viewer @ open keeps workspace-inherited editor',
    facts: { workspaceRole: 'member', project: open('viewer') },
    expected: [...WS_MEMBER, ...P_EDITOR],
    projectRole: 'member',
  },
  { name: 'outsider @ open', facts: { project: open() }, expected: [], projectRole: null },

  // Restricted project
  { name: 'owner @ restricted', facts: { workspaceRole: 'owner', project: restricted() }, expected: [...WS_OWNER, ...P_ADMIN], projectRole: 'admin' },
  { name: 'admin @ restricted', facts: { workspaceRole: 'admin', project: restricted() }, expected: [...WS_ADMIN, ...P_ADMIN], projectRole: 'admin' },
  { name: 'member @ restricted (no project row)', facts: { workspaceRole: 'member', project: restricted() }, expected: WS_MEMBER, projectRole: null },
  { name: 'viewer @ restricted (no project row)', facts: { workspaceRole: 'viewer', project: restricted() }, expected: WS_VIEWER, projectRole: null },
  {
    name: 'member + project admin @ restricted',
    facts: { workspaceRole: 'member', project: restricted('admin') },
    expected: [...WS_MEMBER, ...P_ADMIN],
    projectRole: 'admin',
  },
  {
    name: 'member + project viewer @ restricted is only a viewer there',
    facts: { workspaceRole: 'member', project: restricted('viewer') },
    expected: [...WS_MEMBER, ...P_VIEWER],
    projectRole: 'viewer',
  },
  { name: 'outsider @ restricted', facts: { project: restricted() }, expected: [], projectRole: null },

  // Guests (project rows only)
  { name: 'guest editor @ restricted', facts: { project: restricted('member') }, expected: P_EDITOR, projectRole: 'member', isGuest: true },
  { name: 'guest viewer @ open', facts: { project: open('viewer') }, expected: P_VIEWER, projectRole: 'viewer', isGuest: true },
  { name: 'guest admin @ open', facts: { project: open('admin') }, expected: P_ADMIN, projectRole: 'admin', isGuest: true },
]

describe('resolveAccess matrix', () => {
  for (const row of rows) {
    test(row.name, () => {
      const access = resolveAccess(row.facts)
      expect(permissionList(access).sort()).toEqual([...new Set(row.expected)].sort())
      expect(access.projectRole).toBe(row.projectRole)
      expect(access.isGuest).toBe(row.isGuest ?? false)
    })
  }

  test('super_admin gets every permission with or without membership', () => {
    for (const facts of [{ isSuperAdmin: true }, { isSuperAdmin: true, project: restricted() }]) {
      const access = resolveAccess(facts)
      expect(permissionList(access)).toEqual([...ALL_PERMISSIONS])
      expect(access.isSuperAdmin).toBe(true)
    }
  })

  test('guests get no workspace-level permissions at workspace scope', () => {
    expect(permissionList(resolveAccess({ workspaceRole: null }))).toEqual([])
  })
})

describe('no-escalation rules', () => {
  const owner = resolveAccess({ workspaceRole: 'owner' })
  const admin = resolveAccess({ workspaceRole: 'admin' })
  const member = resolveAccess({ workspaceRole: 'member' })

  test('owner can assign every workspace role', () => {
    for (const r of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(canAssignWorkspaceRole(owner, r)).toBe(true)
    }
  })

  test('admin can assign admin/member/viewer but never owner', () => {
    expect(canAssignWorkspaceRole(admin, 'owner')).toBe(false)
    expect(canAssignWorkspaceRole(admin, 'admin')).toBe(true)
    expect(canAssignWorkspaceRole(admin, 'member')).toBe(true)
    expect(canAssignWorkspaceRole(admin, 'viewer')).toBe(true)
  })

  test('members cannot assign workspace roles at all', () => {
    for (const r of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(canAssignWorkspaceRole(member, r)).toBe(false)
    }
  })

  test('project admin (via project row) can assign project roles but no workspace roles', () => {
    const projectAdmin = resolveAccess({ workspaceRole: 'member', project: restricted('admin') })
    expect(canAssignProjectRole(projectAdmin, 'admin')).toBe(true)
    expect(canAssignProjectRole(projectAdmin, 'viewer')).toBe(true)
    expect(canAssignWorkspaceRole(projectAdmin, 'viewer')).toBe(false)
  })

  test('project editor cannot assign project roles', () => {
    const editor = resolveAccess({ workspaceRole: 'member', project: open() })
    expect(canAssignProjectRole(editor, 'viewer')).toBe(false)
  })
})

describe('toProjectRole', () => {
  test('folds legacy owner into admin and rejects junk', () => {
    expect(toProjectRole('owner')).toBe('admin')
    expect(toProjectRole('member')).toBe('member')
    expect(toProjectRole('superuser')).toBeNull()
    expect(toProjectRole(undefined)).toBeNull()
  })
})
