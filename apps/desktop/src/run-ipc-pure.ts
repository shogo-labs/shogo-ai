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
