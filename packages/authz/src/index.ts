// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export * from './permissions'
export * from './roles'
export * from './policy'
export * from './denial'
export {
  resolveAccess,
  hasPermission,
  permissionList,
  canAssignWorkspaceRole,
  canAssignProjectRole,
  canManageWorkspaceMember,
  canManageWorkspaceOwner,
  canManageProjectMember,
  type AccessFacts,
  type EffectiveAccess,
  type ProjectVisibility,
} from './resolve'
