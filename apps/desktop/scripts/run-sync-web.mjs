// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Helper invoked by the `prePackage` hook in `forge.config.ts`.
 *
 * Lives in its own file (rather than inlined in `forge.config.ts`) so
 * the unit tests in `test-forge-config.ts` can import + exercise it
 * without triggering forge.config.ts's top-level
 * `REQUIRED_RESOURCES.filter(existsSync) → process.exit(1)` check.
 * That check is correct in production (a CI build with no
 * `./resources/bun` is genuinely broken) but it makes the config
 * untestable as-is.
 *
 * Contract:
 *   - On success: returns void.
 *   - On any failure (missing script, spawn error, non-zero exit):
 *     throws Error. The caller (`prePackage`) propagates the throw,
 *     which electron-forge surfaces as a red task in its Listr UI with
 *     the captured stderr below it.
 *
 * Dependency injection:
 *   - `spawn`: defaults to `child_process.spawnSync`. Tests pass a
 *     fake to assert what was invoked without forking a real process.
 *   - `scriptPath`: defaults to the sibling `sync-web.mjs`. Tests can
 *     pass a bogus path to verify the "missing script" guard fires
 *     before spawning.
 */
import { spawnSync as realSpawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_SCRIPT = path.join(__dirname, 'sync-web.mjs')

export function runSyncWeb(spawn = realSpawnSync, scriptPath = DEFAULT_SCRIPT) {
  if (!existsSync(scriptPath)) {
    throw new Error(
      `[forge.config] prePackage: cannot find sync-web.mjs at ${scriptPath}. ` +
        `apps/desktop is corrupt — re-clone or check out a clean tree.`,
    )
  }
  const r = spawn('node', [scriptPath], { stdio: 'inherit' })
  if (r.error) {
    throw new Error(
      `[forge.config] prePackage: failed to spawn sync-web.mjs: ${r.error.message}`,
    )
  }
  if (typeof r.status === 'number' && r.status !== 0) {
    throw new Error(
      `[forge.config] prePackage: sync-web.mjs exited with code ${r.status}. ` +
        `The packaged resources/web/ would be missing required assets — refusing to continue. ` +
        `See the script output above for which file is missing.`,
    )
  }
}
