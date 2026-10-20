// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `share_file` in a workspace runtime: the link scope and the signed path come
 * from where the file really lives, so the project-scoped download route
 * resolves it against the project root instead of the merged workspace root
 * (SHO-67).
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveShareFileLinkTarget } from '../share-file-path'

let dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function cleanup() {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
}

describe('resolveShareFileLinkTarget', () => {
  test('a file inside a mounted project is signed relative to that project', () => {
    const root = tempDir('share-path-ws-')
    const project = tempDir('share-path-proj-')
    mkdirSync(join(project, 'out'), { recursive: true })
    writeFileSync(join(project, 'out', 'report.mp4'), 'video')
    symlinkSync(project, join(root, 'proj-a'))

    const target = resolveShareFileLinkTarget({
      workspaceDir: root,
      resolvedPath: join(root, 'proj-a', 'out', 'report.mp4'),
      path: 'proj-a/out/report.mp4',
      requestedProjectId: 'proj-a',
      mountedProjectIds: ['proj-a'],
      workspaceRuntime: true,
    })

    expect(target).toEqual({ projectId: 'proj-a', linkPath: 'out/report.mp4' })
    cleanup()
  })

  test('the file decides the owner, overriding a conflicting project_id', () => {
    const root = tempDir('share-path-ws-')
    const a = tempDir('share-path-a-')
    const b = tempDir('share-path-b-')
    writeFileSync(join(b, 'report.pdf'), 'pdf')
    symlinkSync(a, join(root, 'proj-a'))
    symlinkSync(b, join(root, 'proj-b'))

    const target = resolveShareFileLinkTarget({
      workspaceDir: root,
      resolvedPath: join(root, 'proj-b', 'report.pdf'),
      path: 'proj-b/report.pdf',
      requestedProjectId: 'proj-a',
      mountedProjectIds: ['proj-a', 'proj-b'],
      workspaceRuntime: true,
    })

    expect(target.projectId).toBe('proj-b')
    expect(target.linkPath).toBe('report.pdf')
    expect(target.ignoredProjectId).toBe('proj-a')
    cleanup()
  })

  test('a workspace-root file gets a workspace link even when a project was requested', () => {
    const root = tempDir('share-path-ws-')
    mkdirSync(join(root, 'out'), { recursive: true })
    writeFileSync(join(root, 'out', 'summary.csv'), 'a,b')

    const target = resolveShareFileLinkTarget({
      workspaceDir: root,
      resolvedPath: join(root, 'out', 'summary.csv'),
      path: 'out/summary.csv',
      requestedProjectId: 'proj-a',
      mountedProjectIds: ['proj-a'],
      workspaceRuntime: true,
    })

    expect(target.projectId).toBeUndefined()
    expect(target.linkPath).toBe('out/summary.csv')
    expect(target.ignoredProjectId).toBe('proj-a')
    cleanup()
  })

  test('a project that is not mounted in this runtime is not guessed', () => {
    const root = tempDir('share-path-ws-')
    mkdirSync(join(root, 'loose'), { recursive: true })
    writeFileSync(join(root, 'loose', 'file.txt'), 'x')

    const target = resolveShareFileLinkTarget({
      workspaceDir: root,
      resolvedPath: join(root, 'loose', 'file.txt'),
      path: 'loose/file.txt',
      mountedProjectIds: ['proj-gone'],
      workspaceRuntime: true,
    })

    expect(target.projectId).toBeUndefined()
    expect(target.linkPath).toBe('loose/file.txt')
    cleanup()
  })

  test('a single-project runtime keeps the caller path as-is', () => {
    expect(
      resolveShareFileLinkTarget({
        workspaceDir: '/projects/proj-a',
        resolvedPath: '/projects/proj-a/out/report.pdf',
        path: 'out/report.pdf',
        requestedProjectId: 'proj-a',
        mountedProjectIds: [],
        workspaceRuntime: false,
      }),
    ).toEqual({ projectId: 'proj-a', linkPath: 'out/report.pdf' })
  })

  test('a mount name that is not one path segment is skipped', () => {
    const root = tempDir('share-path-ws-')
    writeFileSync(join(root, 'report.pdf'), 'pdf')

    const target = resolveShareFileLinkTarget({
      workspaceDir: root,
      resolvedPath: join(root, 'report.pdf'),
      path: 'report.pdf',
      mountedProjectIds: ['../escape', 'proj/a'],
      workspaceRuntime: true,
    })

    expect(target.projectId).toBeUndefined()
    expect(target.linkPath).toBe('report.pdf')
    cleanup()
  })
})
