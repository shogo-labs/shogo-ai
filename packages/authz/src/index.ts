// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

export * from './permissions'
export * from './roles'
export {
  resolveAccess,
  hasPermission,
  permissionList,
  canAssignWorkspaceRole,
  canAssignProjectRole,
  type AccessFacts,
  type EffectiveAccess,
  type ProjectVisibility,
} from './resolve'
