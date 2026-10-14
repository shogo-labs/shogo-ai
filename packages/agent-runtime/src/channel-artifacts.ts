// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Files an agent sends with a team chat message so people read exactly what
 * it means: a plan it wants approved, a report it is handing over. The text is
 * copied into the message when posted; the API keeps the copy and its hash, so
 * an approval is tied to the version the person read.
 */

import { createHash } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { AgentArtifact, AgentStatusCard } from './internal-api'

export const MAX_ARTIFACTS = 3
export const MAX_ARTIFACT_CHARS = 60_000
const MAX_ARTIFACT_BYTES = 2_000_000

/** Documents worth attaching on their own: prose, not code or data. */
const DOCUMENT_RE = /\.(md|mdx|markdown|txt|rst|adoc)$/i
/** The agent's own bookkeeping, written most turns and never what a person is being asked about. */
const BOOKKEEPING_RE = /^(MEMORY|AGENTS|HEARTBEAT|TOOLS|SOUL|USER|IDENTITY|BOOTSTRAP)\.md$|^(memory|chat-files)\//i

/** `plans/x.md` for a path inside the workspace, given relative or absolute; null outside it or for URLs. */
export function workspaceRelative(workspaceDir: string, path: string): string | null {
  const raw = path.trim()
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null
  const root = resolve(workspaceDir)
  const rel = relative(root, resolve(root, raw))
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/** Read one file for attaching; an error string when it can't be. */
export function readArtifact(workspaceDir: string, path: string): AgentArtifact | string {
  const rel = workspaceRelative(workspaceDir, path)
  if (!rel) return `${path}: not a file in your workspace`
  const full = resolve(workspaceDir, rel)
  let size: number
  try {
    const stat = statSync(full)
    if (!stat.isFile()) return `${rel}: not a file`
    size = stat.size
  } catch {
    return `${rel}: not found`
  }
  if (size > MAX_ARTIFACT_BYTES) return `${rel}: too large to attach (${Math.round(size / 1024)} KB); link it instead`
  const bytes = readFileSync(full)
  if (bytes.includes(0)) return `${rel}: not a text file; link it instead`
  const text = bytes.toString('utf8')
  const truncated = text.length > MAX_ARTIFACT_CHARS
  return {
    path: rel,
    content: truncated ? text.slice(0, MAX_ARTIFACT_CHARS) : text,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(truncated ? { truncated: true } : {}),
  }
}

/**
 * What to attach to a post: the files the agent named (`attach`, and card
 * links that are workspace paths), or, when it asks for a decision and named
 * none, the documents it wrote this turn.
 */
export function collectArtifacts(input: {
  workspaceDir: string
  attach?: string[]
  card?: AgentStatusCard
  /** Workspace-relative paths written this turn, most recent last. */
  writtenThisTurn?: string[]
  decision: boolean
}): { artifacts: AgentArtifact[]; errors: string[]; auto: boolean } {
  const named = [
    ...(input.attach ?? []),
    ...(input.card?.links ?? []).map((l) => l?.url).filter((u): u is string => typeof u === 'string' && !/^https?:\/\//i.test(u)),
  ]
  const auto = !named.length && input.decision
  const candidates = auto
    ? [...(input.writtenThisTurn ?? [])].reverse().filter((p) => DOCUMENT_RE.test(p) && !BOOKKEEPING_RE.test(p))
    : named
  const artifacts: AgentArtifact[] = []
  const errors: string[] = []
  for (const path of candidates) {
    if (artifacts.length >= MAX_ARTIFACTS) break
    const read = readArtifact(input.workspaceDir, path)
    if (typeof read === 'string') {
      if (!auto) errors.push(read)
    } else if (!artifacts.some((a) => a.path === read.path)) {
      artifacts.push(read)
    }
  }
  return { artifacts, errors, auto }
}
