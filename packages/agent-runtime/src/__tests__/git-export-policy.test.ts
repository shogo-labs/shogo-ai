import { describe, expect, test } from 'bun:test'
import { shouldFlushGitBeforeExport } from '../git-export-policy'

describe('shouldFlushGitBeforeExport', () => {
  test('does not flush while a turn is streaming', () => {
    expect(shouldFlushGitBeforeExport(1)).toBe(false)
    expect(shouldFlushGitBeforeExport(2)).toBe(false)
  })

  test('flushes when the runtime is idle', () => {
    expect(shouldFlushGitBeforeExport(0)).toBe(true)
  })
})
