// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Structural type + getter for the `window.shogoDesktop.git` surface
// exposed by `apps/desktop/src/preload.ts`. Follows the same pattern as
// `workspace/desktopFs.ts`: declared structurally so this file has no
// runtime dep on the desktop bundle, and `getDesktopGitBridge()` returns
// null on non-Electron platforms (web / native) so callers can defeature
// gracefully.
//
// This is the ONLY place the renderer talks to git — every other file in
// the ide/git/ folder reaches the bridge through `getDesktopGitBridge()`.

export type GitShortCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!' | '·'

export interface GitSnapshot {
  workspaceRoot: string
  isRepo: boolean
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  fileStatus: Record<string, GitShortCode>
  conflictPaths: string[]
  refreshedAt: number
  error: string | null
}

export interface GitProbeResult {
  ok: boolean
  available: boolean
  version: string | null
  supportsPorcelainV2: boolean
  error?: string
}

export interface CommitOptions {
  amend?: boolean
  signoff?: boolean
}

export type GitOpResult =
  | { ok: true }
  | { ok: false; reason?: string; error?: string }

export type GitOutputResult =
  | { ok: true; output?: string }
  | { ok: false; reason?: string; error?: string }

export interface BranchInfo {
  name: string
  fullRef: string
  isHead: boolean
  isRemote: boolean
  upstream: string | null
  subject: string
  committedAt: string
}

export interface StashEntry {
  ref: string
  index: number
  branch: string | null
  message: string
  createdAt: string
}

export type DiffMarkerKind = 'added' | 'modified' | 'removed'

export interface DiffMarker {
  kind: DiffMarkerKind
  startLine: number
  endLine: number
  removed: number
  added: number
  /** 1-based start line in HEAD (0 for pure additions). See apps/desktop/src/git/diffMarkers.ts. */
  oldStart: number
}

export interface BlameLine {
  line: number
  sha: string
  shortSha: string
  author: string
  authorEmail: string
  authorTime: number
  summary: string
}

export interface BranchesBridge {
  list(workspaceRoot: string): Promise<{ ok: boolean; branches?: BranchInfo[]; reason?: string; error?: string }>
  checkout(workspaceRoot: string, name: string): Promise<GitOpResult>
  create(workspaceRoot: string, name: string, base?: string): Promise<GitOpResult>
  delete(workspaceRoot: string, name: string, force?: boolean): Promise<GitOpResult>
  rename(workspaceRoot: string, oldName: string, newName: string): Promise<GitOpResult>
  publish(workspaceRoot: string, branch: string, remote?: string): Promise<GitOpResult>
}

export interface RemotesBridge {
  list(workspaceRoot: string): Promise<{ ok: boolean; remotes?: string[]; reason?: string; error?: string }>
  fetch(workspaceRoot: string, opts?: { remote?: string; prune?: boolean; all?: boolean }): Promise<GitOutputResult>
  pull(workspaceRoot: string, opts?: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }): Promise<GitOutputResult>
  push(workspaceRoot: string, opts?: { remote?: string; branch?: string; force?: boolean; forceWithLease?: boolean; tags?: boolean; setUpstream?: boolean }): Promise<GitOutputResult>
  sync(workspaceRoot: string, opts?: { remote?: string; branch?: string; rebase?: boolean }): Promise<GitOutputResult>
}

export interface StashBridge {
  list(workspaceRoot: string): Promise<{ ok: boolean; entries?: StashEntry[]; reason?: string; error?: string }>
  push(workspaceRoot: string, opts?: { message?: string; keepIndex?: boolean; includeUntracked?: boolean }): Promise<GitOpResult>
  apply(workspaceRoot: string, ref: string): Promise<GitOpResult>
  pop(workspaceRoot: string, ref: string): Promise<GitOpResult>
  drop(workspaceRoot: string, ref: string): Promise<GitOpResult>
}

