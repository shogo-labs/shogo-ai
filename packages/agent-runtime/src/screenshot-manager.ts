// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * screenshot-manager — owns the filesystem layout for browser-tool screenshots.
 *
 * Screenshots used to land at `<workspace>/screenshot-<ts>.png`, which flooded
 * project roots over time. We now group them into per-run folders under
 * `.shogo/screenshots/<runKey>/step-NN.png`:
 *
 *   runKey = <subagentInstanceId>     (when running inside a spawned subagent)
 *          | main-YYYY-MM-DD          (when called from the main agent)
 *
 * The tool itself numbers screenshots per tool-instance so filenames are
 * stable and chronologically sortable. Retention keeps only the N most recent
 * run folders (best-effort — we do not error if the trim fails).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const SCREENSHOTS_DIRNAME = '.shogo/screenshots'
const LEGACY_DIRNAME = 'legacy'

function screenshotsRoot(workspaceDir: string): string {
  return join(workspaceDir, SCREENSHOTS_DIRNAME)
}

function ensureGitignore(root: string): void {
  const path = join(root, '.gitignore')
  if (existsSync(path)) return
  try {
    // Ignore every screenshot file / run folder, but keep this marker in place
    // so the directory layout itself remains stable across clones.
    writeFileSync(path, '*\n!.gitignore\n', 'utf-8')
  } catch {
    // best-effort
  }
}

/**
 * The "run key" that uniquely identifies the folder a tool call writes into.
 * Exported for tests; callers should prefer `resolveRunDir`.
 */
export function runKeyFor(instanceId?: string | null): string {
  if (instanceId && instanceId.trim().length > 0) return instanceId
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `main-${y}-${m}-${d}`
}

/**
 * Resolve (and create) the per-run screenshot directory. Safe to call on
 * every screenshot — `mkdirSync(..., { recursive: true })` is idempotent.
 */
export function resolveRunDir(workspaceDir: string, instanceId?: string | null): string {
  const root = screenshotsRoot(workspaceDir)
  mkdirSync(root, { recursive: true })
  ensureGitignore(root)
  const dir = join(root, runKeyFor(instanceId))
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Compose a `step-NN.png` path inside `runDir`. `step` is 1-indexed; we pad
 * to 2 digits up to 99 and fall back to natural width beyond that so tests
 * remain deterministic and normal QA runs sort lexicographically.
 */
export function nextScreenshotPath(runDir: string, step: number): string {
  const n = Math.max(1, Math.trunc(step))
  const padded = n < 100 ? String(n).padStart(2, '0') : String(n)
  return join(runDir, `step-${padded}.png`)
}

/**
 * Move any legacy `<workspaceDir>/screenshot-*.png` files into the `legacy/`
 * folder under the screenshots root. Idempotent — returns the number of files
 * moved so callers can log it.
 *
 * Only touches files whose names match the exact shape the previous browser
 * tool produced (`screenshot-<anything>.png`) so human-authored PNGs at the
 * workspace root are never disturbed.
 */
export function sweepLooseScreenshots(workspaceDir: string): number {
  const root = screenshotsRoot(workspaceDir)
  const legacyDir = join(root, LEGACY_DIRNAME)
  let moved = 0
  let entries: string[]
  try {
    entries = readdirSync(workspaceDir)
  } catch {
    return 0
  }
  const looseRe = /^screenshot-[^/\\]+\.png$/i
  for (const name of entries) {
    if (!looseRe.test(name)) continue
    const src = join(workspaceDir, name)
    try {
      const st = statSync(src)
      if (!st.isFile()) continue
    } catch {
      continue
    }
    if (moved === 0) {
      mkdirSync(legacyDir, { recursive: true })
      ensureGitignore(root)
    }
    let dest = join(legacyDir, name)
    // If a sibling of the same name already exists in legacy/, prefix with
    // the mtime so we never overwrite anything.
    if (existsSync(dest)) {
      try {
        const ms = statSync(src).mtimeMs
        dest = join(legacyDir, `${Math.trunc(ms)}-${name}`)
      } catch {
        dest = join(legacyDir, `${Date.now()}-${name}`)
      }
    }
    try {
      renameSync(src, dest)
      moved += 1
    } catch {
      // best-effort; keep going
    }
  }
  if (moved > 0) {
    console.log(`[screenshots] swept ${moved} stale file(s) into ${LEGACY_DIRNAME}/`)
  }
  return moved
}

/**
 * Keep at most `maxRuns` run folders under `.shogo/screenshots/` (sorted by
 * mtime desc). The `legacy/` folder is always preserved. Best-effort: errors
 * are swallowed so screenshot-taking never fails due to trim issues.
 */
export function trimOldRuns(workspaceDir: string, maxRuns = 20): number {
  const root = screenshotsRoot(workspaceDir)
  if (!existsSync(root)) return 0
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }
  const runs: { name: string; path: string; mtime: number }[] = []
  for (const name of entries) {
    if (name === LEGACY_DIRNAME) continue
    if (name === '.gitignore') continue
    const path = join(root, name)
    try {
      const st = statSync(path)
      if (!st.isDirectory()) continue
      runs.push({ name, path, mtime: st.mtimeMs })
    } catch {
      continue
    }
  }
  if (runs.length <= maxRuns) return 0
  runs.sort((a, b) => b.mtime - a.mtime)
  const doomed = runs.slice(maxRuns)
  let removed = 0
  for (const run of doomed) {
    const abs = resolve(run.path)
    const rootAbs = resolve(root)
    if (!abs.startsWith(rootAbs + '/') && abs !== rootAbs) continue
    try {
      rmSync(abs, { recursive: true, force: true })
      removed += 1
    } catch {
      // best-effort
    }
  }
  if (removed > 0) {
    console.log(`[screenshots] trimmed ${removed} old run folder(s), kept ${maxRuns}`)
  }
  return removed
}
