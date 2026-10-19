// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dir, '../../../..')

/** Root that holds one folder per project's workspace files. */
export function getWorkspacesDir(): string {
  return process.env.WORKSPACES_DIR || resolve(PROJECT_ROOT, 'workspaces')
}
