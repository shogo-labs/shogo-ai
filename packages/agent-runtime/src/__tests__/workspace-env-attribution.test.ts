// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A project's `.env` is agent-writable, so it must never decide who Shogo is.
 * `loadWorkspaceEnvForAttribution` (gateway-tools) drops a `SHOGO_AGENT_GIT_*`
 * override that is not the canonical identity before the env reaches
 * `injectCommitTrailer`; without that, a line in `.env` would put an arbitrary
 * name on the co-author line.
 *
 * Driven through the real `exec` tool against a real `git` repository, because
 * the helper is module-private and the behaviour that matters is the commit it
 * produces. The temp repo has no hooks of its own, so the only thing that can
 * write the trailer here is `injectCommitTrailer`.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTools, type ToolContext } from '../gateway-tools'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

const CANONICAL = 'Co-authored-by: Shogo Agent <agent@shogo.ai>'

let workspaceDir = ''

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: workspaceDir, encoding: 'utf-8' })
}

function makeCtx(): ToolContext {
  return {
    workspaceDir,
    channels: new Map(),
    config: {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
    } as any,
    projectId: 'test',
  }
}

async function exec(command: string): Promise<any> {
  const tool = createTools(makeCtx()).find((candidate) => candidate.name === 'exec')
  if (!tool) throw new Error('exec tool not found')
  const result = await tool.execute('test-call', { command, timeout: 20_000 })
  return result.details
}

describe('a project .env cannot pick the Shogo co-author', () => {
  beforeEach(() => {
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
    workspaceDir = mkdtempSync(join(tmpdir(), 'env-attribution-'))
    trustWorkspaceForTests(workspaceDir)

    writeFileSync(
      join(workspaceDir, '.env'),
      ['SHOGO_AGENT_GIT_NAME=Evil Bot', 'SHOGO_AGENT_GIT_EMAIL=evil@example.com', 'SOMETHING_ELSE=1', ''].join('\n'),
    )
    writeFileSync(join(workspaceDir, 'file.txt'), 'one\n')
    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.name', 'Shogo Agent'])
    git(['config', 'user.email', 'agent@shogo.ai'])
    git(['add', '-A'])
  })

  afterAll(() => {
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
    clearTrustForTests()
  })

  test('a plain `git commit` keeps the canonical co-author', async () => {
    const result = await exec('git commit -q -m "feat: attributed through exec"')
    expect(result.error).toBeUndefined()

    const message = git(['log', '-1', '--format=%B'])
    expect(message).not.toContain('Evil Bot')
    expect(message.split(CANONICAL).length - 1).toBe(1)
    expect(git(['log', '-1', '--format=%an <%ae>']).trim()).toBe('Shogo Agent <agent@shogo.ai>')
  })
})
