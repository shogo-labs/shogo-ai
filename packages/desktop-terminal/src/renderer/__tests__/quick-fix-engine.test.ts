// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import {
  QuickFixEngine,
  tailLines,
  type QuickFixContext,
  type QuickFixRule,
} from '../quick-fix/quick-fix-engine'
import {
  BUILT_IN_RULES,
  extractGitPathspec,
  extractMissingCommand,
  extractMissingModule,
  extractPort,
} from '../quick-fix/quick-fix-rules'

function ctx(over: Partial<QuickFixContext> = {}): QuickFixContext {
  return {
    commandLine: '',
    outputTail: '',
    cwd: null,
    exitCode: 1,
    ...over,
  }
}

// ─── tailLines ─────────────────────────────────────────────────────

describe('tailLines', () => {
  it('returns the last N non-empty lines joined by newline', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc')
  })
  it('trims trailing blanks before counting', () => {
    expect(tailLines('a\nb\n\n\n', 2)).toBe('a\nb')
  })
  it('handles single-line input', () => {
    expect(tailLines('only line', 3)).toBe('only line')
  })
  it('returns empty for empty input or zero N', () => {
    expect(tailLines('', 5)).toBe('')
    expect(tailLines('a\nb', 0)).toBe('')
  })
  it('handles CRLF line endings', () => {
    expect(tailLines('a\r\nb\r\nc', 2)).toBe('b\nc')
  })
})

// ─── extractors ────────────────────────────────────────────────────

describe('extractPort', () => {
  it.each([
    ['EADDRINUSE: address already in use 0.0.0.0:3000', 3000],
    ['EADDRINUSE: address already in use :::8080', 8080],
    ["Error: listen EADDRINUSE: address already in use 127.0.0.1:5173", 5173],
    ['Port 4321 is in use, trying another one...', 4321],
    ['no port here', null],
    [':99999 is too big', null],
    [':0 too small', null],
  ])('handles %s', (line, expected) => {
    expect(extractPort(line)).toBe(expected as number | null)
  })
})

describe('extractMissingModule', () => {
  it.each([
    [`Error: Cannot find module 'express'`, 'express'],
    [`Cannot find module "@nestjs/core"`, '@nestjs/core'],
    [`Cannot find module 'lodash/fp'`, 'lodash'], // root only
    [`Cannot find module './relative'`, null], // user code
    [`Cannot find module '/absolute/path'`, null],
    [`Cannot find module '@scope/'`, null], // malformed
    ['unrelated message', null],
  ])('handles %s', (line, expected) => {
    expect(extractMissingModule(line)).toBe(expected as string | null)
  })
})

describe('extractMissingCommand', () => {
  it.each([
    ['bash: foo: command not found', 'foo'],
    ['zsh: command not found: bar', 'bar'],
    ['fish: Unknown command: baz', 'baz'],
    [`The term 'qux' is not recognized as the name of a cmdlet`, 'qux'],
    ['nothing to extract', null],
  ])('handles %s', (line, expected) => {
    expect(extractMissingCommand(line)).toBe(expected as string | null)
  })
})

describe('extractGitPathspec', () => {
  it("captures git's pathspec error", () => {
    expect(extractGitPathspec("error: pathspec 'feat/branch' did not match any file(s)"))
      .toBe('feat/branch')
  })
  it('returns null for unrelated output', () => {
    expect(extractGitPathspec('nope')).toBeNull()
  })
})

// ─── engine core ───────────────────────────────────────────────────

const noopRule: QuickFixRule = { id: 'n', label: 'n', matches: () => [] }

describe('QuickFixEngine — evaluation', () => {
  it('returns no suggestions when exitCode is 0', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    expect(e.evaluate(ctx({ exitCode: 0, outputTail: 'EADDRINUSE 3000' }))).toEqual([])
  })

  it('produces a suggestion when a rule matches', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const suggestions = e.evaluate(ctx({
      commandLine: 'npm run dev',
      outputTail: 'EADDRINUSE: address already in use 0.0.0.0:3000',
    }))
    expect(suggestions.length).toBeGreaterThan(0)
    expect(suggestions[0]!.ruleId).toBe('eaddrinuse')
    expect(suggestions[0]!.confidence).toBe('high')
    expect(suggestions[0]!.action.kind).toBe('run')
    expect(suggestions[0]!.action.payload).toContain('lsof -t -i :3000')
    expect(suggestions[0]!.action.payload).toContain('npm run dev')
  })

  it('caps total suggestions to maxSuggestions', () => {
    const multi: QuickFixRule = {
      id: 'multi', label: 'multi',
      matches: () => [
        { ruleId: 'multi', title: '1', confidence: 'low', action: { kind: 'run', payload: 'a' } },
        { ruleId: 'multi', title: '2', confidence: 'low', action: { kind: 'run', payload: 'b' } },
        { ruleId: 'multi', title: '3', confidence: 'low', action: { kind: 'run', payload: 'c' } },
      ],
    }
    const e = new QuickFixEngine({ rules: [multi, multi], maxSuggestions: 4 })
    expect(e.evaluate(ctx({ outputTail: 'x' }))).toHaveLength(4)
  })

  it('isolates a throwing rule (does not break the engine)', () => {
    const bad: QuickFixRule = { id: 'bad', label: 'bad', matches: () => { throw new Error('boom') } }
    const good: QuickFixRule = {
      id: 'good', label: 'good',
      matches: () => [{ ruleId: 'good', title: 'g', confidence: 'high', action: { kind: 'run', payload: 'ok' } }],
    }
    const e = new QuickFixEngine({ rules: [bad, good] })
    const r = e.evaluate(ctx({ outputTail: 'x' }))
    expect(r).toHaveLength(1)
    expect(r[0]!.ruleId).toBe('good')
  })

  it('addRule / removeRule update the table', () => {
    const e = new QuickFixEngine({ rules: [noopRule] })
    e.addRule(noopRule)
    expect(e.listRules()).toHaveLength(2)
    expect(e.removeRule('n')).toBe(2)
    expect(e.listRules()).toHaveLength(0)
  })
})

