/**
 * Loop Detector Unit Tests
 */

import { describe, test, expect } from 'bun:test'
import { LoopDetector } from '../loop-detector'

describe('LoopDetector', () => {
  test('does not trigger on normal varied tool calls', () => {
    const detector = new LoopDetector()
    const r1 = detector.recordAndCheck('read_file', { path: 'a.txt' }, { content: 'aaa' })
    const r2 = detector.recordAndCheck('write_file', { path: 'b.txt', content: 'bbb' }, { ok: true })
    const r3 = detector.recordAndCheck('exec', { command: 'ls' }, { stdout: 'files' })

    expect(r1.loopDetected).toBe(false)
    expect(r2.loopDetected).toBe(false)
    expect(r3.loopDetected).toBe(false)
  })

  test('detects identical calls (same tool + same input) repeated', () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 })

    detector.recordAndCheck('read_file', { path: 'config.json' }, { content: '{}' })
    detector.recordAndCheck('read_file', { path: 'config.json' }, { content: '{}' })
    const r3 = detector.recordAndCheck('read_file', { path: 'config.json' }, { content: '{}' })

    expect(r3.loopDetected).toBe(true)
    expect(r3.reason).toBe('identical_calls')
    expect(r3.pattern).toContain('read_file')
    expect(r3.pattern).toContain('3 times')
  })

  test('different inputs for same tool do not trigger identical_calls', () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 })

    detector.recordAndCheck('read_file', { path: 'a.txt' }, { content: 'aaa' })
    detector.recordAndCheck('read_file', { path: 'b.txt' }, { content: 'bbb' })
    const r3 = detector.recordAndCheck('read_file', { path: 'c.txt' }, { content: 'ccc' })

    expect(r3.loopDetected).toBe(false)
  })

  test('detects identical outputs repeated', () => {
    const detector = new LoopDetector({ maxIdenticalOutputs: 3 })

    detector.recordAndCheck('exec', { command: 'curl api' }, { error: 'timeout' })
    detector.recordAndCheck('exec', { command: 'curl api --retry' }, { error: 'timeout' })
    const r3 = detector.recordAndCheck('web_fetch', { url: 'http://api' }, { error: 'timeout' })

    expect(r3.loopDetected).toBe(true)
    expect(r3.reason).toBe('identical_outputs')
  })

  test('detects A→B→A→B cycle', () => {
    const detector = new LoopDetector({ cycleWindowSize: 6, minCycleLength: 2 })

    detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    detector.recordAndCheck('write_file', { path: 'x', content: 'b' }, 'ok')
    detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    detector.recordAndCheck('write_file', { path: 'x', content: 'b' }, 'ok')
    detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    const r6 = detector.recordAndCheck('write_file', { path: 'x', content: 'b' }, 'ok')

    expect(r6.loopDetected).toBe(true)
    expect(r6.reason).toBe('cycle')
    expect(r6.pattern).toContain('read_file')
    expect(r6.pattern).toContain('write_file')
  })

  test('detects A→B→C→A→B→C cycle', () => {
    const detector = new LoopDetector({ cycleWindowSize: 6, minCycleLength: 2 })

    detector.recordAndCheck('a', { x: 1 }, '1')
    detector.recordAndCheck('b', { x: 2 }, '2')
    detector.recordAndCheck('c', { x: 3 }, '3')
    detector.recordAndCheck('a', { x: 1 }, '1')
    detector.recordAndCheck('b', { x: 2 }, '2')
    const r6 = detector.recordAndCheck('c', { x: 3 }, '3')

    expect(r6.loopDetected).toBe(true)
    expect(r6.reason).toBe('cycle')
  })

  test('configurable thresholds', () => {
    const detector = new LoopDetector({
      maxIdenticalCalls: 5,
      maxIdenticalOutputs: 10, // high so it doesn't trigger first
    })

    for (let i = 0; i < 4; i++) {
      const r = detector.recordAndCheck('read_file', { path: 'x' }, 'same')
      expect(r.loopDetected).toBe(false)
    }

    const r5 = detector.recordAndCheck('read_file', { path: 'x' }, 'same')
    expect(r5.loopDetected).toBe(true)
    expect(r5.reason).toBe('identical_calls')
  })

  test('reset clears history', () => {
    const detector = new LoopDetector({ maxIdenticalCalls: 3 })

    detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    detector.reset()

    const r = detector.recordAndCheck('read_file', { path: 'x' }, 'a')
    expect(r.loopDetected).toBe(false)
    expect(detector.callCount).toBe(1)
  })

  test('callCount tracks total tool calls', () => {
    const detector = new LoopDetector()
    expect(detector.callCount).toBe(0)

    detector.recordAndCheck('a', {}, 'x')
    detector.recordAndCheck('b', {}, 'y')
    expect(detector.callCount).toBe(2)
  })
})
