// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Regression tests for OpenAI image-generation param normalization.
 *
 * Reported live on staging: the personal companion's `generate_image` tool
 * (once actually reachable — see the SUBAGENT_ONLY_TOOLS fix) picked
 * `model: "gpt-image-1"` and every request 400'd:
 *
 *   "Unknown parameter: 'response_format'."
 *
 * GPT image models (gpt-image-1, gpt-image-1.5, ...) always return
 * base64-encoded images and reject `response_format` outright, and also use
 * a different `quality` vocabulary ("low"|"medium"|"high"|"auto" instead of
 * dall-e-3's "standard"|"hd") and different portrait/landscape `size` values
 * ("1024x1536"/"1536x1024" instead of dall-e-3's "1024x1792"/"1792x1024").
 * `normalizeQualityForModel`/`normalizeSizeForModel` in ai-proxy.ts translate
 * the dall-e-3-shaped tool params onto the GPT image vocabulary; this file
 * pins that behavior directly (no network / DB mocking needed).
 *
 *   bun test apps/api/src/routes/__tests__/ai-proxy-image-gen-params.test.ts
 */

process.env.AI_PROXY_SECRET = process.env.AI_PROXY_SECRET || 'test-secret-ai-proxy-do-not-use-in-prod'
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET || 'test-better-auth-secret'

import { describe, test, expect } from 'bun:test'
import { normalizeQualityForModel, normalizeSizeForModel } from '../ai-proxy'

describe('normalizeQualityForModel', () => {
  test('passes dall-e-3 quality values through unchanged', () => {
    expect(normalizeQualityForModel('dall-e-3', 'standard')).toBe('standard')
    expect(normalizeQualityForModel('dall-e-3', 'hd')).toBe('hd')
  })

  test('passes dall-e-2 quality values through unchanged', () => {
    expect(normalizeQualityForModel('dall-e-2', 'standard')).toBe('standard')
  })

  test('maps dall-e-3 vocabulary onto GPT image equivalents for gpt-image-1', () => {
    expect(normalizeQualityForModel('gpt-image-1', 'standard')).toBe('medium')
    expect(normalizeQualityForModel('gpt-image-1', 'hd')).toBe('high')
  })

  test('maps dall-e-3 vocabulary onto GPT image equivalents for gpt-image-1.5', () => {
    expect(normalizeQualityForModel('gpt-image-1.5', 'standard')).toBe('medium')
    expect(normalizeQualityForModel('gpt-image-1.5', 'hd')).toBe('high')
  })

  test('passes already-valid GPT image quality values through unchanged', () => {
    expect(normalizeQualityForModel('gpt-image-1', 'low')).toBe('low')
    expect(normalizeQualityForModel('gpt-image-1', 'medium')).toBe('medium')
    expect(normalizeQualityForModel('gpt-image-1', 'high')).toBe('high')
    expect(normalizeQualityForModel('gpt-image-1', 'auto')).toBe('auto')
  })

  test('returns undefined when no quality was requested', () => {
    expect(normalizeQualityForModel('gpt-image-1', undefined)).toBeUndefined()
    expect(normalizeQualityForModel('dall-e-3', undefined)).toBeUndefined()
  })
})

describe('normalizeSizeForModel', () => {
  test('passes dall-e-3 portrait/landscape sizes through unchanged', () => {
    expect(normalizeSizeForModel('dall-e-3', '1024x1792')).toBe('1024x1792')
    expect(normalizeSizeForModel('dall-e-3', '1792x1024')).toBe('1792x1024')
  })

  test('maps dall-e-3 portrait/landscape sizes onto GPT image equivalents', () => {
    expect(normalizeSizeForModel('gpt-image-1', '1024x1792')).toBe('1024x1536')
    expect(normalizeSizeForModel('gpt-image-1', '1792x1024')).toBe('1536x1024')
  })

  test('passes square and already-valid GPT image sizes through unchanged', () => {
    expect(normalizeSizeForModel('gpt-image-1', '1024x1024')).toBe('1024x1024')
    expect(normalizeSizeForModel('gpt-image-1', '1024x1536')).toBe('1024x1536')
    expect(normalizeSizeForModel('gpt-image-1', '1536x1024')).toBe('1536x1024')
  })
})