export interface DesktopGitBridge {
  probe(): Promise<GitProbeResult>
  subscribe(
    workspaceRoot: string,
    onSnapshot: (snap: GitSnapshot) => void,
  ): Promise<{ ok: boolean; subId?: string; channel?: string; reason?: string }>
  unsubscribe(subId: string, channel: string): Promise<{ ok: boolean; reason?: string }>
  refresh(workspaceRoot: string): Promise<{ ok: boolean; reason?: string }>
  current(workspaceRoot: string): Promise<{ ok: boolean; snapshot?: GitSnapshot; reason?: string }>
  // G2 — project-root registry. Lets useOpenLocalFolder hand the picked
  // folder path to main so resolveProjectRoot succeeds for external
  // (folder-bound) projects without an API round-trip.
  setProjectRoot(projectId: string, root: string): Promise<{ ok: boolean; reason?: string }>
  unsetProjectRoot(projectId: string): Promise<{ ok: boolean; reason?: string }>
  resolveProjectRoot(projectId: string): Promise<{ ok: boolean; root?: string; reason?: string }>
  // G2 — SCM viewlet write surface.
  stage(workspaceRoot: string, paths: string[]): Promise<GitOpResult>
  unstage(workspaceRoot: string, paths: string[]): Promise<GitOpResult>
  discard(workspaceRoot: string, paths: string[]): Promise<GitOpResult>
  commit(workspaceRoot: string, message: string, opts?: CommitOptions): Promise<GitOpResult>
  fileContent(workspaceRoot: string, path: string, ref: string): Promise<{ ok: boolean; content?: string; reason?: string; error?: string }>
  // G3 — sub-objects.
  branches: BranchesBridge
  remotes: RemotesBridge
  stash: StashBridge
  // G4 — per-file diff markers + blame.
  diffMarkers(workspaceRoot: string, path: string, base?: string): Promise<{ ok: boolean; markers?: DiffMarker[]; reason?: string; error?: string }>
  blame(workspaceRoot: string, path: string): Promise<{ ok: boolean; lines?: BlameLine[]; reason?: string; error?: string }>
  // G4.5 — 3-way merge stages + per-hunk revert + streaming progress.
  mergeStages(workspaceRoot: string, path: string): Promise<{ ok: boolean; stages?: { base: string | null; ours: string | null; theirs: string | null; working: string }; reason?: string; error?: string }>
  revertHunk(workspaceRoot: string, path: string, workingStart: number, workingEnd: number, headStart: number | null, headEnd: number | null): Promise<GitOpResult>
  fetchStreaming(workspaceRoot: string, opts: { remote?: string; prune?: boolean; all?: boolean }, onProgress: (p: GitProgressEvent) => void): Promise<GitOutputResult>
  pullStreaming(workspaceRoot: string, opts: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }, onProgress: (p: GitProgressEvent) => void): Promise<GitOutputResult>
  pushStreaming(workspaceRoot: string, opts: { remote?: string; branch?: string; forceWithLease?: boolean; force?: boolean; tags?: boolean; setUpstream?: boolean }, onProgress: (p: GitProgressEvent) => void): Promise<GitOutputResult>
}

export interface GitProgressEvent {
  phase: string
  percent: number | null
  raw: string
}

export function getDesktopGitBridge(): DesktopGitBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { shogoDesktop?: { git?: DesktopGitBridge } }
  const g = w.shogoDesktop?.git
  if (!g) return null
  for (const m of [
    'probe', 'subscribe', 'unsubscribe', 'refresh', 'current',
    'setProjectRoot', 'unsetProjectRoot', 'resolveProjectRoot',
    'stage', 'unstage', 'discard', 'commit', 'fileContent',
    'diffMarkers', 'blame',
    'mergeStages', 'revertHunk', 'fetchStreaming', 'pullStreaming', 'pushStreaming',
  ] as const) {
    if (typeof (g as unknown as Record<string, unknown>)[m] !== 'function') return null
  }
  for (const subKey of ['branches', 'remotes', 'stash'] as const) {
    const sub = (g as unknown as Record<string, unknown>)[subKey]
    if (!sub || typeof sub !== 'object') return null
  }
  return g
}
