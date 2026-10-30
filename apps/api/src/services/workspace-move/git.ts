// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * How a folder-linked project travels (decision D3).
 *
 * A folder-linked project is the user's own git checkout on the desktop. Copying
 * 2 GB of it to the cloud is both slow and wrong — the cloud cannot push back
 * into that checkout. So when the folder is a git repo *with a remote*, the
 * target clones from that remote on the same branch instead, and the plan step
 * warns about anything that only exists locally (uncommitted files, unpushed
 * commits) because those would be left behind.
 *
 * A folder that is not a repo, or has no remote, is copied file by file.
 */

import { spawnSync } from '@shogo/shared-runtime/child-process'

export interface GitInspection {
  isRepo: boolean
  remote: string | null
  branch: string | null
  /** Changed, staged or untracked paths. */
  dirty: number
  /** Commits the upstream does not have. */
  unpushed: number
  /** Why the re-link is not possible, when it is not. */
  reason?: string
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 })
  if (res.error || res.status !== 0) return { ok: false, out: '' }
  return { ok: true, out: String(res.stdout ?? '').trim() }
}

export function inspectFolderLinkedProject(folderPath: string): GitInspection {
  const base: GitInspection = { isRepo: false, remote: null, branch: null, dirty: 0, unpushed: 0 }
  const inside = git(folderPath, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out !== 'true') {
    return { ...base, reason: 'not-a-git-repository' }
  }
  const remote = git(folderPath, ['remote', 'get-url', 'origin'])
  const branch = git(folderPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const status = git(folderPath, ['status', '--porcelain'])
  const dirty = status.ok && status.out ? status.out.split('\n').filter(Boolean).length : 0
  const ahead = git(folderPath, ['rev-list', '--count', '@{u}..HEAD'])
  const unpushed = ahead.ok ? Number.parseInt(ahead.out, 10) || 0 : 0

  return {
    isRepo: true,
    remote: remote.ok && remote.out ? remote.out : null,
    branch: branch.ok && branch.out ? branch.out : null,
    dirty,
    unpushed,
    reason: remote.ok && remote.out ? undefined : 'no-remote',
  }
}
