// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-616 — `shogo generate` must never run as a chat prompt.
 *
 * Two packages publish a `shogo` bin (`@shogo-ai/sdk` and this worker), and the
 * worker's default command is `chat`. So `bun x shogo generate` in a folder
 * without a project-local `.bin/shogo` became a paid one-shot agent turn whose
 * prompt was the literal word "generate". The guard refuses a lone SDK
 * subcommand name and points at what the user meant; `-p` and multi-word
 * prompts behave exactly as before.
 */
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  sdkSubcommandRedirect,
  sdkSubcommandAsPromptMessage,
  SDK_SUBCOMMANDS,
} from '../prompt-guard.ts'

const CLI = join(import.meta.dir, '..', '..', 'cli.ts')

let home: string
beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'sho616-worker-home-'))
})
afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})

/**
 * Run the real CLI in a throwaway HOME with no key and no runtime binary, so a
 * prompt that reaches `runAgent` fails fast (exit 1, `✗ …`) without any network
 * or agent turn — while one blocked by the guard exits 2 in the same window.
 */
function runCli(args: string[]) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      SHOGO_API_KEY: '',
      SHOGO_CLOUD_URL: '',
      SHOGO_RUNTIME_BIN: '',
    },
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('sdkSubcommandRedirect', () => {
  test('a lone SDK subcommand is refused, with the how-to', () => {
    const msg = sdkSubcommandRedirect(['generate'], {})
    expect(msg).toBe(
      '"shogo generate" is a @shogo-ai/sdk command, not a prompt. ' +
        'In a Shogo project run `bun run generate`. To send it to the agent: shogo -p generate',
    )
  })

  test('every SDK subcommand name is refused', () => {
    for (const word of SDK_SUBCOMMANDS) {
      expect(sdkSubcommandRedirect([word], {})).toBe(sdkSubcommandAsPromptMessage(word))
    }
  })

  test('case and surrounding whitespace do not get around it', () => {
    expect(sdkSubcommandRedirect([' Generate '], {})).not.toBeNull()
    expect(sdkSubcommandRedirect(['DEPLOY'], {})).not.toBeNull()
  })

  test('`-p generate` is an explicit prompt and passes through', () => {
    expect(sdkSubcommandRedirect(['generate'], { print: 'generate' })).toBeNull()
  })

  test('multi-word prompts are prompts', () => {
    expect(sdkSubcommandRedirect(['fix', 'the', 'bug'], {})).toBeNull()
    expect(sdkSubcommandRedirect(['generate', 'the', 'weekly', 'report'], {})).toBeNull()
  })

  test('anything that is not a subcommand passes through', () => {
    expect(sdkSubcommandRedirect([], {})).toBeNull()
    expect(sdkSubcommandRedirect(['hello'], {})).toBeNull()
  })
})

describe('the CLI itself', () => {
  test('`shogo generate` exits 2 and starts no agent turn', () => {
    const { status, stdout, stderr } = runCli(['generate'])
    expect(status).toBe(2)
    expect(stderr).toContain('is a @shogo-ai/sdk command, not a prompt')
    expect(stderr).toContain('bun run generate')
    // `handle()`'s failure prefix only appears once runAgent has been called.
    expect(stderr).not.toContain('✗')
    expect(stdout).not.toContain('shogo generate')
  }, 60_000)

  test('`shogo fix the bug` still reaches runAgent', () => {
    const { status, stderr } = runCli(['fix', 'the', 'bug'])
    // Reached the agent path (no key in this HOME) — not the subcommand guard.
    expect(status).not.toBe(2)
    expect(stderr).not.toContain('is a @shogo-ai/sdk command, not a prompt')
  }, 60_000)

  test('`shogo -p generate` still reaches runAgent', () => {
    const { status, stderr } = runCli(['-p', 'generate'])
    expect(status).not.toBe(2)
    expect(stderr).not.toContain('is a @shogo-ai/sdk command, not a prompt')
  }, 60_000)
})
