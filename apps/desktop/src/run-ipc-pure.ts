// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pure helpers used by run-ipc.ts. Split out so unit tests can exercise
 * them without pulling in `electron` (which needs an Electron binary
 * to import cleanly under `bun test`).
 */
import { promises as fs } from 'fs'
import { homedir } from 'os'
import * as path from 'path'

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

const HOME = homedir()

/**
 * Reject any path that resolves outside the user's home directory.
 * Defensive posture matching fs-ipc / git-ipc.
 */
export function validateWorkspace(root: unknown): string | null {
  if (!root || typeof root !== 'string') return null
  const resolved = path.resolve(root)
  if (resolved !== HOME && !resolved.startsWith(HOME + path.sep)) {
    return null
  }
  return resolved
}

/**
 * Detect the package manager by lockfile presence.
 * Order matters — bun first because Shogo's workspaces are bun-native.
 */
export async function detectPackageManager(root: string): Promise<PackageManager> {
  const checks: { file: string; pm: PackageManager }[] = [
    { file: 'bun.lockb', pm: 'bun' },
    { file: 'bun.lock', pm: 'bun' },
    { file: 'pnpm-lock.yaml', pm: 'pnpm' },
    { file: 'yarn.lock', pm: 'yarn' },
    { file: 'package-lock.json', pm: 'npm' },
  ]
  for (const c of checks) {
    try {
      await fs.access(path.join(root, c.file))
      return c.pm
    } catch {
      /* not present — try next */
    }
  }
  return 'npm'
}

export interface ScriptEntry { name: string; command: string }

/**
 * Parse package.json text and pull out the `scripts` map. Returns an
 * empty list (not an error) when scripts is missing — most packages
 * without scripts are still valid runtime targets.
 */
export function parsePackageJsonScripts(raw: string): { ok: true; scripts: ScriptEntry[] } | { ok: false; error: string } {
  let parsed: unknown
  try { parsed = JSON.parse(raw) }
  catch (e) { return { ok: false, error: `parse error: ${(e as Error).message}` } }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'package.json is not an object' }
  }
  const pkg = parsed as { scripts?: unknown }
  if (pkg.scripts === undefined) {
    return { ok: true, scripts: [] }
  }
  if (!pkg.scripts || typeof pkg.scripts !== 'object' || Array.isArray(pkg.scripts)) {
    return { ok: false, error: 'package.json "scripts" is not an object' }
  }
  const out: ScriptEntry[] = []
  for (const [name, command] of Object.entries(pkg.scripts as Record<string, unknown>)) {
    if (typeof name === 'string' && typeof command === 'string') {
      out.push({ name, command })
    }
  }
  return { ok: true, scripts: out }
}

// ─── debug-mode helpers ─────────────────────────────────────────────

/**
 * v8 prints two lines to stderr when launched with `--inspect`/`--inspect-brk`:
 *
 *   Debugger listening on ws://127.0.0.1:9229/<uuid>
 *   For help, see: https://nodejs.org/en/docs/inspector
 *
 * This helper extracts the WebSocket URL the first time it appears in a
 * stderr buffer. Returns `null` when no URL is present yet — callers stream
 * stderr chunks and re-call until they see one (or give up after a timeout).
 */
export function extractInspectorWsUrl(stderr: string): string | null {
  const m = /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderr)
  return m ? m[1]! : null
}

/**
 * Compose the `NODE_OPTIONS` env value used to enable inspector for a child.
 *
 * We use `--inspect=0` (random port) when the caller does not pass an explicit
 * port — picking a fresh port avoids conflicts with already-running debuggers.
 * `--inspect-brk` is preferred so the script halts on entry, giving the IDE
 * time to set breakpoints before code runs.
 */
export function buildInspectorNodeOptions(opts: { breakOnStart?: boolean; port?: number; existing?: string }): string {
  const port = typeof opts.port === 'number' ? opts.port : 0
  const flag = opts.breakOnStart === false ? '--inspect' : '--inspect-brk'
  const fragment = `${flag}=${port}`
  if (opts.existing && opts.existing.trim()) {
    // Preserve user-supplied NODE_OPTIONS — append unless our flag already there.
    if (opts.existing.includes('--inspect')) return opts.existing
    return `${opts.existing} ${fragment}`
  }
  return fragment
}
