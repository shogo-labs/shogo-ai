// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the GitKraken-style graph helpers: getGraph (parents + ref
 * decorations + co-authors), listTags, and getCommitDetail. Uses a real
 * temporary git repo with a branch + merge so topology is exercised.
 *
 * Run: bun test apps/api/src/__tests__/git-service-graph.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import * as gitService from '../services/git.service'

let ws: string

function git(args: string[]): void {
  execFileSync('git', args, { cwd: ws, stdio: 'pipe' })
}

function write(name: string, content: string): void {
  writeFileSync(join(ws, name), content)
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'git-graph-test-'))
  git(['init', '-b', 'main'])
  git(['config', 'user.name', 'Test User'])
  git(['config', 'user.email', 'test@example.com'])
})

afterEach(() => {
  rmSync(ws, { recursive: true, force: true })
})

describe('getGraph', () => {
  test('returns linear history with parents and HEAD ref', async () => {
    write('a.txt', '1')
    git(['add', '-A'])
    git(['commit', '-m', 'first'])
    write('b.txt', '2')
    git(['add', '-A'])
    git(['commit', '-m', 'second'])

    const commits = await gitService.getGraph(ws)
    expect(commits.length).toBe(2)
    // Newest first (date-order).
    expect(commits[0].subject).toBe('second')
    expect(commits[1].subject).toBe('first')
    // second's parent is first.
    expect(commits[0].parents).toEqual([commits[1].sha])
    // first (root) has no parents.
    expect(commits[1].parents).toEqual([])
    // HEAD + branch decoration land on the tip.
    const tipRefs = commits[0].refs
    expect(tipRefs.some((r) => r.type === 'HEAD')).toBe(true)
    expect(tipRefs.some((r) => r.type === 'head' && r.name === 'main')).toBe(true)
  })

  test('captures merge commits with two parents', async () => {
    write('base.txt', 'base')
    git(['add', '-A'])
    git(['commit', '-m', 'base'])
    git(['checkout', '-b', 'feature'])
    write('feat.txt', 'feature')
    git(['add', '-A'])
    git(['commit', '-m', 'feature work'])
    git(['checkout', 'main'])
    write('main.txt', 'main change')
    git(['add', '-A'])
    git(['commit', '-m', 'main work'])
    git(['merge', '--no-ff', 'feature', '-m', 'merge feature'])

    const commits = await gitService.getGraph(ws)
    const merge = commits.find((c) => c.subject === 'merge feature')
    expect(merge).toBeDefined()
    expect(merge!.parents.length).toBe(2)
    // The branch ref should appear somewhere in the graph.
    expect(commits.some((c) => c.refs.some((r) => r.name === 'feature'))).toBe(true)
  })

  test('parses Co-authored-by trailers', async () => {
    write('x.txt', 'x')
    git(['add', '-A'])
    git([
      'commit',
      '-m',
      'pair commit\n\nCo-authored-by: Robin Dev <robin@example.com>',
    ])

    const commits = await gitService.getGraph(ws)
    expect(commits[0].coAuthors).toEqual([
      { name: 'Robin Dev', email: 'robin@example.com' },
    ])
  })
})

describe('listTags', () => {
  test('lists tags', async () => {
    write('a.txt', '1')
    git(['add', '-A'])
    git(['commit', '-m', 'first'])
    git(['tag', 'v1.0.0'])
    const tags = await gitService.listTags(ws)
    expect(tags).toContain('v1.0.0')
  })
})

describe('getCommitDetail', () => {
  test('returns metadata + changed files, including the root commit', async () => {
    write('a.txt', 'one\ntwo\n')
    git(['add', '-A'])
    git(['commit', '-m', 'root commit'])

    const head = (await gitService.getHeadSha(ws))!
    const detail = await gitService.getCommitDetail(ws, head)
    expect(detail).not.toBeNull()
    expect(detail!.subject).toBe('root commit')
    expect(detail!.parents).toEqual([])
    // Root commit still lists its added file (diff vs empty tree).
    expect(detail!.files.some((f) => f.path === 'a.txt' && f.status === 'added')).toBe(true)
  })
})
