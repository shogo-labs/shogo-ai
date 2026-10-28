// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from 'bun:test'
import { buildCodeAgentGeneralGuide } from '../code-agent-prompt'

const off = buildCodeAgentGeneralGuide(false)
const on = buildCodeAgentGeneralGuide(true)

describe('coding guide', () => {
  test('without search: no search() examples; exact search goes through exec + rg', () => {
    expect(off).not.toContain('search({')
    expect(off).not.toContain('### search')
    expect(off).not.toContain('`search`')
    expect(off).toContain('### Exact / regex search with ripgrep')
    expect(off).toContain(`exec({ command: "rg -n 'MAX_INPUT_TOKENS'" })`)
  })

  test('with search: the semantic search section is present, and exact search still points at rg', () => {
    expect(on).toContain('### search — Semantic Workspace Search')
    expect(on).toContain('search({ query:')
    expect(on).toContain('When NOT to use search (use `exec` with `rg` instead)')
    expect(on).toContain('Use `search`, `read_file`, and `exec`')
    expect(on).not.toContain('\\`search\\`')
  })

  test('only advertises tools that exist', () => {
    for (const guide of [off, on]) {
      expect(guide).not.toContain('`grep`')
      expect(guide).not.toContain('grep({')
      expect(guide).not.toContain('git_history')
    }
  })

  test('explore section traces values to their source of truth', () => {
    expect(off).toContain('### Explore before you change — trace to the source of truth')
    expect(off).toContain('remove the shadowing and plumb the configured value through')
    expect(off).toContain("`git log -S '<literal>'`")
    expect(off).not.toContain('Explore First — MANDATORY')
  })

  test('root-cause fixes instead of symptom patches', () => {
    expect(off).toContain('Fix the root cause with the smallest change that fully removes it.')
    expect(off).toContain('Add a regression test that fails without the fix.')
    expect(off).toContain('set a non-default value in the test and assert that it takes effect')
    expect(off).toContain('a bug fix is not done until a regression test that fails without the fix passes with it')
    expect(off).toContain('### Large features: outline, then build')
    expect(off).toContain('then build them in this turn')
    expect(off).toContain('A focused change — a bug fix, a rename, a single component — needs no outline')
    expect(off).toContain('Prefer the simplest correct fix.')
    expect(off).toContain('### Minimal footprint, not minimal effort')
    expect(off).not.toContain('Minimal Change Principle')
  })

  test('lists the workaround anti-patterns', () => {
    expect(off).toContain('### Workaround anti-patterns — never propose these as the fix')
    for (const item of [
      'Overriding or shadowing a hardcoded value with another constant',
      'Bumping a limit instead of reading the configured one',
      'Adding a feature flag or env var to bypass broken logic',
      'Special-casing the reported input',
      'Catching and ignoring the error',
      'Duplicating logic instead of fixing the shared function',
    ]) {
      expect(off).toContain(item)
    }
  })
})
