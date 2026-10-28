// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QA acceptance for SHO-124 — an agent opens a PR with `gh` and never gets a
 * gateway-authored refusal.
 *
 * The dev's suites exercise `exec` and the tool descriptions in isolation. This
 * file is the gate the card asks QA for: a real `AgentGateway` turn, a real
 * shell, a real `git push` into a local bare repo and a fake `gh` on PATH.
 * Nothing reaches GitHub and no token is needed.
 *
 *  - AC-1: `gh pr create` executed by a turn returns gh's own output, and a
 *    command that only *mentions* the phrase is not refused either.
 *  - AC-3: the system prompt the gateway actually assembles teaches `gh pr
 *    create` and presents `github_create_pr` as an option.
 *  - AC-6: the body written from the repo's own PR template carries the Made
 *    with Shogo footer, so a CLI-opened PR matches a tool-opened one.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { Message } from '@mariozechner/pi-ai'
import type { StreamFn } from '@mariozechner/pi-agent-core'
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai'
import { AgentGateway } from '../gateway'
import { buildTextResponse, buildToolUseResponse } from '../pi-adapter'
import { trustWorkspaceForTests, clearTrustForTests } from './helpers/test-trust'

// realpath first: on macOS /tmp is a symlink, and the workspace path guard
// compares real roots.
const BASE = realpathSync(tmpdir())
const HEAD = 'sho-124-qa'
const PR_URL = 'https://github.com/o/r/pull/7'
const TEMPLATE = readFileSync(new URL('../../../../.github/PULL_REQUEST_TEMPLATE.md', import.meta.url), 'utf8')

let counter = 0
const makeTestDir = () => join(BASE, `qa-sho124-${process.pid}-${++counter}`)

/** Serves canned responses in order and fails loudly if the turn asks for more. */
function strictStream(responses: ReturnType<typeof buildTextResponse>[], seen: Message[][], prompts: string[]): StreamFn {
  return ((_model: any, context: any) => {
    const index = seen.length
    seen.push([...(context.messages as Message[])])
    prompts.push(typeof context.systemPrompt === 'string' ? context.systemPrompt : '')
    const response = responses[index]
    if (!response) throw new Error(`unexpected model call #${index + 1}`)
    const reason = response.content.some((c: any) => c.type === 'toolCall') ? 'toolUse' : 'stop'
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: response })
      stream.push({ type: 'done', reason, message: response })
      stream.end(response)
    })
    return stream as any
  }) as StreamFn
}

const toolResults = (messages: Message[]) =>
  messages
    .filter((m) => m.role === 'toolResult')
    .map((m) => (m as any).content.map((c: any) => (c.type === 'text' ? c.text : '')).join(''))
    .join('\n')

const exec = (id: string, command: string) => ({ name: 'exec', id, arguments: { command } })

