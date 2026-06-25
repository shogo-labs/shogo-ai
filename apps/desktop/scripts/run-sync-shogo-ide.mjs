// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawnSync as realSpawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = path.join(__dirname, 'sync-shogo-ide.mjs')

export function runSyncShogoIde(spawn = realSpawnSync, scriptPath = DEFAULT_SCRIPT) {
  if (!existsSync(scriptPath)) {
    throw new Error(
      `[forge.config] prePackage: cannot find sync-shogo-ide.mjs at ${scriptPath}. ` +
        `apps/desktop is corrupt — re-clone or check out a clean tree.`,
    )
  }
  const result = spawn('node', [scriptPath], { stdio: 'inherit' })
  if (result.error) {
    throw new Error(
      `[forge.config] prePackage: failed to spawn sync-shogo-ide.mjs: ${result.error.message}`,
    )
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    throw new Error(
      `[forge.config] prePackage: sync-shogo-ide.mjs exited with code ${result.status}. ` +
        `The packaged resources/apps/shogo-ide/ would be incomplete — refusing to continue. ` +
        `See the script output above for which file is missing.`,
    )
  }
}
