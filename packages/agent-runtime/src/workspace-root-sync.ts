// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Keeps the Personal workspace's root (`AGENTS.md`, `MEMORY.md`, `memory/`,
 * skills) the same on the cloud pod and every paired desktop (SHO-285 Update 2,
 * section F).
 *
 * The sync engine itself is `@shogo/shared-runtime`; this file is only the
 * wiring — which workspace, which directory, and how to reach the API. Both
 * callers get the same code path, which is what keeps "written on the Mac" and
 * "written in the cloud" from being two different mechanisms.
 *
 * It runs for the **Personal** only. Other workspaces are per-project archives
 * with their own bucket layout, and answering for them here would be a silent
 * "your files synced" that never happened.
 */

import { hostname } from 'node:os'
import { readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import {
  createWorkspaceRootSync,
  isSharedRootPath,
  type WorkspaceRootSync,
  type WorkspaceRootTransport,
} from '@shogo/shared-runtime'
import { deriveApiUrl, getInternalHeaders, hasInternalApiCredentials } from './internal-api'
import { workspaceKind } from './workspace-runtime-mode'

/** The directory a workspace root lives in — the same one the members mount into. */
function workspaceDir(): string {
  return process.env.WORKSPACE_DIR || process.env.AGENT_DIR || '/app/workspace'
}

/** Name used in a conflict copy's filename, so a person can tell the two apart. */
function deviceName(): string {
  return process.env.SHOGO_DEVICE_NAME || hostname() || 'device'
}

function transportFor(workspaceId: string, apiUrl: string): WorkspaceRootTransport {
  const base = `${apiUrl}/api/internal/workspaces/${encodeURIComponent(workspaceId)}/root`
  return {
    async manifest(opts = {}) {
      const query = opts.since ? `?since=${encodeURIComponent(opts.since)}` : ''
      const res = await fetch(`${base}/manifest${query}`, {
        headers: getInternalHeaders(),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`manifest HTTP ${res.status}`)
      return (await res.json()) as any
    },
    async presign(files) {
      const res = await fetch(`${base}/presign`, {
        method: 'POST',
        headers: getInternalHeaders(),
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`presign HTTP ${res.status}`)
      return (await res.json()) as any
    },
  }
}

let active: WorkspaceRootSync | null = null

/**
 * Start the root sync for this runtime, or return null when it does not apply
 * (a team workspace, a runtime with no API, a host-mediated/metal guest whose
 * host owns durability).
 */
export function startWorkspaceRootSync(): WorkspaceRootSync | null {
  if (active) return active
  if (workspaceKind() !== 'personal') return null
  const workspaceId = process.env.WORKSPACE_ID
  if (!workspaceId) return null
  if (!hasInternalApiCredentials()) return null
  if (process.env.SHOGO_DURABILITY_HOST_MEDIATED === '1') return null
  const apiUrl = deriveApiUrl()
  if (!apiUrl) return null

  active = createWorkspaceRootSync({
    dir: workspaceDir(),
    deviceName: deviceName(),
    transport: transportFor(workspaceId, apiUrl),
    intervalMs: Number(process.env.SHOGO_ROOT_SYNC_INTERVAL_MS || 60_000),
    scanMs: Number(process.env.SHOGO_ROOT_SYNC_SCAN_MS || 2_000),
  })
  active.start()
  return active
}

/** Stop the loop (tests, shutdown). */
export function stopWorkspaceRootSync(): void {
  active?.stop()
  active = null
}

/** The running sync, for a caller that wants to pull before a turn. */
export function currentWorkspaceRootSync(): WorkspaceRootSync | null {
  return active
}

/**
 * A short prompt block naming any conflict copies sitting in the root.
 *
 * When the cloud and this machine both changed a file, the cloud's bytes win
 * and this machine's version is kept beside it as `<name>.conflict-…`. Nothing
 * is lost, but the agent has to know the other version exists or it will
 * confidently answer from half the story. Read from disk each turn, so a copy
 * the person already reconciled stops appearing.
 */
export function buildWorkspaceRootConflictContext(dir: string): string | null {
  const found: string[] = []
  const visit = (current: string, depth: number) => {
    if (depth > 3 || found.length >= 10) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.shogo') continue
        visit(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const rel = relative(dir, full).split(sep).join('/')
      if (rel.includes('.conflict-') && isSharedRootPath(rel)) found.push(rel)
    }
  }
  visit(dir, 0)
  if (!found.length) return null
  return [
    '## Conflicted files in this workspace',
    '',
    'These files changed on two machines before either synced. The cloud copy is the one',
    'in place; the other edit was kept beside it. Read both before answering, and offer the',
    'person the choice rather than assuming one of them is right.',
    '',
    ...found.map((file) => `- \`${file}\``),
    '',
  ].join('\n')
}
