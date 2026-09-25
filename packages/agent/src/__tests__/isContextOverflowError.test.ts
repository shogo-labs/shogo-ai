import { describe, expect, it } from 'bun:test'
import { isContextOverflowError } from '../context-overflow'

// Regression test for issue #840:
// isContextOverflowError({ message: 'Input is too long for requested model.' }) returned false
// because the function required 'context' alongside 'too long' in the message.

describe('isContextOverflowError', () => {
  describe('must return true', () => {
    it('HTTP 413 status', () => {
      expect(isContextOverflowError({ status: 413 })).toBe(true)
    })

    it('"prompt is too long" message', () => {
      expect(isContextOverflowError({ message: 'prompt is too long: 250000 tokens > 200000 maximum' })).toBe(true)
    })

    it('"maximum context length" message', () => {
      expect(isContextOverflowError({ message: "This model's maximum context length is 128000 tokens." })).toBe(true)
    })

    it('"request too large" message', () => {
      expect(isContextOverflowError({ message: 'request too large for this model' })).toBe(true)
    })

    it('[REGRESSION #840] Bedrock "Input is too long" without "context" substring', () => {
      expect(isContextOverflowError({ message: 'Input is too long for requested model.' })).toBe(true)
    })

    it('[REGRESSION #840] Bedrock ValidationException prefix', () => {
      expect(isContextOverflowError({ message: 'ValidationException: Input is too long for requested model.' })).toBe(true)
    })

    it('"Too many tokens" gateway variant', () => {
      expect(isContextOverflowError({ message: 'Too many tokens in the input.' })).toBe(true)
    })

    it('"reduce your prompt" OpenAI-compatible gateway', () => {
      expect(isContextOverflowError({ message: 'Please reduce your prompt length.' })).toBe(true)
    })

    it('"context_length_exceeded" error code in message', () => {
      expect(isContextOverflowError({ message: 'context_length_exceeded' })).toBe(true)
    })

    it('"context window overflow" message', () => {
      expect(isContextOverflowError({ message: 'context window overflow' })).toBe(true)
    })
  })

  describe('must return false', () => {
    it('null', () => {
      expect(isContextOverflowError(null)).toBe(false)
    })

    it('network timeout', () => {
      expect(isContextOverflowError({ message: 'network timeout' })).toBe(false)
    })

    it('rate limit exceeded', () => {
      expect(isContextOverflowError({ message: 'rate limit exceeded' })).toBe(false)
    })

    it('invalid api key', () => {
      expect(isContextOverflowError({ message: 'invalid api key' })).toBe(false)
    })

    it('"too long to process" — bare "too long" without specific prefix should NOT match', () => {
      expect(isContextOverflowError({ message: 'too long to process' })).toBe(false)
    })
  })
})
