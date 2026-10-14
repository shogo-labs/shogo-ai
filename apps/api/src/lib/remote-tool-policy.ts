// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * RBAC policy for `POST /api/internal/projects/:id/remote-tool`: a runtime
 * running a tool against another project's runtime. Tools listed here only
 * read, so `project:read` on the target is enough; anything else needs
 * `project:update`. Names must match the tool names in
 * packages/agent-runtime/src/gateway-tools.ts.
 */
import type { Permission } from '@shogo/authz'

export const REMOTE_READONLY_TOOLS: readonly string[] = ['read_file', 'search', 'exec_list', 'exec_wait']

export function isRemoteReadonlyTool(tool: string): boolean {
  return REMOTE_READONLY_TOOLS.includes(tool)
}

export function remoteToolPermission(tool: string): Permission {
  return isRemoteReadonlyTool(tool) ? 'project:read' : 'project:update'
}
