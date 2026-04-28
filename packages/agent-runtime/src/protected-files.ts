// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Protected workspace files
 * ---------------------------------------------------------------------------
 * In canvas-code mode the agent runtime owns a small platform contract for
 * the iframe-side bridge (update toast, theme sync, capability detection,
 * canvas-ready handshake, error forwarding). The user's `src/main.tsx` is
 * the entry point of that contract: it MUST stay slim and only render the
 * React app — the bridge itself is injected at HTML response time by the
 * agent-runtime, served live from packages/agent-runtime/static/canvas-bridge.js.
 *
 * To prevent agents from drifting these files back to a custom version, the
 * mutation-tools (`write_file`, `edit_file`, `delete_file`) consult this
 * list and reject any change that targets a protected path — but ONLY when
 * `ctx.config.canvasMode === 'code'`. Chat / app / json-canvas modes don't
 * have the bridge contract and stay completely unrestricted.
 *
 * The migration pass at workspace boot uses raw `fs.writeFileSync` and is
 * unaffected by the gate, so self-healing still works.
 */

import { resolve, relative, sep } from 'path'

/**
 * Workspace-relative paths that may not be modified by agent tools while
 * `canvasMode === 'code'`. Paths use forward slashes regardless of platform.
 */
export const PROTECTED_WORKSPACE_FILES: readonly string[] = [
  'src/main.tsx',
  'src/ShogoErrorBoundary.tsx',
]

const PROTECTED_SET = new Set(PROTECTED_WORKSPACE_FILES)

/**
 * Returns true if `absPath` resolves inside `workspaceDir` AND its
 * workspace-relative path is in `PROTECTED_WORKSPACE_FILES`.
 *
 * Uses path.relative + a `..`/absolute prefix check so traversal attempts
 * (`workspace/foo/../src/main.tsx`, symlink chains that escape, absolute
 * paths to a different tree) all decide correctly.
 */
export function isProtectedFile(workspaceDir: string, absPath: string): boolean {
  if (!workspaceDir || !absPath) return false
  const rel = relative(resolve(workspaceDir), resolve(absPath))
  if (!rel || rel.startsWith('..' + sep) || rel === '..') return false
  // Reject absolute remainders too (Windows: "C:\..." after relative).
  if (sep === '\\' && /^[a-z]:/i.test(rel)) return false
  if (rel.startsWith(sep)) return false
  const normalized = rel.split(sep).join('/')
  return PROTECTED_SET.has(normalized)
}

/**
 * Standard error message returned by mutation tools when they reject a write
 * to a protected file. Phrased to give the agent a clear next action: stop
 * trying to edit `src/main.tsx`, and edit the bridge on the runtime side
 * instead (which only platform engineers should be doing).
 */
export const PROTECTED_FILE_REJECTION =
  "This file is managed by Shogo and cannot be modified directly. " +
  "The canvas iframe bridge (update toast, theme sync, capability detection, " +
  "error forwarding, canvas-ready handshake) is served live from " +
  "/agent/canvas/bridge.js — its source lives in " +
  "packages/agent-runtime/static/canvas-bridge.js on the agent-runtime side. " +
  "src/main.tsx is intentionally minimal: it only renders the React app " +
  "wrapped in the Shogo error boundary. src/ShogoErrorBoundary.tsx is the " +
  "boundary itself — it catches React render errors so the iframe shows a " +
  "recoverable fallback instead of a white screen. " +
  "If you need different bridge or boundary behavior, change the source on " +
  "the agent-runtime side (canvas-bridge.js or canvas-bridge-migration.ts), " +
  "not the workspace files."
