// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pod-side commit metadata gathering.
 *
 * In the pod-owned `git_only` model the pod commits locally and owns the
 * durable repo (see `repo-store.ts`). It no longer pushes to an API-side
 * origin, so the API's post-receive hook can't write the
 * `ProjectCheckpoint` row anymore. Instead, after each commit the pod
 * computes the commit metadata locally (here) and POSTs it to the
 * runtime-authed API endpoint (see agent-runtime's `internal-api.ts`
 * `postCheckpointRecord`), which inserts the row idempotent on commitSha.
 */

import { spawn } from 'child_process'

export interface CommitMeta {
  sha: string
  message: string
  branch: string
  filesChanged: number
  additions: number
  deletions: number
}

function git(args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (c) => { stdout += String(c) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

/** Gather the metadata an API checkpoint row needs for `sha`. */
export async function gatherCommitMeta(workspaceDir: string, sha: string): Promise<CommitMeta | null> {
  const msg = await git(['log', '-1', '--format=%B', sha], workspaceDir).catch(() => null)
  if (!msg || msg.code !== 0) return null
  const branchRes = await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspaceDir).catch(() => null)
  const branch = branchRes && branchRes.code === 0 ? branchRes.stdout.trim() : 'main'

  // `--numstat` against the first parent (or the empty tree for the root
  // commit) yields `additions\tdeletions\tpath` per changed file.
  const stat = await git(['show', '--numstat', '--format=', sha], workspaceDir).catch(() => null)
  let filesChanged = 0
  let additions = 0
  let deletions = 0
  if (stat && stat.code === 0) {
    for (const line of stat.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [add, del] = trimmed.split('\t')
      filesChanged++
      // Binary files report `-` for add/del; treat as 0.
      additions += /^\d+$/.test(add) ? parseInt(add, 10) : 0
      deletions += /^\d+$/.test(del) ? parseInt(del, 10) : 0
    }
  }

  return {
    sha,
    message: (msg.stdout || '').trim() || '(no message)',
    branch: branch || 'main',
    filesChanged,
    additions,
    deletions,
  }
}
