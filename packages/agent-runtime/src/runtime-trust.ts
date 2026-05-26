// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Runtime trust + allowed-roots policy for the agent-runtime.
 *
 * Central source of truth for "which folders is the agent allowed to
 * touch, and at what permission level?". Used by:
 *
 *   - gateway-tools.ts            → wrap every path-modifying tool in
 *                                   `assertAllowedPath(path, mode)`.
 *   - canvas-file-watcher.ts      → watch every linked root, not just
 *                                   WORKSPACE_DIR (TODO: future).
 *   - index-engine                → scope embeddings to allowed roots.
 *
 * Architecture (post-2026-05 root-cause fix):
 *   - `trustLevel` is a **live** value resolved from the API by
 *     `trust-resolver.ts`. The runtime stopped trusting the
 *     spawn-time `TRUST_LEVEL` env var because env vars are immutable
 *     for a running Node process — that's why clicking "Trust folder"
 *     used to leave the agent stuck on `restricted`.
 *   - The directory layout (`workspaceDir`, `workingMode`,
 *     `linkedFolders`) is genuinely immutable for a runtime instance
 *     (changing primary folder / linked folders requires a restart),
 *     so server.ts seeds those once via `initTrustResolver(...)` and
 *     the resolver holds them for the lifetime of the process.
 *   - In unit tests that don't boot server.ts, `getRuntimeTrust()`
 *     falls back to env-only resolution so tests stay hermetic.
 *   - Path checks use `realpathSync` to defeat symlink escapes:
 *     `/Users/jane/repo/secret` symlinked to `/etc/passwd` would
 *     otherwise read as if it were under the allowed root.
 */

import { existsSync, realpathSync } from 'fs'
import { resolve, sep } from 'path'

import {
  getResolvedTrust,
  isTrustResolverInitialized,
  type TrustLevel,
  type WorkingMode,
} from './trust-resolver'

export type { WorkingMode, TrustLevel } from './trust-resolver'

export interface RuntimeTrust {
  workingMode: WorkingMode
  trustLevel: TrustLevel
  /** Absolute path of the primary workspace / linked folder. */
  workspaceDir: string
  /** Additional host folders linked to the project (external mode). */
  linkedFolders: string[]
}

/**
 * Resolve the runtime's current trust + allowed-roots policy.
 *
 * Production path: reads from `trust-resolver` which holds the most
 * recent value the runtime fetched from the API (refreshed at boot,
 * at the start of every chat turn, and on demand via
 * /internal/refresh-trust).
 *
 * Test / one-shot path: when the resolver hasn't been initialized
 * (no server.ts boot), falls back to env vars so unit tests stay
 * hermetic.
 */
export function getRuntimeTrust(): RuntimeTrust {
  if (isTrustResolverInitialized()) {
    return getResolvedTrust()
  }
  const resolved = getResolvedTrust()
  if (resolved.workspaceDir) {
    // Resolver was seeded by initTrustResolver() but the first
    // refresh() hasn't landed yet (or is failing). Trust whatever
    // safe default the resolver picked at init time — fail-closed
    // for external, fail-open for managed.
    return resolved
  }

  // Env-only fallback (tests, one-shot scripts, evals).
  const workspaceDir =
    process.env.WORKSPACE_DIR ||
    process.env.AGENT_DIR ||
    process.env.PROJECT_DIR ||
    '/app/workspace'
  const workingMode: WorkingMode = process.env.WORKING_MODE === 'external' ? 'external' : 'managed'
  // NB: TRUST_LEVEL env is no longer authoritative in production
  // (that was the bug). We still honor it in the env-only fallback so
  // unit tests can pin a trust level without booting the resolver.
  const trustLevel: TrustLevel =
    process.env.TRUST_LEVEL === 'restricted'
      ? 'restricted'
      : process.env.TRUST_LEVEL === 'trusted'
        ? 'trusted'
        : workingMode === 'external'
          ? 'restricted'
          : 'trusted'
  let linkedFolders: string[] = []
  try {
    const raw = process.env.LINKED_FOLDERS
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        linkedFolders = parsed.filter((p): p is string => typeof p === 'string' && p.length > 0)
      }
    }
  } catch {
    // ignore, default to empty
  }
  return { workingMode, trustLevel, workspaceDir, linkedFolders }
}

/** Allowed roots = [workspaceDir, ...linkedFolders], deduplicated. */
export function getAllowedRoots(): string[] {
  const t = getRuntimeTrust()
  const set = new Set<string>([t.workspaceDir, ...t.linkedFolders])
  return [...set]
}

