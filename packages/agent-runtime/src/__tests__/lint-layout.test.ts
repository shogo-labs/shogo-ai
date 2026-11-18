// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-371 part D: `read_lints` warns on layout that will overflow a 390px
 * canvas, instead of Shogo rewriting the app's CSS at phone width.
 *
 *   bun test packages/agent-runtime/src/__tests__/lint-layout.test.ts
 */
import { describe, expect, test } from 'bun:test'
import { scanFileForLayoutWarnings } from '../lint-layout'

const tsx = (body: string) => `export function App() {\n  return (\n${body}\n  )\n}\n`

describe('grid-cols warnings', () => {
  test('warns on a bare grid-cols-3', () => {
    const warnings = scanFileForLayoutWarnings('src/App.tsx', tsx('    <div className="grid grid-cols-3 gap-4" />'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('grid-cols-3')
    expect(warnings[0].line).toBe(3)
  })

  test('stays silent on grid-cols-1 sm:grid-cols-3', () => {
    const warnings = scanFileForLayoutWarnings(
      'src/App.tsx',
      tsx('    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" />'),
    )
    expect(warnings).toEqual([])
  })

  test('stays silent on grid-cols-2 — a 2-up row at 390px is intentional', () => {
    const warnings = scanFileForLayoutWarnings('src/App.tsx', tsx('    <div className="grid grid-cols-2 gap-4" />'))
    expect(warnings).toEqual([])
  })

  test('stays silent on a responsive-only grid', () => {
    const warnings = scanFileForLayoutWarnings('src/App.tsx', tsx('    <div className="grid md:grid-cols-4" />'))
    expect(warnings).toEqual([])
  })

  test('ignores non-JSX files', () => {
    expect(scanFileForLayoutWarnings('src/lib/x.ts', 'const a = "grid grid-cols-4"')).toEqual([])
  })
})

describe('sidebar warnings', () => {
  test('warns on a w-64 sidebar inside a flex h-screen shell with no md:flex-row', () => {
    const warnings = scanFileForLayoutWarnings(
      'src/App.tsx',
      tsx(
        [
          '    <div className="flex h-screen">',
          '      <aside className="w-64 shrink-0" />',
          '      <main className="flex-1" />',
          '    </div>',
        ].join('\n'),
      ),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0].message).toContain('w-64')
    expect(warnings[0].line).toBe(4)
  })

  test('stays silent when the shell stacks with flex-col md:flex-row', () => {
    const warnings = scanFileForLayoutWarnings(
      'src/App.tsx',
      tsx(
        [
          '    <div className="flex flex-col md:flex-row h-screen">',
          '      <aside className="w-64 shrink-0" />',
          '      <main className="flex-1" />',
          '    </div>',
        ].join('\n'),
      ),
    )
    expect(warnings).toEqual([])
  })

  test('stays silent on a fixed width with no viewport shell', () => {
    const warnings = scanFileForLayoutWarnings('src/App.tsx', tsx('    <div className="w-64" />'))
    expect(warnings).toEqual([])
  })
})
