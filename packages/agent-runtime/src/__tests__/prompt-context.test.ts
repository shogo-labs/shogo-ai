// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { buildWorkerPrompt, type PromptSection } from '../prompt-context'

const sections: PromptSection[] = [
  { label: 'coding', zone: 'stable', content: 'CODING_GUIDE', audience: 'worker' },
  { label: 'browser', zone: 'stable', content: 'BROWSER_GUIDE', audience: 'worker', requiresTools: ['browser'] },
  { label: 'coordinator', zone: 'stable', content: 'COORDINATOR_GUIDE', audience: 'main' },
  { label: 'project', zone: 'dynamic', content: 'PROJECT_RULES', audience: 'all' },
]

describe('buildWorkerPrompt', () => {
  test('keeps worker-safe sections and filters coordinator-only sections', () => {
    const result = buildWorkerPrompt(sections, ['read_file'])

    expect(result.prompt).toContain('CODING_GUIDE')
    expect(result.prompt).toContain('PROJECT_RULES')
    expect(result.prompt).not.toContain('COORDINATOR_GUIDE')
    expect(result.prompt).not.toContain('BROWSER_GUIDE')
    expect(result.sectionLabels).toEqual(['coding', 'project'])
    expect(result.estimatedTokens).toBeGreaterThan(0)
  })

  test('includes a tool-gated section when the worker has that tool', () => {
    const result = buildWorkerPrompt(sections, ['read_file', 'browser'])

    expect(result.prompt).toContain('BROWSER_GUIDE')
    expect(result.sectionLabels).toEqual(['coding', 'browser', 'project'])
  })

  test('can carry restrictions without inheriting platform sections', () => {
    const result = buildWorkerPrompt(sections, [], 'PLAN_MODE_RULES', false)

    expect(result.prompt).toBe('PLAN_MODE_RULES')
    expect(result.sectionLabels).toEqual([])
  })
})
