// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * workspace-rescue — packing a guest workspace straight off its (mounted)
 * rootfs. Uses real `tar` against a directory laid out like a guest rootfs;
 * the mount itself needs root + a block device, so `withReadOnlyMount` is
 * exercised with a recording runner instead.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { config } from './config'
import { RootfsProvisioner } from './rootfs'
import { packRescuedWorkspace, withReadOnlyMount, type CommandRunner } from './workspace-rescue'

function tarList(file: string): string[] {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
    .split('\n')
    .map((l) => l.replace(/^\.\//, '').replace(/\/$/, ''))
    .filter(Boolean)
}

describe('packRescuedWorkspace', () => {
  let root: string
  let out: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'rescue-root-'))
    out = mkdtempSync(join(tmpdir(), 'rescue-out-'))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(out, { recursive: true, force: true })
  })

  test('packs source without .git or dependency dirs, and .git on its own', async () => {
    const ws = join(root, 'app/workspace')
    mkdirSync(join(ws, 'src'), { recursive: true })
    mkdirSync(join(ws, 'node_modules/react'), { recursive: true })
    mkdirSync(join(ws, 'prisma'), { recursive: true })
    writeFileSync(join(ws, 'src/App.tsx'), 'export default 1')
    writeFileSync(join(ws, 'node_modules/react/index.js'), 'x')
    writeFileSync(join(ws, 'prisma/dev.db'), 'db')
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: ws })

    const r = await packRescuedWorkspace(root, out)

    const src = tarList(r.source!)
    expect(src).toContain('src/App.tsx')
    expect(src).toContain('prisma/dev.db')
    expect(src.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(src.some((p) => p === '.git' || p.startsWith('.git/'))).toBe(false)

    const repo = tarList(r.repo!)
    expect(repo).toContain('.git/HEAD')
    expect(repo.every((p) => p === '.git' || p.startsWith('.git/'))).toBe(true)
  })

  test('no repo archive when the workspace has no .git', async () => {
    mkdirSync(join(root, 'app/workspace'), { recursive: true })
    writeFileSync(join(root, 'app/workspace/index.html'), '<p>')
    const r = await packRescuedWorkspace(root, out)
    expect(r.source).not.toBeNull()
    expect(r.repo).toBeNull()
  })

  test('returns nothing when the rootfs has no workspace', async () => {
    expect(await packRescuedWorkspace(root, out)).toEqual({ source: null, repo: null })
  })

  test('refuses a symlinked workspace (9p mode points at a guest-only path)', async () => {
    mkdirSync(join(root, 'app'), { recursive: true })
    symlinkSync('/host-workspaces/p1', join(root, 'app/workspace'))
    expect(await packRescuedWorkspace(root, out)).toEqual({ source: null, repo: null })
  })
})

describe('withReadOnlyMount', () => {
  test('mounts read-only without journal replay and always unmounts', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'rescue-mnt-'))
    const seen: string[][] = []
    const run: CommandRunner = async (cmd) => {
      seen.push(cmd)
      return { code: 0, stderr: '' }
    }
    try {
      await expect(
        withReadOnlyMount('/dev/mapper/mvm-x', scratch, { loop: false }, async () => {
          throw new Error('pack failed')
        }, run),
      ).rejects.toThrow('pack failed')
      expect(seen[0].slice(0, 5)).toEqual(['mount', '-t', 'ext4', '-o', 'ro,noload'])
      expect(seen.at(-1)?.[0]).toBe('umount')
      expect(readdirSync(scratch)).toEqual([])
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('an image file is loop-mounted', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'rescue-mnt-'))
    const seen: string[][] = []
    try {
      await withReadOnlyMount('/run/vm.rootfs.ext4', scratch, { loop: true }, async () => 1, async (cmd) => {
        seen.push(cmd)
        return { code: 0, stderr: '' }
      })
      expect(seen[0][4]).toBe('loop,ro,noload')
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })
})

describe('RootfsProvisioner.quarantine (file modes)', () => {
  test('moves the image under runDir/quarantine, out of the GC sweep', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'rescue-run-'))
    try {
      const prov = new RootfsProvisioner({ ...config, rootfsCow: 'full', runDir } as typeof config)
      const img = join(runDir, 'fcvm-1.rootfs.ext4')
      writeFileSync(img, 'disk')
      const kept = prov.quarantine(img, 'p1/../x-123')
      expect(kept).toBe(join(runDir, 'quarantine', 'p1_.._x-123.rootfs.ext4'))
      expect(existsSync(img)).toBe(false)
      expect(existsSync(kept!)).toBe(true)
      // The GC only sweeps top-level `*.rootfs.ext4` in runDir.
      expect(readdirSync(runDir).filter((n) => n.endsWith('.rootfs.ext4'))).toEqual([])
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