export type PathMode = 'read' | 'write' | 'exec'

export interface PathCheckResult {
  ok: boolean
  resolved?: string
  reason?:
    | 'outside_allowed_roots'
    | 'restricted_mode_write'
    | 'restricted_mode_exec'
    | 'invalid_path'
  /**
   * Human-readable error suitable for surfacing to the agent (so it
   * stops trying instead of looping) and to the UI (which intercepts
   * `restricted_mode_*` to render the Workspace Trust prompt).
   */
  message?: string
}

/**
 * Validate that `targetPath` is inside the project's allowed roots and
 * that the requested `mode` is permitted by the current trust level.
 *
 * Returns a structured result instead of throwing so callers can
 * convert into either a tool error (gateway-tools.ts) or an HTTP
 * response (a future /agent/files/read route) without try/catch noise.
 *
 * `realpathSync` is used to defeat symlink escapes. If the path
 * doesn't exist yet (common for `write_file` to a new file), we fall
 * back to the nearest existing ancestor; that's the same approach
 * `pathExists`-style helpers use in VS Code's filesystem layer.
 */
/**
 * Test-only seam — wraps the inner \`realpathSync(ancestorPath)\` call
 * inside \`assertAllowedPath\` so the "ancestor also un-realpathable" catch
 * branch can be exercised without relying on a specific filesystem state.
 * Production code routes through the real \`realpathSync\` by default.
 */
export const _runtimeTrustSeamForTests: {
  realpathSync: typeof realpathSync
} = { realpathSync }

export function assertAllowedPath(targetPath: string, mode: PathMode): PathCheckResult {
  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, reason: 'invalid_path', message: 'Empty path' }
  }
  const trust = getRuntimeTrust()
  // Realpath the roots, not just resolve them. On macOS `/tmp` and
  // `/var/folders/...` (the default `tmpdir()`) are symlinks under
  // `/private/`. Without this, a target whose realpath lands in
  // `/private/var/...` would never match a root in `/var/...` and
  // every operation on a perfectly legitimate path would fail.
  const roots = [trust.workspaceDir, ...trust.linkedFolders]
    .filter((p) => typeof p === 'string' && p.length > 0)
    .map((p) => {
      const resolved = resolve(p)
      try {
        return realpathSync(resolved)
      } catch {
        return resolved
      }
    })
  if (roots.length === 0) {
    return { ok: false, reason: 'outside_allowed_roots', message: 'No allowed roots configured' }
  }

  // Resolve real path defensively. If `target` doesn't exist, walk up
  // to the nearest existing ancestor and append the remainder — this
  // lets write_file('newdir/newfile.txt') still pass the check while
  // preventing `..` escape.
  let candidate = resolve(targetPath)
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    // path doesn't exist yet; resolve as far as we can
    let cur = candidate
    let tail = ''
    while (!existsSync(cur) && cur !== resolve(cur, '..')) {
      const next = resolve(cur, '..')
      tail = cur.slice(next.length) + tail
      cur = next
    }
    try {
      const realParent = _runtimeTrustSeamForTests.realpathSync(cur)
      real = realParent + tail
    } catch {
      real = candidate
    }
  }

  const inAllowedRoot = roots.some((root) => {
    const normalized = root.endsWith(sep) ? root : root + sep
    return real === root || real.startsWith(normalized)
  })
  if (!inAllowedRoot) {
    return {
      ok: false,
      reason: 'outside_allowed_roots',
      resolved: real,
      message:
        `Path is outside the project's allowed folders.\n` +
        `Requested: ${real}\nAllowed roots:\n  - ${roots.join('\n  - ')}\n` +
        `Add the parent folder via the "Folders" panel if the agent needs access there.`,
    }
  }

  if (trust.trustLevel === 'restricted') {
    if (mode === 'write') {
      return {
        ok: false,
        reason: 'restricted_mode_write',
        resolved: real,
        message:
          `Workspace is in restricted mode — write tools are disabled. ` +
          `Click "Trust folder" in the project header to enable edits and shell commands.`,
      }
    }
    if (mode === 'exec') {
      return {
        ok: false,
        reason: 'restricted_mode_exec',
        resolved: real,
        message:
          `Workspace is in restricted mode — shell / exec tools are disabled. ` +
          `Click "Trust folder" in the project header to enable edits and shell commands.`,
      }
    }
  }

  return { ok: true, resolved: real }
}
