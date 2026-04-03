// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Resolves the ripgrep binary path.
 *
 * Prefers the bundled @vscode/ripgrep binary (guaranteed cross-platform),
 * then falls back to a bare 'rg' on PATH.
 */

import { existsSync } from 'fs'

let _resolved: string | undefined

export function resolveRgPath(): string {
  if (_resolved !== undefined) return _resolved

  try {
    const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
    if (rgPath && existsSync(rgPath)) {
      _resolved = rgPath
      return _resolved
    }
  } catch { /* package not installed — fall through */ }

  _resolved = 'rg'
  return _resolved
}
