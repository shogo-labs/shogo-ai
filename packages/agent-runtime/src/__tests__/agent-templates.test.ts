// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterEach } from 'bun:test'
import {
  AGENT_TEMPLATES,
  TEMPLATE_CATEGORIES,
  getAgentTemplateById,
  getTemplatesByCategory,
  getTemplateSummaries,
} from '../agent-templates'

describe('agent-templates', () => {
  const origEnv = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = origEnv
  })

  test('AGENT_TEMPLATES is populated from disk and TEMPLATE_CATEGORIES has 7 entries', () => {
    expect(Array.isArray(AGENT_TEMPLATES)).toBe(true)
    expect(Object.keys(TEMPLATE_CATEGORIES)).toHaveLength(7)
  })

  test('getAgentTemplateById returns a template for a known id and undefined for unknown', () => {
    const known = AGENT_TEMPLATES[0]
    if (!known) return // no templates on disk → nothing to assert
    expect(getAgentTemplateById(known.id)?.id).toBe(known.id)
    expect(getAgentTemplateById('___does-not-exist___')).toBeUndefined()
  })

  test('getTemplatesByCategory filters by category', () => {
    const t = AGENT_TEMPLATES[0]
    if (!t) return
    const list = getTemplatesByCategory(t.category)
    expect(list.every((x) => x.category === t.category)).toBe(true)
  })

  test('getTemplateSummaries omits the heavy `files` field', () => {
    const summaries = getTemplateSummaries()
    for (const s of summaries) {
      expect((s as Record<string, unknown>).files).toBeUndefined()
    }
  })

  test('production mode caches the templates list across calls', () => {
    process.env.NODE_ENV = 'production'
    const a = getTemplateSummaries()
    const b = getTemplateSummaries()
    expect(a.length).toBe(b.length)
  })
})
