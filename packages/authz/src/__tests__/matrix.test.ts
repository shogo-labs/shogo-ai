// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Hand-written access matrix. Expected sets are spelled out literally and
 * never derived from the role maps, so a wrong map fails here instead of
 * being copied into the expectation.
 */

import { describe, expect, test } from 'bun:test'
import {
  ABILITY_PERMISSIONS,
  ALL_PERMISSIONS,
  WORKSPACE_ROLE_DEFAULT_ABILITIES,
  allowedModels,
  canAssignProjectRole,
  canAssignWorkspaceRole,
  canManageProjectMember,
  canManageWorkspaceMember,
  canManageWorkspaceOwner,
  governsAllProjects,
  highestTierAllowed,
  isModelAllowed,
  permissionList,
  resolveAbilities,
  resolveAccess,
  resolveDefaultModelId,
  resolveLimits,
  resolveModelGrant,
  resolvePolicy,
  toProjectRole,
  type AccessFacts,
  type AccessPolicyRow,
  type ModelInfo,
  type Permission,
  type WorkspaceRole,
} from '../index'

const WS_OWNER: Permission[] = [
  'workspace:read', 'workspace:update', 'workspace:delete', 'workspace.members:read',
  'workspace.members:manage', 'workspace.owners:manage', 'workspace.billing:manage',
  'workspace.settings:manage', 'workspace.api_keys:manage', 'workspace.analytics:read',
  'workspace:export', 'workspace:move', 'project:create',
  'agent.exec:use', 'agent.browser:use', 'agent.media:generate', 'agent.channels:send',
  'agent.social:post', 'agent:create', 'schedule:manage', 'trigger:manage', 'system:apply',
  'agent.approvals:decide', 'integrations:connect', 'project.files:share_public',
  'project.secrets:read', 'instance.commands:run', 'channels.private:create',
  'boards:manage', 'members.activity:read', 'models:use_all',
]
const WS_ADMIN: Permission[] = [
  'workspace:read', 'workspace:update', 'workspace.members:read', 'workspace.members:manage',
  'workspace.settings:manage', 'workspace.api_keys:manage', 'workspace.analytics:read',
  'workspace:export', 'workspace:move', 'project:create',
  'agent.exec:use', 'agent.browser:use', 'agent.media:generate', 'agent.channels:send',
  'agent.social:post', 'agent:create', 'schedule:manage', 'trigger:manage', 'system:apply',
  'agent.approvals:decide', 'integrations:connect', 'project.files:share_public',
  'project.secrets:read', 'instance.commands:run', 'channels.private:create',
  'boards:manage', 'members.activity:read', 'models:use_all',
]
const WS_MEMBER: Permission[] = [
  'workspace:read', 'workspace.members:read', 'project:create',
  'agent.exec:use', 'agent.browser:use', 'agent.media:generate', 'agent.channels:send',
  'agent.social:post', 'agent:create', 'schedule:manage', 'trigger:manage',
  'integrations:connect', 'project.files:share_public', 'channels.private:create',
  'boards:manage', 'instance.commands:run',
]
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

describe('governsAllProjects', () => {
  test('only owners and admins', () => {
    expect(governsAllProjects('owner')).toBe(true)
    expect(governsAllProjects('admin')).toBe(true)
    expect(governsAllProjects('member')).toBe(false)
    expect(governsAllProjects('viewer')).toBe(false)
    expect(governsAllProjects(null)).toBe(false)
  })
})