describe('SHO-124: a turn opens the PR with gh', () => {
  let gateway: AgentGateway
  let testDir: string
  let binDir: string
  let argvFile: string
  const previousPath = process.env.PATH
  const previousAuto = process.env.AGENT_MAX_AUTO_CONTINUATIONS

  beforeEach(() => {
    testDir = makeTestDir()
    rmSync(testDir, { recursive: true, force: true })
    mkdirSync(join(testDir, 'memory'), { recursive: true })
    mkdirSync(join(testDir, 'skills'), { recursive: true })
    mkdirSync(join(testDir, '.shogo'), { recursive: true })
    mkdirSync(join(testDir, '.github'), { recursive: true })
    mkdirSync(join(testDir, '.tmp'), { recursive: true })
    writeFileSync(join(testDir, '.github/PULL_REQUEST_TEMPLATE.md'), TEMPLATE)
    writeFileSync(join(testDir, 'README.md'), '# Fixture\n\ngit push, then gh pr create.\n')
    writeFileSync(
      join(testDir, 'config.json'),
      JSON.stringify({
        heartbeatInterval: 1800,
        heartbeatEnabled: false,
        quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
        channels: [],
        model: { provider: 'anthropic', name: 'claude-sonnet-4-5' },
      }),
    )
    writeFileSync(join(testDir, 'AGENTS.md'), '# Agent\nYou are a test agent.')

    // A local bare repo as `origin`: the push is real, it just never leaves disk.
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: testDir })
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['config', 'user.name', 'Shogo Agent'],
      ['config', 'user.email', 'agent@shogo.ai'],
      ['add', '-A'],
      ['commit', '-qm', 'fixture'],
      ['init', '-q', '--bare', 'origin.git'],
      ['remote', 'add', 'origin', './origin.git'],
    ]) {
      const out = git(args)
      if (out.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${out.stderr.toString()}`)
    }

    // `gh` is already on PATH inside an agent checkout; here it is a shim that
    // records its argv and prints a PR URL, like a real create would.
    binDir = join(testDir, 'fakebin')
    argvFile = join(testDir, 'gh-argv.txt')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(
      join(binDir, 'gh'),
      `#!/bin/sh\n: > "${argvFile}"\nfor a in "$@"; do printf '%s\\n' "$a" >> "${argvFile}"; done\necho "${PR_URL}"\n`,
      { mode: 0o755 },
    )
    process.env.PATH = `${binDir}:${previousPath}`
    // One loop per prompt: the call count is the assertion.
    process.env.AGENT_MAX_AUTO_CONTINUATIONS = '0'
    trustWorkspaceForTests(testDir)
  })

  afterEach(async () => {
    if (gateway) await gateway.stop()
    clearTrustForTests()
    process.env.PATH = previousPath
    if (previousAuto === undefined) delete process.env.AGENT_MAX_AUTO_CONTINUATIONS
    else process.env.AGENT_MAX_AUTO_CONTINUATIONS = previousAuto
    rmSync(testDir, { recursive: true, force: true })
  })

  test('push, then gh pr create: gh own output comes back and the body carries the footer', async () => {
    const seen: Message[][] = []
    const prompts: string[] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      strictStream(
        [
          // The body is built from the repo's own template — what the prompt
          // tells the agent to do — plus the card line.
          buildToolUseResponse([
            exec(
              'tu_body',
              "mkdir -p .tmp && { cat .github/PULL_REQUEST_TEMPLATE.md; printf '\\nCard: SHO-124\\n'; } > .tmp/pr-body.md",
            ),
          ]),
          buildToolUseResponse([exec('tu_push', `git push -q origin HEAD:refs/heads/${HEAD}`)]),
          buildToolUseResponse([
            exec(
              'tu_pr',
              `gh pr create --repo o/r --base main --head ${HEAD} --title "SHO-124: allow gh" --body-file .tmp/pr-body.md`,
            ),
          ]),
          buildTextResponse(`PR opened: ${PR_URL}`),
        ],
        seen,
        prompts,
      ),
    )
    await gateway.start()

    const chunks: any[] = []
    await gateway.processChatMessageStream('Open the PR for this branch', { write: (c: any) => chunks.push(c) } as any, {
      chatSessionId: 'qa-sho124',
    })

    expect(seen).toHaveLength(4)
    const results = toolResults(seen[3]!)
    // AC-1: the gateway handed gh's own output back, and refused nothing.
    expect(results).toContain(PR_URL)
    expect(results).not.toContain('Use the github_create_pr tool')
    expect(results).not.toContain('Blocked command')

    // The push really happened, and gh got the exact argv the prompt teaches.
    expect(existsSync(join(testDir, 'origin.git', 'refs', 'heads', HEAD))).toBe(true)
    expect(readFileSync(argvFile, 'utf8').trim().split('\n')).toEqual([
      'pr',
      'create',
      '--repo',
      'o/r',
      '--base',
      'main',
      '--head',
      HEAD,
      '--title',
      'SHO-124: allow gh',
      '--body-file',
      '.tmp/pr-body.md',
    ])

    // AC-6: what gh was pointed at carries the standard footer and the card.
    const body = readFileSync(join(testDir, '.tmp/pr-body.md'), 'utf8')
    expect(body).toContain('<!-- made-with-shogo -->')
    expect(body).toContain('Made with [Shogo](https://shogo.ai)')
    expect(body).toContain('Card: SHO-124')

    // AC-3: the prompt the gateway actually assembles is the one that teaches
    // the CLI route — this string, not a doc, is what decides behaviour.
    const systemPrompt = prompts[0] ?? ''
    expect(systemPrompt).toMatch(/Opening a pull request is .{0,12}gh pr create/)
    expect(systemPrompt).toContain('gh pr create --repo <owner>/<repo> --base main --head <branch>')
    expect(systemPrompt).toContain('is optional')
    expect(systemPrompt).not.toContain('except for creating pull requests')
    expect(systemPrompt).not.toContain('that is blocked')
  })

  test('a command that only mentions the phrase runs, in a heredoc as well as an echo', async () => {
    const seen: Message[][] = []
    const prompts: string[] = []
    gateway = new AgentGateway(testDir, 'test-project')
    gateway.setStreamFn(
      strictStream(
        [
          buildToolUseResponse([exec('tu_echo', 'echo "gh pr create --title x"')]),
          buildToolUseResponse([
            exec(
              'tu_heredoc',
              "cat > .tmp/notes.md <<'EOF'\nOpening a PR is `gh pr create --repo o/r --base main`.\nEOF\ncat .tmp/notes.md",
            ),
          ]),
          buildTextResponse('Both ran.'),
        ],
        seen,
        prompts,
      ),
    )
    await gateway.start()

    await gateway.processChatMessageStream('Write the note', { write: () => {} } as any, { chatSessionId: 'qa-sho124-notes' })

    const results = toolResults(seen[2]!)
    expect(results).toContain('gh pr create --title x')
    expect(results).toContain('Opening a PR is `gh pr create --repo o/r --base main`.')
    expect(results).not.toContain('Use the github_create_pr tool')
  })
})
