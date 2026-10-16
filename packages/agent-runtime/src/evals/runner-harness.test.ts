// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { checkAntiPattern, flattenSubagentToolCalls, hasRepeatedIdenticalCalls, subagentCallsFromTaskLog } from './runner'
import { isolatedCredentialEnv } from './local-worker'
import type { ToolCallRecord } from './types'

const call = (name: string, input: Record<string, unknown> = {}, output?: unknown): ToolCallRecord =>
  ({ name, input, output, error: false }) as ToolCallRecord

describe('loop anti-pattern', () => {
  test('three different reads in a row are not a loop', () => {
    const calls = [call('read_file', { path: 'a' }), call('read_file', { path: 'b' }), call('read_file', { path: 'c' })]
    expect(hasRepeatedIdenticalCalls(calls)).toBe(false)
    expect(checkAntiPattern('Loop of repeated tool calls', '', calls)).toBe(false)
  })

  test('the same call three times in a row is', () => {
    const calls = [call('exec', { command: 'curl x' }), call('exec', { command: 'curl x' }), call('exec', { command: 'curl x' })]
    expect(checkAntiPattern('Loop of repeated tool calls', '', calls)).toBe(true)
  })

  test("the runtime's own loop signal counts", () => {
    expect(checkAntiPattern('Tool loop or repeated identical calls', '', [call('exec')], true)).toBe(true)
  })
})

describe('homework over-engineering anti-pattern', () => {
  const pattern = 'homework over-engineering prisma schema'

  test('reading the schema does not trigger it', () => {
    expect(checkAntiPattern(pattern, '', [call('read_file', { path: 'prisma/schema.prisma' }, 'model User { id Int }')])).toBe(false)
  })

  test('writing one model does not either', () => {
    expect(checkAntiPattern(pattern, '', [call('write_file', { path: 'prisma/schema.prisma', content: 'model Assignment {\n  id Int @id\n}' })])).toBe(false)
  })

  test('writing several models does', () => {
    const content = ['Course', 'Assignment', 'Submission'].map((m) => `model ${m} {\n  id Int @id\n}`).join('\n')
    expect(checkAntiPattern(pattern, '', [call('write_file', { path: 'prisma/schema.prisma', content })])).toBe(true)
  })
})

describe('subagent calls collected with wait', () => {
  const log = [
    '[tool] exec {"command":"cat data/team.json"}',
    '',
    '[tool] write_file {"path":"reports/engineering.md","content":"# Eng',
    'The report is at reports/engineering.md.',
  ].join('\n')

  test('task log lines become subagent calls', () => {
    const calls = subagentCallsFromTaskLog(log)
    expect(calls.map((c) => c.name)).toEqual(['exec', 'write_file'])
    expect(calls[0]!.input).toEqual({ command: 'cat data/team.json' })
    expect(JSON.stringify(calls[1]!.input)).toContain('reports/engineering.md')
    expect(calls.every((c) => c.viaSubagent)).toBe(true)
  })

  test('a finished subagent task in a wait result is flattened once', () => {
    const waited = { task_id: 't_1', source: 'subagent', status: 'completed', output: log }
    const nested = flattenSubagentToolCalls([call('wait', {}, waited), call('wait', {}, waited), call('wait', {}, { task_id: 't_2', source: 'shell', output: '[tool] exec {}' })])
    expect(nested.map((c) => c.name)).toEqual(['exec', 'write_file'])
  })
})

describe('isolatedCredentialEnv', () => {
  test('points CLIs and git away from the host logins', () => {
    const env = isolatedCredentialEnv(`/tmp/cred-test-${process.pid}`)
    expect(env.GH_CONFIG_DIR).toContain(`cred-test-${process.pid}`)
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toContain(`cred-test-${process.pid}`)
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_SSH_COMMAND).toContain('IdentityFile=/dev/null')
  })
})
