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
import { TRANSFER_MAX_ARCHIVE_BASE64_CHARS } from '@shogo/shared-runtime/project-transfer-limits'

export const REMOTE_READONLY_TOOLS: readonly string[] = ['read_file', 'search', 'exec_list', 'exec_wait', 'share_file']

export function isRemoteReadonlyTool(tool: string): boolean {
  return REMOTE_READONLY_TOOLS.includes(tool)
}

export function remoteToolPermission(tool: string): Permission {
  return isRemoteReadonlyTool(tool) ? 'project:read' : 'project:update'
}

/**
 * `POST /api/internal/projects/:id/files/import` (`copy_to_project`): the
 * compressed archive cap from `@shogo/shared-runtime/project-transfer-limits`
 * — the same constant the agent runtime packs and imports against — as base64
 * characters.
 */
export const REMOTE_IMPORT_MAX_BASE64_CHARS = TRANSFER_MAX_ARCHIVE_BASE64_CHARS
