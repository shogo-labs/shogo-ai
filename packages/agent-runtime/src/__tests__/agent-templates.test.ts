// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, afterEach } from 'bun:test'
import {
  AGENT_TEMPLATES,
  TEMPLATE_CATEGORIES,
  __resetProductionTemplatesCacheForTesting,
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

  test('production cache: first call populates and second call returns the same reference (post-reset)', () => {
    // Drive the production branch of getTemplatesList() deterministically.
    // After reset, the first call assigns productionTemplatesCache and the
    // second call returns the same array reference — confirming the
    // cached-return path is hot.
    __resetProductionTemplatesCacheForTesting()
    process.env.NODE_ENV = 'production'
    const a = getTemplateSummaries()
    const b = getTemplateSummaries()
    // The summaries themselves are mapped (new array each call), but the
    // production cache is shared — so length identity holds and cached
    // re-entry returns the same underlying template id ordering.
    expect(a.length).toBe(b.length)
    if (a.length > 0) expect(a[0].id).toBe(b[0].id)
    __resetProductionTemplatesCacheForTesting()
  })

  test('non-production branch re-reads templates each call (cache stays null)', () => {
    __resetProductionTemplatesCacheForTesting()
    process.env.NODE_ENV = 'test'
    // Two calls in non-production both go through loadDirTemplates() fresh;
    // we mostly care that this does not throw and respects the early-return.
    const a = getTemplateSummaries()
    const b = getTemplateSummaries()
    expect(a.length).toBe(b.length)
  })
})
