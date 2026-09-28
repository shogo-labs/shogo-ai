// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  shogoCoAuthorTrailer,
  withShogoCommitTrailer,
  withShogoPrFooter,
} from '../agent-attribution'

describe('agent attribution', () => {
  test('builds a co-author trailer from the configured identity', () => {
    expect(shogoCoAuthorTrailer({
      SHOGO_AGENT_GIT_NAME: 'Shogo CI',
      SHOGO_AGENT_GIT_EMAIL: 'ci@shogo.ai',
    })).toBe('Co-authored-by: Shogo CI <ci@shogo.ai>')
  })

  test('adds the trailer only to commit arguments', () => {
    const env = { SHOGO_AGENT_GIT_NAME: 'Shogo Agent', SHOGO_AGENT_GIT_EMAIL: 'agent@shogo.ai' }
    expect(withShogoCommitTrailer(['commit', '-m', 'change'], env)).toEqual([
      'commit',
      '-m',
      'change',
      '--trailer',
      'Co-authored-by: Shogo Agent <agent@shogo.ai>',
    ])
    expect(withShogoCommitTrailer(['status'], env)).toEqual(['status'])
    expect(withShogoCommitTrailer([
      'commit',
      '--trailer',
      'Co-authored-by: Shogo Agent <agent@shogo.ai>',
    ], env)).toEqual([
      'commit',
      '--trailer',
      'Co-authored-by: Shogo Agent <agent@shogo.ai>',
    ])
  })

  test('adds an idempotent Made with Shogo footer', () => {
    const body = withShogoPrFooter('Summary of the change')
    expect(body).toContain('Made with [Shogo](https://shogo.ai)')
    expect(withShogoPrFooter(body)).toBe(body)
  })
})