describe('managing existing members', () => {
  const ws = (workspaceRole: AccessFacts['workspaceRole']) => resolveAccess({ workspaceRole })
  const proj = (workspaceRole: AccessFacts['workspaceRole'], projectRole: 'admin' | 'member' | 'viewer' | null) =>
    resolveAccess({ workspaceRole, project: { visibility: 'restricted', projectRole } })

  test('workspace: owners manage everyone, admins up to admin, members nobody', () => {
    expect(canManageWorkspaceMember(ws('owner'), 'owner')).toBe(true)
    expect(canManageWorkspaceMember(ws('admin'), 'owner')).toBe(false)
    expect(canManageWorkspaceMember(ws('admin'), 'admin')).toBe(true)
    expect(canManageWorkspaceMember(ws('admin'), 'viewer')).toBe(true)
    expect(canManageWorkspaceMember(ws('member'), 'viewer')).toBe(false)
    expect(canManageWorkspaceMember(ws('admin'), null)).toBe(true)
    expect(canManageWorkspaceMember(ws('member'), null)).toBe(false)
  })

  test('owner rows are peer-managed: the seat, not the permission, decides', () => {
    const superAdmin = resolveAccess({ isSuperAdmin: true })
    expect(canManageWorkspaceOwner(superAdmin)).toBe(false)
    expect(canAssignWorkspaceRole(superAdmin, 'owner')).toBe(false)
    expect(canManageWorkspaceMember(superAdmin, 'owner')).toBe(false)

    // A super admin who also holds an owner seat in the workspace may.
    const superAdminOwner = resolveAccess({ isSuperAdmin: true, workspaceRole: 'owner' })
    expect(canManageWorkspaceOwner(superAdminOwner)).toBe(true)
    expect(canManageWorkspaceMember(superAdminOwner, 'owner')).toBe(true)

    // Everything below the owner role still follows the permission set.
    expect(canAssignWorkspaceRole(superAdmin, 'admin')).toBe(true)
    expect(canManageWorkspaceMember(superAdmin, 'admin')).toBe(true)
  })

  test('project: project admins manage up to admin, editors nobody', () => {
    expect(canManageProjectMember(proj(null, 'admin'), 'admin')).toBe(true)
    expect(canManageProjectMember(proj(null, 'admin'), 'viewer')).toBe(true)
    expect(canManageProjectMember(proj(null, 'member'), 'viewer')).toBe(false)
    expect(canManageProjectMember(proj('owner', null), 'admin')).toBe(true)
    expect(canManageProjectMember(proj(null, 'admin'), null)).toBe(true)
    expect(canManageProjectMember(proj(null, 'member'), null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SHO-417: per-role / group / member abilities and the model ceiling
// ---------------------------------------------------------------------------

const CATALOG: ModelInfo[] = [
  { id: 'haiku', tier: 'economy' },
  { id: 'sonnet', tier: 'standard' },
  { id: 'opus', tier: 'premium' },
  { id: 'gpt-nano', tier: 'economy' },
]

const policy = (row: Partial<AccessPolicyRow> & Pick<AccessPolicyRow, 'subjectType' | 'subjectId'>): AccessPolicyRow => row

describe('abilities: every role × ability pair', () => {
  const roles: WorkspaceRole[] = ['owner', 'admin', 'member', 'viewer']

  // Spelled out literally, never derived from the role maps.
  const expected: Record<WorkspaceRole, Permission[]> = {
    owner: [...ABILITY_PERMISSIONS],
    admin: [...ABILITY_PERMISSIONS],
    member: [
      'agent.exec:use', 'agent.browser:use', 'agent.media:generate', 'agent.channels:send',
      'agent.social:post', 'agent:create', 'schedule:manage', 'trigger:manage',
      'integrations:connect', 'project.files:share_public', 'channels.private:create',
      'boards:manage', 'instance.commands:run',
    ],
    viewer: [],
  }

  for (const role of roles) {
    for (const ability of ABILITY_PERMISSIONS) {
      test(`${role} × ${ability}`, () => {
        const abilities = resolveAbilities(role, [])
        expect(abilities.has(ability)).toBe(expected[role].includes(ability))
      })
    }
  }

  test('a role with no policy row matches the built-in default', () => {
    for (const role of roles) {
      const expectedAbilities = expected[role]
        .filter((p) => (ABILITY_PERMISSIONS as readonly string[]).includes(p))
        .sort()
      expect([...WORKSPACE_ROLE_DEFAULT_ABILITIES[role]].sort() as string[]).toEqual(expectedAbilities)
    }
  })

  test('a role policy replaces the role default, and cannot remove base permissions', () => {
    const abilities = resolveAbilities('member', [
      policy({ subjectType: 'role', subjectId: 'member', abilities: ['agent.exec:use'] }),
    ])
    expect(abilities.has('agent.exec:use')).toBe(true)
    expect(abilities.has('agent.browser:use')).toBe(false)
    expect(abilities.has('schedule:manage')).toBe(false)
    // Base permissions survive a narrowed role policy.
    expect(abilities.has('workspace:read')).toBe(true)
    expect(abilities.has('project:create')).toBe(true)
  })

  test('a group policy adds to the role grant', () => {
    const abilities = resolveAbilities('member', [
      policy({ subjectType: 'role', subjectId: 'member', abilities: ['agent.exec:use'] }),
      policy({ subjectType: 'group', subjectId: 'g-ml', abilities: ['agent.media:generate'] }),
    ])
    expect(abilities.has('agent.exec:use')).toBe(true)
    expect(abilities.has('agent.media:generate')).toBe(true)
    expect(abilities.has('agent.browser:use')).toBe(false)
  })

  test('a member policy adds to the role and group grants', () => {
    const abilities = resolveAbilities('viewer', [
      policy({ subjectType: 'member', subjectId: 'u1', abilities: ['agent.exec:use'] }),
    ])
    expect(abilities.has('agent.exec:use')).toBe(true)
    expect(abilities.has('agent.browser:use')).toBe(false)
  })

  test('an unknown ability name in a policy row is ignored', () => {
    const abilities = resolveAbilities('viewer', [
      policy({ subjectType: 'member', subjectId: 'u1', abilities: ['agent.exec:use', 'root:everything'] }),
    ])
    expect(abilities.has('agent.exec:use')).toBe(true)
    expect(abilities.has('root:everything' as Permission)).toBe(false)
  })
})

describe('models: grants, ceiling and default', () => {
  const ceiling = new Set(['haiku', 'sonnet', 'opus'])

  test('no policy rows = everything under the ceiling', () => {
    const grant = resolveModelGrant('member', [])
    expect(allowedModels(grant, ceiling, CATALOG).map((m) => m.id)).toEqual(['haiku', 'sonnet', 'opus'])
  })

  test('a role policy naming a tier narrows the role', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['standard'] }),
    ])
    expect(allowedModels(grant, ceiling, CATALOG).map((m) => m.id)).toEqual(['sonnet'])
  })

  test('a group policy lifts a member above their role', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['standard'] }),
      policy({ subjectType: 'group', subjectId: 'g-ml', modelTiers: ['premium'] }),
    ])
    expect(allowedModels(grant, ceiling, CATALOG).map((m) => m.id)).toEqual(['sonnet', 'opus'])
  })

  test('a member policy can name a single model id', () => {
    const grant = resolveModelGrant('viewer', [
      policy({ subjectType: 'role', subjectId: 'viewer', modelTiers: ['economy'] }),
      policy({ subjectType: 'member', subjectId: 'u1', modelIds: ['sonnet'] }),
    ])
    expect(allowedModels(grant, ceiling, CATALOG).map((m) => m.id)).toEqual(['haiku', 'sonnet'])
  })

  test('an ability-only group or member grant does not widen the models', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['economy'] }),
      policy({ subjectType: 'group', subjectId: 'g-ml', abilities: ['agent.social:post'] }),
      policy({ subjectType: 'member', subjectId: 'u1', abilities: ['project.secrets:read'] }),
    ])
    expect(allowedModels(grant, ceiling, CATALOG).map((m) => m.id)).toEqual(['haiku'])
  })

  test('the ceiling always wins: a grant cannot widen it', () => {
    const narrowCeiling = new Set(['haiku'])
    const grant = resolveModelGrant('owner', [])
    expect(allowedModels(grant, narrowCeiling, CATALOG).map((m) => m.id)).toEqual(['haiku'])
    expect(isModelAllowed(grant, { id: 'opus', tier: 'premium' }, narrowCeiling)).toBe(false)
  })

  test('a new premium model joins every policy that grants premium', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['premium'] }),
    ])
    expect(isModelAllowed(grant, { id: 'opus-5', tier: 'premium' }, null)).toBe(true)
  })

  test('default model: member policy, then group, then role, then workspace, then highest tier', () => {
    const base = { role: 'member' as const, ceiling, catalog: CATALOG }
    const grant = resolveModelGrant('member', [])
    expect(
      resolveDefaultModelId({
        ...base,
        grant,
        policies: [policy({ subjectType: 'member', subjectId: 'u1', defaultModelId: 'haiku' })],
        workspaceDefaultModelId: 'sonnet',
      }),
    ).toBe('haiku')
    expect(
      resolveDefaultModelId({
        ...base,
        grant,
        policies: [policy({ subjectType: 'group', subjectId: 'g', defaultModelId: 'sonnet' })],
        workspaceDefaultModelId: 'haiku',
      }),
    ).toBe('sonnet')
    expect(
      resolveDefaultModelId({
        ...base,
        grant,
        policies: [policy({ subjectType: 'role', subjectId: 'member', defaultModelId: 'haiku' })],
        workspaceDefaultModelId: 'sonnet',
      }),
    ).toBe('haiku')
    expect(
      resolveDefaultModelId({ ...base, grant, policies: [], workspaceDefaultModelId: 'sonnet' }),
    ).toBe('sonnet')
    // Nothing named: the highest tier the member may use.
    expect(resolveDefaultModelId({ ...base, grant, policies: [] })).toBe('opus')
  })

  test('a default outside the effective set is ignored', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['economy'] }),
    ])
    expect(
      resolveDefaultModelId({
        role: 'member',
        policies: [policy({ subjectType: 'member', subjectId: 'u1', defaultModelId: 'opus' })],
        grant,
        ceiling,
        catalog: CATALOG,
      }),
    ).toBe('haiku')
  })

  test('highestTierAllowed is null when nothing is allowed', () => {
    const grant = resolveModelGrant('member', [
      policy({ subjectType: 'role', subjectId: 'member', modelTiers: ['premium'] }),
    ])
    expect(highestTierAllowed(grant, new Set(['haiku']), CATALOG)).toBeNull()
  })
})

