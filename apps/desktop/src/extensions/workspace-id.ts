// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import path from 'path'
import crypto from 'crypto'

/**
 * Stable per-workspace identifier used to key workspace-scoped extension state.
 * Shared by install-service and host-manager so the same workspace always maps
 * to the same id (previously duplicated byte-for-byte in both files).
 */
export function hashWorkspace(workspaceRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 32)
}
