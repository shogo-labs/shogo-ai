// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for isContextOverflowError — includes provider-specific messages
 * that do NOT contain the word "context".
 *
 * Run: bun test packages/agent/src/__tests__/context-overflow.test.ts
 */
import { describe, test, expect } from 'bun:test'
import { isContextOverflowError } from '../context-overflow-error'

describe('isContextOverflowError', () => {
  // ── Already-working (regression) cases ─────────────────────────────────────
  test('null/undefined → false', () => {
    expect(isContextOverflowError(null)).toBe(false)
    expect(isContextOverflowError(undefined)).toBe(false)
  })

  test('status 413 → true', () => {
    expect(isContextOverflowError({ status: 413 })).toBe(true)
    expect(isContextOverflowError({ statusCode: 413 })).toBe(true)
  })

  test('"context overflow" message → true', () => {
    expect(isContextOverflowError(new Error('context overflow'))).toBe(true)
  })

  test('"context too long" message → true', () => {
    expect(isContextOverflowError(new Error('context too long'))).toBe(true)
  })

  test('"context length exceed" message → true', () => {
    expect(isContextOverflowError(new Error('context length exceed'))).toBe(true)
  })

  test('"prompt is too long" → true', () => {
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(true)
  })

  test('"maximum context length" → true', () => {
    expect(isContextOverflowError(new Error('maximum context length exceeded'))).toBe(true)
  })

  test('"request too large" → true', () => {
    expect(isContextOverflowError(new Error('request too large'))).toBe(true)
  })

  test('unrelated error → false', () => {
    expect(isContextOverflowError(new Error('network timeout'))).toBe(false)
    expect(isContextOverflowError(new Error('unauthorized'))).toBe(false)
  })

  // ── New provider-specific cases (must FAIL before fix) ─────────────────────
  test('AWS Bedrock: "Input is too long for requested model." → true', () => {
    expect(isContextOverflowError(new Error('Input is too long for requested model.'))).toBe(true)
  })

  test('Google Vertex AI: "Request payload size exceeds the limit" → true', () => {
    expect(isContextOverflowError(new Error('Request payload size exceeds the limit'))).toBe(true)
  })

  test('Cohere: "total number of tokens must be at most 4096" → true', () => {
    expect(isContextOverflowError(new Error('total number of tokens must be at most 4096'))).toBe(true)
  })

  test('Generic: "input length exceeds model limit" → true', () => {
    expect(isContextOverflowError(new Error('input length exceeds model limit'))).toBe(true)
  })

  test('tokens exceed pattern: "12000 tokens exceed context limit" → true (via existing rule)', () => {
    // This already matches via msg.includes('context') && msg.includes('exceed')
    expect(isContextOverflowError(new Error('12000 tokens exceed context limit'))).toBe(true)
  })

  test('tokens exceed without context keyword: "tokens exceed model capacity" → true', () => {
    expect(isContextOverflowError(new Error('tokens exceed model capacity'))).toBe(true)
  })
})
