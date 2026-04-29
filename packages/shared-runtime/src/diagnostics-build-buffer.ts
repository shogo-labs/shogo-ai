// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * In-process ring buffer of Vite/build errors keyed by projectId.
 *
 * Producers:
 *   - The Vite-error-bridge plugin (packages/agent-runtime/src/vite-error-bridge.ts)
 *     calls `recordBuildError` whenever Vite emits an HMR / transform error.
 *   - Anything else that wants to surface a build-time problem (e.g. the
 *     skill-server generator, prisma push) can also push entries here.
 *
 * Consumer:
 *   - The diagnostics router (`./diagnostics.ts`) reads via `getBuildErrors`.
 *
 * The buffer is intentionally lossy and small — last 50 entries per project,
 * cleared on `clearBuildErrors` (called when a successful HMR update arrives,
 * so resolved errors disappear automatically). Persistence is out of scope:
 * if the pod restarts, the next build run regenerates the same errors.
 */

export interface BuildErrorEntry {
  /** Workspace-relative or absolute path; the consumer normalises. */
  file?: string
  line?: number
  column?: number
  code?: string
  message: string
  /** ISO timestamp of when the error was recorded. */
  recordedAt: string
}

const BUFFER_LIMIT = 50

const buffers = new Map<string, BuildErrorEntry[]>()

export function recordBuildError(projectId: string, entry: Omit<BuildErrorEntry, "recordedAt">): void {
  if (!projectId) return
  const list = buffers.get(projectId) ?? []
  list.push({ ...entry, recordedAt: new Date().toISOString() })
  while (list.length > BUFFER_LIMIT) list.shift()
  buffers.set(projectId, list)
}

export function getBuildErrors(projectId: string): BuildErrorEntry[] {
  return buffers.get(projectId) ?? []
}

export function clearBuildErrors(projectId: string): void {
  buffers.delete(projectId)
}

/** Test-only — full reset of the buffer registry. */
export function _resetBuildBufferForTests(): void {
  buffers.clear()
}
