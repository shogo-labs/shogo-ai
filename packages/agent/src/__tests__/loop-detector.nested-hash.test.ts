// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tool results are usually `{ content: [{ type, text }] }`. The cycle check
 * treats changing outputs as progress, so nested fields must reach the hash —
 * otherwise every result looks identical and edit→test iterations with
 * different test output get flagged as a loop.
 */
import { describe, test, expect } from 'bun:test'
import { LoopDetector } from '../loop-detector'

const toolResult = (text: string) => ({ content: [{ type: 'text', text }] })

describe('LoopDetector — nested tool result payloads', () => {
  test('edit→test cycle with changing nested output is progress', () => {
    const d = new LoopDetector()
    for (let i = 0; i < 6; i++) {
      const edit = d.recordAndCheck('edit_file', { path: 'src/a.ts' }, toolResult('ok'))
      expect(edit.loopDetected).toBe(false)
      const run = d.recordAndCheck('exec', { command: 'bun test' }, toolResult(`${6 - i} failing`))
      expect(run.loopDetected).toBe(false)
    }
  })

  test('identical nested outputs in a cycle still trip', () => {
    const d = new LoopDetector()
    let last
    for (let i = 0; i < 5; i++) {
      d.recordAndCheck('edit_file', { path: 'src/a.ts' }, toolResult('ok'))
      last = d.recordAndCheck('exec', { command: 'bun test' }, toolResult('3 failing'))
    }
    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('cycle')
  })

  test('key order does not change the hash', () => {
    const d = new LoopDetector()
    let last
    for (let i = 0; i < 4; i++) {
      const input = i % 2 ? { b: { y: 1, x: 2 }, a: 1 } : { a: 1, b: { x: 2, y: 1 } }
      last = d.recordAndCheck('tool', input, 'same')
    }
    expect(last?.loopDetected).toBe(true)
    expect(last?.reason).toBe('identical_calls')
  })
})
