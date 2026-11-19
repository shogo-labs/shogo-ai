// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Re-attach a workspace's live history to the durable one (SHO-442).
 *
 * A VM whose `.git` could not be proven to descend from the durable repo is
 * marked UNTRUSTED and, before this, never saved again for the rest of its
 * life — the incident's workspace lost a day and a half that way. The bytes
 * were all there; what was missing was a commit that ties the live tree to the
 * durable history.
 *
 * This builds exactly that commit:
 *
 *   - fetch the durable history (already materialized in `stagingDir`) into a
 *     private ref namespace, so nothing the user has is touched,
 *   - write a commit whose **tree is the current working tree** and whose
 *     parents are `[durableHead, localHead]`,
 *   - move the current branch to it and sync the index.
 *
 * The working tree is never reset, so a busy workspace is fine: no file is
 * rewritten, and `git status` is clean afterwards because the index is set to
 * the new commit's tree.
 */

import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { getShogoAgentEmail, getShogoAgentName, shogoCoAuthorTrailer } from './agent-attribution'
import { spawn } from './child-process'
import { resolveGitDir } from './shogo-state-paths'

export interface ReconcileResult {
  /** The new HEAD: a merge of the durable history and the live one. */
  head: string
  durableHead: string
  /** The live HEAD before the reconcile, or null for an unborn branch. */
  localHead: string | null
  tree: string
}

export class ReconcileError extends Error {}

interface GitRun {
  code: number
  stdout: string
  stderr: string
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      // The identity comes from the environment, not the repo config: CI has no
      // global git identity, and a checkout Shogo only has on loan must not have
      // its `.git/config` rewritten. `commit-tree` is the one call here that
      // needs it — without it the reconcile dies with "Author identity unknown".
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: getShogoAgentName(),
        GIT_AUTHOR_EMAIL: getShogoAgentEmail(),
        GIT_COMMITTER_NAME: getShogoAgentName(),
        GIT_COMMITTER_EMAIL: getShogoAgentEmail(),
        ...(env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (c) => { stdout += String(c) })
    child.stderr?.on('data', (c) => { stderr += String(c) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function must(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const res = await git(cwd, args, env)
  if (res.code !== 0) throw new ReconcileError(`git ${args.join(' ')} failed (${res.code}): ${res.stderr.trim().slice(0, 400)}`)
  return res.stdout.trim()
}

/**
 * Merge the durable history in `stagingDir` into the live repo at
 * `workspaceDir` without touching a single working-tree file.
 */
export async function reconcileRepoHistory(
  workspaceDir: string,
  stagingDir: string,
  opts: { message?: string } = {},
): Promise<ReconcileResult> {
  if (!existsSync(join(workspaceDir, '.git'))) throw new ReconcileError('workspace has no .git')
  if (!existsSync(join(stagingDir, '.git'))) throw new ReconcileError('staging repo has no .git')
  const gitDir = resolveGitDir(workspaceDir)
  if (!gitDir) throw new ReconcileError('workspace has no git dir')

  const durableHead = await must(stagingDir, ['rev-parse', 'HEAD'])

  // Bring the durable objects in under a namespace of our own. `--no-write-fetch-head`
  // keeps FETCH_HEAD out of the user's repo; the refs are only a transport, and
  // are removed again below — a `refs/shogo-durable/*` left behind would be
  // picked up by `for-each-ref` and land in the next durable manifest.
  try {
    await must(workspaceDir, [
      'fetch', '--no-tags', '--no-write-fetch-head', stagingDir,
      '+refs/heads/*:refs/shogo-durable/heads/*',
      '+refs/tags/*:refs/shogo-durable/tags/*',
    ])

    const localHead = await git(workspaceDir, ['rev-parse', '--verify', '--quiet', 'HEAD']).then((r) =>
      r.code === 0 ? r.stdout.trim() || null : null,
    )

    // The tree of the CURRENT working tree, computed in a throwaway index so the
    // user's staged state is untouched.
    const tmpIndex = join(gitDir, 'shogo-reconcile.index')
    rmSync(tmpIndex, { force: true })
    const env = { GIT_INDEX_FILE: tmpIndex }
    let tree: string
    try {
      await must(workspaceDir, ['add', '-A', '--', '.'], env)
      tree = await must(workspaceDir, ['write-tree'], env)
    } finally {
      rmSync(tmpIndex, { force: true })
    }

    const parents = localHead ? ['-p', durableHead, '-p', localHead] : ['-p', durableHead]
    const message =
      (opts.message ??
        `Reconcile with the durable history\n\n` +
          `The workspace was running on a history that could not be proven to descend from the\n` +
          `durable repo. This commit joins the two: its tree is the working tree as it stood,\n` +
          `and its parents are the durable HEAD (${durableHead.slice(0, 12)}) and the live HEAD` +
          `${localHead ? ` (${localHead.slice(0, 12)})` : ''}. No file was changed.`) +
      `\n\n${shogoCoAuthorTrailer()}`
    const head = await must(workspaceDir, ['commit-tree', tree, ...parents, '-m', message])

    // Move the branch (or detached HEAD) forward, then make the index match the
    // new commit so `git status` is clean and the next commit is a no-op.
    const symbolic = await git(workspaceDir, ['symbolic-ref', '--quiet', 'HEAD'])
    const ref = symbolic.code === 0 ? symbolic.stdout.trim() : 'HEAD'
    if (localHead) await must(workspaceDir, ['update-ref', ref, head, localHead])
    else await must(workspaceDir, ['update-ref', ref, head])
    await must(workspaceDir, ['read-tree', head])

    return { head, durableHead, localHead, tree }
  } finally {
    // The transport refs go whether or not the merge landed; the objects they
    // pointed at are still reachable from the merge commit.
    await deleteDurableRefs(workspaceDir)
  }
}

/** Remove the `refs/shogo-durable/*` transport namespace. Best-effort. */
async function deleteDurableRefs(workspaceDir: string): Promise<void> {
  const listing = await git(workspaceDir, ['for-each-ref', '--format=%(refname)', 'refs/shogo-durable/'])
  const refs = listing.stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  for (const ref of refs) await git(workspaceDir, ['update-ref', '-d', ref])
}
