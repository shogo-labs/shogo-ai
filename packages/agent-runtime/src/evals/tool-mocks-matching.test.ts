// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Mock matching semantics the eval fixtures rely on: param-scoped and `re:`
 * matchers, command-word anchoring for CLI mocks, synchronous passthrough,
 * the built-in ask_user default, and fixture date re-anchoring.
 */

import { describe, test, expect } from 'bun:test'
import { buildMockPayload, cliExecMock, cmdRe, shiftFixtureDate, execResult } from './tool-mocks'
import { compileInstallBody, matchesParam } from './tool-mocks-runtime'

function m(params: Record<string, any>, key: string, matcher: string): boolean {
  return matchesParam(params, JSON.stringify(params).toLowerCase(), key, matcher)
}

describe('matchesParam', () => {
  test('substring matches only the named string param', () => {
    expect(m({ command: 'stripe customers list' }, 'command', 'stripe')).toBe(true)
    expect(m({ command: 'curl x', timeout: 'stripe' }, 'command', 'stripe')).toBe(false)
    expect(m({ command: 'STRIPE customers' }, 'command', 'stripe')).toBe(true)
  })

  test('non-string params fall back to the whole params JSON', () => {
    expect(m({ query: 'acme pricing' }, 'url', 'acme')).toBe(true)
    expect(m({ env: { MDB_MCP_CONNECTION_STRING: 'mongodb://x' } }, 'env', 'mongodb://')).toBe(true)
  })

  test('re: is a case-insensitive regex on the named string param only', () => {
    expect(m({ url: 'HTTPS://example.com' }, 'url', 're:^https?://')).toBe(true)
    expect(m({ url: 'ftp://example.com' }, 'url', 're:^https?://')).toBe(false)
    expect(m({ query: 'https://x' }, 'url', 're:^https?://')).toBe(false)
    expect(m({ url: 'x' }, 'url', 're:(')).toBe(false)
  })
})

describe('cmdRe anchoring', () => {
  const gh = cmdRe('gh', 'pr')
  test.each([
    ['gh pr list', true],
    ['cd repo && gh pr list', true],
    ['(gh pr view 1)', true],
    ['/usr/bin/gh pr list', true],
    ['echo high pr', false],
    ['ghpr list', false],
    ['gh issue list', false],
  ])('%s → %p', (command, expected) => {
    expect(m({ command }, 'command', gh)).toBe(expected)
  })
})

describe('cliExecMock', () => {
  const compile = (spec: ReturnType<typeof cliExecMock>) =>
    compileInstallBody({ mocks: { exec: spec }, defaults: { delayMs: 0, jitterMs: 0 } }).fns.exec!

  test('unknown commands pass through synchronously', () => {
    const fn = compile(cliExecMock())
    expect(fn({ command: 'ls -la' })).toBe('__passthrough')
  })

  test('gh, aws and stripe are mocked as unauthenticated', async () => {
    const fn = compile(cliExecMock())
    expect((await fn({ command: 'gh pr list' })).exitCode).toBe(4)
    expect((await fn({ command: 'gh auth status' })).exitCode).toBe(1)
    expect((await fn({ command: 'aws s3 ls' })).exitCode).toBe(253)
    expect((await fn({ command: 'stripe customers list' })).exitCode).toBe(1)
  })

  test('eval-specific arms win over the gh catch-all', async () => {
    const fn = compile(cliExecMock({ patterns: [{ match: { command: cmdRe('gh', 'pr', 'list') }, response: execResult('[]') }] }))
    expect(await fn({ command: 'gh pr list --json number' })).toEqual(execResult('[]'))
  })

  test('authenticated gh answers with the fixture login', async () => {
    const fn = compile(cliExecMock({ gh: { authenticated: true, login: 'acme-corp' } }))
    expect((await fn({ command: 'gh auth status' })).stdout).toContain('acme-corp')
    expect(JSON.parse((await fn({ command: 'gh api user' })).stdout).login).toBe('acme-corp')
  })
})

describe('built-in defaults', () => {
  test('ask_user returns a pending status instead of a fabricated answer', async () => {
    const fn = compileInstallBody({ mocks: buildMockPayload({}), defaults: { delayMs: 0 } }).fns.ask_user!
    expect(await fn({ question: 'Which timezone?' })).toMatchObject({ status: 'pending' })
  })

  test('web passes localhost through and 404s unknown URLs', async () => {
    const fn = compileInstallBody({ mocks: buildMockPayload({}), defaults: { delayMs: 0 } }).fns.web!
    expect(fn({ url: 'http://localhost:3000/api/health' })).toBe('__passthrough')
    expect(fn({ url: 'http://127.0.0.1:8080' })).toBe('__passthrough')
    expect((await fn({ url: 'https://nope.example.com' })).status).toBe(404)
  })

  test('eval mocks override built-ins', () => {
    const payload = buildMockPayload({ exec: { type: 'static', response: 'x' } })
    expect(payload.exec).toEqual({ type: 'static', response: 'x' })
    expect(payload.ask_user).toBeDefined()
  })
})

describe('shiftFixtureDate', () => {
  const today = new Date().toISOString().slice(0, 10)
  const dayBefore = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  test('re-anchors the anchor date to today and keeps the suffix', () => {
    expect(shiftFixtureDate('2026-03-10', '2026-03-10')).toBe(today)
    expect(shiftFixtureDate('2026-03-09T14:15:00Z', '2026-03-10')).toBe(`${dayBefore}T14:15:00Z`)
    expect(shiftFixtureDate('2026-03-10T09:00:00-08:00', '2026-03-10').slice(10)).toBe('T09:00:00-08:00')
  })

  test('keeps relative spacing across month boundaries', () => {
    const a = new Date(shiftFixtureDate('2026-02-27', '2026-03-02'))
    const b = new Date(shiftFixtureDate('2026-03-02', '2026-03-02'))
    expect((b.getTime() - a.getTime()) / 86_400_000).toBe(3)
  })

  test('leaves non-dates alone', () => {
    expect(shiftFixtureDate('yesterday', '2026-03-10')).toBe('yesterday')
    expect(shiftFixtureDate('2026-03-10', 'bad')).toBe('2026-03-10')
  })
})
