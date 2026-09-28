// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { injectCommitTrailer } from '../git-attribution'

const env = {
  SHOGO_AGENT_GIT_NAME: 'Shogo Agent',
  SHOGO_AGENT_GIT_EMAIL: 'agent@shogo.ai',
}

describe('injectCommitTrailer', () => {
  test('adds a trailer to a simple commit', () => {
    expect(injectCommitTrailer('git commit -m "change"', env)).toBe(
      'git commit --trailer "Co-authored-by: Shogo Agent <agent@shogo.ai>" -m "change"',
    )
  })

  test('handles git options, chained commands, and pipes', () => {
    const command = 'git -C app commit -am "one" && git commit --amend; git status | git commit -F msg'
    const result = injectCommitTrailer(command, env)
    expect(result.match(/--trailer/g)?.length).toBe(3)
    expect(result).toContain('git -C app commit --trailer')
    expect(result).toContain('&& git commit --trailer')
    expect(result).toContain('| git commit --trailer')
  })

  test('does not rewrite quoted examples or already-attributed commits', () => {
    const command = [
      'printf "git commit -m example"',
      'git commit --trailer "Co-authored-by: Shogo Agent <agent@shogo.ai>" -m done',
    ].join(' && ')
    expect(injectCommitTrailer(command, env)).toBe(command)
  })

  test('does not rewrite commit-tree or unrelated git commands', () => {
    const command = 'git commit-tree HEAD^{tree} -m tree && git log --grep commit'
    expect(injectCommitTrailer(command, env)).toBe(command)
  })
})