describe('limits', () => {
  test('the tightest cap and rate limit win, and the period follows the cap', () => {
    const limits = resolveLimits([
      policy({ subjectType: 'role', subjectId: 'member', spendCapUsd: 50, spendPeriod: 'month', requestsPerHour: 100 }),
      policy({ subjectType: 'group', subjectId: 'g', spendCapUsd: 20, spendPeriod: 'week' }),
      policy({ subjectType: 'member', subjectId: 'u1', requestsPerHour: 10 }),
    ])
    expect(limits).toEqual({ spendCapUsd: 20, spendPeriod: 'week', requestsPerHour: 10 })
  })

  test('no caps = no limits', () => {
    expect(resolveLimits([])).toEqual({ spendCapUsd: null, spendPeriod: null, requestsPerHour: null })
  })
})

describe('resolvePolicy', () => {
  test('composes abilities, models, default and limits in one call', () => {
    const effective = resolvePolicy({
      role: 'member',
      policies: [
        policy({ subjectType: 'role', subjectId: 'member', abilities: ['agent.exec:use'], modelTiers: ['standard'] }),
        policy({ subjectType: 'group', subjectId: 'g-ml', modelTiers: ['premium'], defaultModelId: 'opus' }),
      ],
      ceiling: new Set(['haiku', 'sonnet', 'opus']),
      catalog: CATALOG,
      reasons: ['role Editor', 'group @ml'],
    })
    expect(effective.abilities.has('agent.exec:use')).toBe(true)
    expect(effective.abilities.has('agent.browser:use')).toBe(false)
    expect(effective.defaultModelId).toBe('opus')
    expect(effective.reasons).toEqual(['role Editor', 'group @ml'])
  })
})
