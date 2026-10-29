// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AgentTool } from '@mariozechner/pi-agent-core'
import { checkReadOnlyCommand, createReadOnlyExecTool, restrictToReadOnlyTools } from '../read-only-command'

const ok = (command: string) => {
  const r = checkReadOnlyCommand(command)
  if (!r.ok) throw new Error(`expected ${command} to be allowed: ${r.reason}`)
  return r.command
}
const reason = (command: string) => {
  const r = checkReadOnlyCommand(command)
  if (r.ok) throw new Error(`expected ${command} to be refused, got ${r.command}`)
  return r.reason
}

describe('checkReadOnlyCommand', () => {
  test('allows the research commands', () => {
    expect(ok("rg -n 'MAX_INPUT_TOKENS' src")).toBe("rg --no-config -n 'MAX_INPUT_TOKENS' src")
    expect(ok('rg -l maxInputTokens -g *.ts')).toBe('rg --no-config -l maxInputTokens -g *.ts')
    expect(ok('ls -la src')).toBe('ls -la src')
    expect(ok('find src -name *.test.ts')).toBe('find src -name *.test.ts')
    expect(ok('wc -l src/a.ts')).toBe('wc -l src/a.ts')
    expect(ok('head -n 20 README.md')).toBe('head -n 20 README.md')
  })

  test('re-quotes arguments so nothing is reinterpreted by the shell', () => {
    expect(ok(`rg "Request failed ("`)).toBe(`rg --no-config 'Request failed ('`)
    expect(ok(`rg 'it'"'"'s'`)).toBe(`rg --no-config 'it'\\''s'`)
    expect(ok('cat my\\ file.ts')).toBe(`cat 'my file.ts'`)
  })

  test('rewrites git to neutralise config-driven programs', () => {
    expect(ok("git log -S 'timeout: 5000' --oneline")).toBe(
      "git --no-pager -c core.fsmonitor=false -c core.pager=cat -c diff.external= log --no-ext-diff --no-textconv -S 'timeout: 5000' --oneline",
    )
    expect(ok('git blame -L 10,20 src/a.ts')).toBe(
      'git --no-pager -c core.fsmonitor=false -c core.pager=cat -c diff.external= blame --no-textconv -L 10,20 src/a.ts',
    )
    expect(ok('git status --short')).toBe('git --no-pager -c core.fsmonitor=false -c core.pager=cat -c diff.external= status --short')
  })

  test('refuses chaining, pipes, redirects and substitutions', () => {
    for (const command of ['rg a | head', 'ls; rm -rf x', 'ls && touch x', 'rg a > out.txt', 'cat < x', 'ls $(pwd)', 'ls `pwd`', 'ls &', 'ls\nrm x']) {
      expect(reason(command)).toContain('is not allowed')
    }
    expect(reason('rg "$HOME"')).toContain('single quotes')
  })

  test('refuses commands outside the allowlist, cd and env assignments', () => {
    for (const command of ['rm -rf src', 'cd src', 'sed -i s/a/b/ x', 'bash -c ls', 'node -e 1', '/bin/rm x', "'rm' x"]) {
      expect(reason(command)).toContain('is not available in read-only mode')
    }
    expect(reason('FOO=1 rg a')).toContain('environment-variable assignments')
  })

  test('refuses flags that run other programs or write files', () => {
    expect(reason('rg --pre cat a')).toContain('--pre')
    expect(reason('rg --pre=./x a')).toContain('--pre')
    expect(reason('rg --pre-glob *.gz a')).toContain('--pre')
    expect(reason('rg -z a')).toContain('-z')
    expect(reason('rg -inz a')).toContain('-z')
    expect(reason('rg --search-zip a')).toContain('-z')
    expect(reason('git -c core.pager=sh log')).toContain('only these git subcommands')
    expect(reason('git -C /etc log')).toContain('only these git subcommands')
    expect(reason('git checkout main')).toContain('only these git subcommands')
    expect(reason('git log -c x')).toContain('-c')
    expect(reason('git diff --ext-diff')).toContain('--ext-diff')
    expect(reason('git show --textconv HEAD')).toContain('--textconv')
    expect(reason('git log --output=x')).toContain('--output')
    expect(reason('git grep -Ovim foo')).toContain('pager')
    for (const action of ['-exec', '-execdir', '-ok', '-delete', '-fprint']) {
      expect(reason(`find . ${action} x`)).toContain(action)
    }
  })

  test('refuses malformed input', () => {
    expect(reason("rg 'abc")).toContain('unterminated')
    expect(reason('rg "abc')).toContain('unterminated')
    expect(reason('   ')).toBe('empty command')
  })
})

describe('createReadOnlyExecTool', () => {
  const ran: string[] = []
  const exec = {
    name: 'exec',
    label: 'Execute Command',
    description: 'Run a shell command.',
    parameters: {},
    execute: async (_id: string, params: any) => {
      ran.push(params.command)
      return { content: [{ type: 'text', text: 'ok' }], details: {} }
    },
  } as unknown as AgentTool

  test('runs approved commands rewritten, refuses the rest without running them', async () => {
    const tool = createReadOnlyExecTool(exec)
    expect(tool.name).toBe('exec')
    expect(tool.description).toContain('read-only')
    const refused = await tool.execute('t1', { command: 'git commit -m x' } as any)
    expect(JSON.stringify(refused.content)).toContain('Read-only mode')
    await tool.execute('t2', { command: 'git log -n 1', timeout: 5000 } as any)
    expect(ran).toEqual(['git --no-pager -c core.fsmonitor=false -c core.pager=cat -c diff.external= log --no-ext-diff --no-textconv -n 1'])
  })

  test('is idempotent, so plan + coordinator restrictions do not double-wrap', async () => {
    const once = createReadOnlyExecTool(exec)
    expect(createReadOnlyExecTool(once)).toBe(once)
    const [restricted] = restrictToReadOnlyTools(restrictToReadOnlyTools([exec], new Set(['exec'])), new Set(['exec']))
    const out = await restricted.execute('t3', { command: 'git status' } as any)
    expect(JSON.stringify(out.content)).not.toContain('Read-only mode')
    expect(ran.at(-1)).toBe('git --no-pager -c core.fsmonitor=false -c core.pager=cat -c diff.external= status')
  })
})

const hasGit = spawnSync('git', ['--version']).status === 0

describe.skipIf(!hasGit || process.platform === 'win32')('git rewrite against a hostile repo config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ro-exec-'))
  const marker = join(dir, 'fsmonitor-ran')
  const hook = join(dir, 'hook.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`)
  chmodSync(hook, 0o755)
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(dir, 'a.txt'), 'hello\n')
  git('add', 'a.txt')
  git('commit', '-q', '-m', 'init')
  git('config', 'core.fsmonitor', hook)
  writeFileSync(join(dir, 'a.txt'), 'changed\n')

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const sh = (command: string) => spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' })

  test('the unguarded command runs the configured fsmonitor program', () => {
    rmSync(marker, { force: true })
    sh('git status --short')
    expect(existsSync(marker)).toBe(true)
  })

  test('the read-only rewrite does not', () => {
    for (const command of ['git status --short', 'git diff', 'git log -p -n 1']) {
      rmSync(marker, { force: true })
      const out = sh(ok(command))
      expect(out.status).toBe(0)
      expect(existsSync(marker)).toBe(false)
    }
  })
})
