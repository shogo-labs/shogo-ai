// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * AC7: how a folder-linked project travels (decision D3).
 *
 * A folder that is a git repo with a remote is re-linked — the target clones the
 * remote on the same branch instead of copying 2 GB of checkout — and the plan
 * warns about whatever only exists on the source machine. Everything else is
 * copied. This file had no coverage at all, which is how the re-link path could
 * regress without any test noticing.
 *
 * A local bare repo stands in for the remote, so this runs offline and fast.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from '@shogo/shared-runtime/child-process'
import { inspectFolderLinkedProject } from '../git'
import { relinkTargetProject } from '../receive'
import { WorkspaceMoveError } from '../types'

const ROOT = mkdtempSync(join(tmpdir(), 'sho246-git-'))
const BASE = join(ROOT, 'workspaces')
const REMOTE = join(ROOT, 'remote.git')
const REPO = join(ROOT, 'checkout')
/**
 * The URL the re-link path is asked to clone.
 *
 * SEC-18 allows only `https:` remotes (a caller-chosen scheme could be `file:`,
 * `ssh:` or `ext::`), so the local bare repo is reached through git's
 * `url.<base>.insteadOf` rewrite instead of by handing the service a path. The
 * service still sees — and validates — a plain https URL, and the clone still
 * runs offline.
 */
const REMOTE_URL = 'https://example.invalid/sho246/remote.git'

/** Every git call in this file, with the identity set so commits never prompt. */
function git(cwd: string, args: string[]) {
  const res = spawnSync('git', ['-c', 'user.email=sho246@example.com', '-c', 'user.name=Sho246', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(res.stderr ?? '')}`)
  return String(res.stdout ?? '').trim()
}

beforeAll(() => {
  mkdirSync(BASE, { recursive: true })
  // `relinkTargetProject` resolves the target dir from this, not from a caller.
  process.env.WORKSPACES_DIR = BASE

  git(ROOT, ['init', '--bare', REMOTE])
  git(ROOT, ['init', '-b', 'main', REPO])
  writeFileSync(join(REPO, 'README.md'), '# from the remote\n')
  git(REPO, ['add', '.'])
  git(REPO, ['commit', '-m', 'first'])
  git(REPO, ['remote', 'add', 'origin', REMOTE])
  git(REPO, ['push', '-u', 'origin', 'main'])

  // `git clone https://…` resolves to the local bare repo above (see REMOTE_URL).
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.${REMOTE}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = REMOTE_URL
})

afterAll(() => {
  delete process.env.WORKSPACES_DIR
  delete process.env.GIT_CONFIG_COUNT
  delete process.env.GIT_CONFIG_KEY_0
  delete process.env.GIT_CONFIG_VALUE_0
  rmSync(ROOT, { recursive: true, force: true })
})

describe('inspecting a folder-linked project', () => {
  test('a clean checkout on a pushed branch needs no warning', () => {
    const state = inspectFolderLinkedProject(REPO)
    expect({ isRepo: state.isRepo, remote: state.remote, branch: state.branch }).toEqual({
      isRepo: true,
      remote: REMOTE,
      branch: 'main',
    })
    expect({ dirty: state.dirty, unpushed: state.unpushed, reason: state.reason }).toEqual({
      dirty: 0,
      unpushed: 0,
      reason: undefined,
    })
  })

  test('an uncommitted file is counted, because the clone would not have it', () => {
    const scratch = join(REPO, 'notes.txt')
    writeFileSync(scratch, 'only on this machine\n')
    try {
      expect(inspectFolderLinkedProject(REPO).dirty).toBe(1)
    } finally {
      rmSync(scratch)
    }
  })

  test('a commit the remote does not have is counted', () => {
    writeFileSync(join(REPO, 'local-only.txt'), 'unpushed\n')
    git(REPO, ['add', '.'])
    git(REPO, ['commit', '-m', 'local only'])
    try {
      const state = inspectFolderLinkedProject(REPO)
      expect(state.unpushed).toBe(1)
      // The dirty file is now committed, so only the unpushed count speaks.
      expect(state.dirty).toBe(0)
    } finally {
      // Leave the checkout clean and level with its remote again.
      git(REPO, ['reset', '--hard', 'origin/main'])
    }
  })

  test('a plain directory is not a repo, and says why', () => {
    const plain = join(ROOT, 'plain')
    mkdirSync(plain, { recursive: true })
    expect(inspectFolderLinkedProject(plain)).toEqual({
      isRepo: false,
      remote: null,
      branch: null,
      dirty: 0,
      unpushed: 0,
      reason: 'not-a-git-repository',
    })
  })

  test('a repo with no remote is a repo, but cannot be re-linked', () => {
    const local = join(ROOT, 'no-remote')
    git(ROOT, ['init', '-b', 'main', local])
    writeFileSync(join(local, 'a.txt'), 'a\n')
    git(local, ['add', '.'])
    git(local, ['commit', '-m', 'first'])
    const state = inspectFolderLinkedProject(local)
    expect({ isRepo: state.isRepo, remote: state.remote, reason: state.reason }).toEqual({
      isRepo: true,
      remote: null,
      reason: 'no-remote',
    })
  })
})

describe('re-linking at the target', () => {
  test('clones the same branch from the remote and records the folder', async () => {
    const created: any[] = []
    const db = {
      projectFolder: {
        create: async ({ data }: any) => {
          created.push(data)
          return data
        },
      },
    }

    const { path } = await relinkTargetProject(db, {
      projectId: 'proj-relinked',
      name: 'site',
      remote: REMOTE_URL,
      branch: 'main',
      workspaceId: 'ws-target',
    })

    expect(path).toBe(join(BASE, 'proj-relinked'))
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('# from the remote\n')
    expect(created).toEqual([{ projectId: 'proj-relinked', path, isPrimary: true }])
    // And nothing was copied from the source checkout.
    expect(existsSync(join(path, 'local-only.txt'))).toBe(false)
  })

  test('a remote that cannot be cloned fails the move, naming the reason', async () => {
    const db = { projectFolder: { create: async ({ data }: any) => data } }
    const err = await relinkTargetProject(db, {
      projectId: 'proj-bad-remote',
      name: 'site',
      // A closed port, not a path: the scheme rule above allows only https, so
      // the failure has to come from git rather than from validation.
      remote: 'https://127.0.0.1:1/nope.git',
      branch: 'main',
      workspaceId: 'ws-target',
    }).catch((e) => e)

    expect(err).toBeInstanceOf(WorkspaceMoveError)
    expect({ status: err.status, code: err.code }).toEqual({ status: 502, code: 'workspace_move_clone_failed' })
    // The workspace is not left pointing at a folder that was never created.
    expect(existsSync(join(BASE, 'proj-bad-remote', 'README.md'))).toBe(false)
  })
})