// ─── built-in rules: scenarios ─────────────────────────────────────

describe('Built-in: git-no-upstream', () => {
  it('matches a git push with no-upstream error', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'git push',
      outputTail: 'fatal: The current branch feat/foo has no upstream branch.\nTo push the current branch and set the remote as upstream',
    }))
    expect(s.find((x) => x.ruleId === 'git-no-upstream')).toMatchObject({
      action: { kind: 'run', payload: 'git push -u origin HEAD' },
    })
  })

  it('does not match unrelated git commands', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'git status',
      outputTail: 'has no upstream branch',
    }))
    expect(s.find((x) => x.ruleId === 'git-no-upstream')).toBeUndefined()
  })
})

describe('Built-in: node-missing-module', () => {
  it('emits a review-first npm install for a missing module', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'node app.js',
      outputTail: "Error: Cannot find module 'express'",
    }))
    const fix = s.find((x) => x.ruleId === 'node-missing-module')!
    expect(fix.action).toEqual({ kind: 'cmdk-fill', payload: 'npm install express' })
    expect(fix.confidence).toBe('medium')
  })
})

describe('Built-in: command-not-found', () => {
  it('returns both an install-doc link AND a cmdk-fill for well-known CLIs', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'gh repo list',
      outputTail: 'zsh: command not found: gh',
    }))
    const links = s.filter((x) => x.action.kind === 'link')
    const fills = s.filter((x) => x.action.kind === 'cmdk-fill')
    expect(links).toHaveLength(1)
    expect(links[0]!.action.payload).toContain('cli.github.com')
    expect(fills.length).toBeGreaterThan(0)
  })

  it('returns only the cmdk-fill for unknown CLIs', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'wibble',
      outputTail: 'bash: wibble: command not found',
    }))
    const links = s.filter((x) => x.action.kind === 'link')
    expect(links).toHaveLength(0)
    expect(s.find((x) => x.ruleId === 'command-not-found')).toBeTruthy()
  })
})

describe('Built-in: permission-denied', () => {
  it('suggests sudo retry for EACCES', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: './install.sh',
      outputTail: 'EACCES: permission denied',
    }))
    const fix = s.find((x) => x.ruleId === 'permission-denied')!
    expect(fix.action).toEqual({ kind: 'cmdk-fill', payload: 'sudo ./install.sh' })
  })

  it('skips when the command was already prefixed with sudo', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'sudo ./install.sh',
      outputTail: 'Permission denied',
    }))
    expect(s.find((x) => x.ruleId === 'permission-denied')).toBeUndefined()
  })
})

describe('Built-in: git-bad-pathspec', () => {
  it('suggests listing branches', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    const s = e.evaluate(ctx({
      commandLine: 'git checkout feat/foobar',
      outputTail: "error: pathspec 'feat/foobar' did not match any file(s) known to git",
    }))
    const fix = s.find((x) => x.ruleId === 'git-bad-pathspec')!
    expect(fix.action).toEqual({ kind: 'cmdk-fill', payload: 'git branch -a' })
  })
})

describe('Built-in rules — non-failure', () => {
  it('returns nothing for successful commands even when patterns "could" match', () => {
    const e = new QuickFixEngine({ rules: BUILT_IN_RULES })
    expect(e.evaluate(ctx({
      exitCode: 0,
      commandLine: 'echo EADDRINUSE',
      outputTail: 'EADDRINUSE 3000',
    }))).toEqual([])
  })

  it('returns nothing for an empty rule set', () => {
    const e = new QuickFixEngine({ rules: [] })
    expect(e.evaluate(ctx({ exitCode: 1, outputTail: 'anything' }))).toEqual([])
  })
})
