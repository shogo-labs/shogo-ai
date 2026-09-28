// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBranches } from '../branches'
import { runGit } from '../repository'

const tempRepos: string[] = []

afterEach(async () => {
  await Promise.all(tempRepos.splice(0).map((repo) => rm(repo, { recursive: true, force: true })))
})

describe('listBranches', () => {
  test('lists branches from a git repository', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'shogo-git-branches-'))
    tempRepos.push(repo)

    expect((await runGit(['init', '-q'], { cwd: repo })).ok).toBe(true)
    expect(
      (
        await runGit(
          [
            '-c',
            'user.name=Shogo Test',
            '-c',
            'user.email=test@example.com',
            'commit',
            '--allow-empty',
            '-m',
            'initial',
          ],
          { cwd: repo },
        )
      ).ok,
    ).toBe(true)

    await expect(listBranches(repo)).resolves.toMatchObject({
      ok: true,
      branches: expect.arrayContaining([
        expect.objectContaining({
          isHead: true,
          isRemote: false,
        }),
      ]),
    })
  })
})
