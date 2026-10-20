// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  agentIdentityFromConfig,
  getShogoAgentEmail,
  isShogoAgentIdentity,
  normalizeAgentAttribution,
  shogoCoAuthorTrailer,
  withShogoCommitTrailer,
  withShogoPrFooter,
} from '../agent-attribution'

const env = {
  SHOGO_AGENT_GIT_NAME: 'Shogo Agent',
  SHOGO_AGENT_GIT_EMAIL: 'agent@shogo.ai',
}
const canonical = 'Co-authored-by: Shogo Agent <agent@shogo.ai>'

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

describe('agent identity', () => {
  test('recognizes every Shogo address, not just the canonical one', () => {
    for (const email of ['agent@shogo.ai', 'noreply@shogo.ai', 'dev2@shogo.local', 'qa@shogo.local']) {
      expect(isShogoAgentIdentity('Shogo Dev 2', email)).toBe(true)
    }
    expect(isShogoAgentIdentity('Russell LaCour', 'russelllacour@gmail.com')).toBe(false)
    expect(isShogoAgentIdentity('Cursor', 'cursoragent@cursor.com')).toBe(false)
    expect(isShogoAgentIdentity('Shogo Technologies', 'legal@example.com')).toBe(false)
  })

  test('resolves the identity a checkout commits as', () => {
    expect(agentIdentityFromConfig('dev2@shogo.local')).toEqual({
      name: 'Shogo Agent',
      email: 'agent@shogo.ai',
    })
    expect(agentIdentityFromConfig('russelllacour@gmail.com')).toBeNull()
    expect(agentIdentityFromConfig('')).toBeNull()
  })

  test('ignores a SHOGO_AGENT_GIT_EMAIL override that is not an agent address', () => {
    expect(getShogoAgentEmail({ SHOGO_AGENT_GIT_EMAIL: 'dev2@shogo.local' })).toBe('dev2@shogo.local')
    expect(getShogoAgentEmail({ SHOGO_AGENT_GIT_EMAIL: 'someone@gmail.com' })).toBe('agent@shogo.ai')
  })
})

describe('normalizeAgentAttribution', () => {
  test('appends the canonical co-author to a message without one', () => {
    expect(normalizeAgentAttribution('fix(commit): attribute the agent', env)).toEqual({
      message: `fix(commit): attribute the agent\n\n${canonical}`,
      changed: true,
    })
  })

  test('replaces a wrong Shogo co-author instead of adding a second line', () => {
    const result = normalizeAgentAttribution(
      `fix: thing\n\nCo-authored-by: Shogo Dev 2 <dev2@shogo.local>`,
      env,
    )
    expect(result.message).toBe(`fix: thing\n\n${canonical}`)
    expect(result.changed).toBe(true)
  })

  test('collapses duplicates and the noreply identity into one canonical trailer', () => {
    const result = normalizeAgentAttribution(
      `fix: thing\n\nCo-authored-by: Shogo <noreply@shogo.ai>\nCo-authored-by: Shogo Agent <agent@shogo.ai>`,
      env,
    )
    expect(result.message).toBe(`fix: thing\n\n${canonical}`)
  })

  test('leaves a human or another tool co-author alone', () => {
    const message = `fix: thing\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Russell LaCour <russelllacour@gmail.com>`
    const result = normalizeAgentAttribution(message, env)
    expect(result.message).toBe(
      `fix: thing\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Russell LaCour <russelllacour@gmail.com>\n${canonical}`,
    )
  })

  test('is idempotent', () => {
    const once = normalizeAgentAttribution('feat: thing', env)
    expect(normalizeAgentAttribution(once.message, env)).toEqual({ message: once.message, changed: false })
  })

  test('keeps a multi-paragraph body from a -F message intact', () => {
    const body = [
      'feat(scope): add the thing',
      '',
      'A long explanation.',
      '',
      '- bullet one',
      '- bullet two',
    ].join('\n')
    const result = normalizeAgentAttribution(`${body}\n`, env)
    expect(result.message).toBe(`${body}\n\n${canonical}\n`)
  })

  test('does not attribute an empty message', () => {
    expect(normalizeAgentAttribution('\n\n', env)).toEqual({ message: '\n\n', changed: false })
  })
})

describe('withShogoCommitTrailer', () => {
  test('repairs a caller-written co-author in -m instead of keeping it', () => {
    const args = withShogoCommitTrailer(
      ['commit', '-m', 'fix: thing\n\nCo-authored-by: Shogo Dev 2 <dev2@shogo.local>'],
      env,
    )
    expect(args).toEqual(['commit', '-m', 'fix: thing', '--trailer', canonical])
    expect(args.filter((arg) => arg.includes('dev2@shogo.local'))).toEqual([])
  })

  test('repairs --message=… as well', () => {
    expect(
      withShogoCommitTrailer(['commit', `--message=fix: thing\n\nCo-authored-by: Shogo <noreply@shogo.ai>`], env),
    ).toEqual(['commit', '--message=fix: thing', '--trailer', canonical])
  })

  test('tolerates a missing message value instead of throwing', () => {
    // `commit()` reaches this with an undefined message when a caller uses the
    // API's legacy positional signature, so the array has an undefined element.
    expect(withShogoCommitTrailer(['commit', '-m', undefined as any], env)).toEqual([
      'commit',
      '-m',
      undefined,
      '--trailer',
      canonical,
    ] as unknown as string[])
    expect(withShogoCommitTrailer(['commit', '-m'], env)).toEqual(['commit', '-m', '--trailer', canonical])
  })
})
