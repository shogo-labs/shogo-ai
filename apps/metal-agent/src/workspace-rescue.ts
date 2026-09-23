// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Host-side recovery of a guest workspace straight from its rootfs.
 *
 * Used when a VM is about to be discarded (wedged / OOM'd / FC process gone)
 * and the guest can no longer answer `/pool/export*`. Its disk still holds
 * every edit made since the last suspend, so the host mounts it read-only and
 * packs the same two artifacts the guest would have produced:
 *   - source: `/app/workspace` minus `.git` and dependency/cache dirs (the
 *     shape of `S3Sync.packProjectArchive`, extracted over WORKSPACE_DIR);
 *   - repo:   `/app/workspace/.git` (the shape of `packRepoArchive`).
 *
 * `noload` skips ext4 journal replay: the guest died without unmounting, and
 * replay would write to a device we only want to read.
 */

import { lstatSync, mkdirSync, mkdtempSync, rmdirSync, statSync } from 'fs'
import { join } from 'path'

export type CommandRunner = (cmd: string[]) => Promise<{ code: number; stderr: string }>

export const runCommand: CommandRunner = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'pipe' })
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  return { code, stderr }
}

/** Path of the guest workspace inside the guest rootfs. */
export const GUEST_WORKSPACE_REL = 'app/workspace'

/** Keep in step with `S3Sync.packProjectArchive`'s excluded dirs. */
export const SOURCE_ARCHIVE_EXCLUDES = ['node_modules', '.expo', '.metro-cache', '.expo-shared']

export interface RescuedArchives {
  /** Source tarball path, or null when the workspace is absent/empty. */
  source: string | null
  /** `.git` tarball path, or null when the workspace has no repo. */
  repo: string | null
}

async function must(run: CommandRunner, cmd: string[]): Promise<void> {
  const r = await run(cmd)
  if (r.code !== 0) throw new Error(`${cmd[0]} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`)
}

/**
 * Pack the workspace found under `mountRoot` (a mounted guest rootfs) into
 * `outDir`. Refuses a symlinked workspace: in 9p-mount mode it points at a
 * guest path that means nothing on the host.
 */
export async function packRescuedWorkspace(
  mountRoot: string,
  outDir: string,
  run: CommandRunner = runCommand,
): Promise<RescuedArchives> {
  const ws = join(mountRoot, GUEST_WORKSPACE_REL)
  let st
  try {
    st = lstatSync(ws)
  } catch {
    return { source: null, repo: null }
  }
  if (!st.isDirectory()) return { source: null, repo: null }

  mkdirSync(outDir, { recursive: true })
  const source = join(outDir, 'source.tar.gz')
  await must(run, [
    'tar',
    '-czf',
    source,
    '-C',
    ws,
    '--exclude=./.git',
    ...SOURCE_ARCHIVE_EXCLUDES.map((d) => `--exclude=${d}`),
    '.',
  ])

  let repo: string | null = null
  try {
    if (statSync(join(ws, '.git')).isDirectory()) {
      repo = join(outDir, 'repo.tar.gz')
      await must(run, ['tar', '-czf', repo, '-C', ws, '.git'])
    }
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err
  }
  return { source, repo }
}

/**
 * Mount `device` read-only at a temp dir under `scratchDir`, run `fn`, and
 * always unmount. `loop` is required for a plain image file (full/reflink
 * rootfs modes); a dm device is a block device already.
 */
export async function withReadOnlyMount<T>(
  device: string,
  scratchDir: string,
  opts: { loop: boolean },
  fn: (mountRoot: string) => Promise<T>,
  run: CommandRunner = runCommand,
): Promise<T> {
  mkdirSync(scratchDir, { recursive: true })
  const mnt = mkdtempSync(join(scratchDir, 'mnt-'))
  try {
    await must(run, ['mount', '-t', 'ext4', '-o', opts.loop ? 'loop,ro,noload' : 'ro,noload', device, mnt])
    try {
      return await fn(mnt)
    } finally {
      await run(['umount', mnt]).catch(() => undefined)
    }
  } finally {
    // Never recursive: if the unmount failed this dir still holds the guest disk.
    try { rmdirSync(mnt) } catch { /* still mounted or already gone */ }
  }
}
