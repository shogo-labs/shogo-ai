// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Unit tests for Phase 3 — Background Task Monitoring.
 * Covers: ReadySignalDetector, BackgroundTaskManager, BackgroundTerminalIndicator.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { ReadySignalDetector } from '../ready-signal-detector'
import { BackgroundTaskManager } from '../background-task-manager'

// ─── ReadySignalDetector ──────────────────────────────────────────────

describe('ReadySignalDetector', () => {
  let detector: ReadySignalDetector

  beforeEach(() => {
    detector = new ReadySignalDetector()
  })

  afterEach(() => {
    detector.dispose()
  })

  it('detects localhost URL', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('Server running at http://localhost:8081\n')
    expect(signal).not.toBeNull()
    expect(signal.url).toBe('http://localhost:8081')
    expect(signal.description).toContain('URL')
  })

  it('detects Metro bundler "Waiting on" URL', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('Waiting on http://localhost:8081\n')
    expect(signal).not.toBeNull()
    expect(signal.url).toBe('http://localhost:8081')
  })

  it('detects "compiled successfully"', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('webpack compiled successfully\n')
    expect(signal).not.toBeNull()
    expect(signal.description).toContain('Compiled')
  })

  it('detects "Bundled N modules"', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('Bundled 107 modules in 15ms\n')
    expect(signal).not.toBeNull()
    expect(signal.description).toContain('Build completed')
  })

  it('detects "(entry point)" pattern', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('server.js  1.23 MB  (entry point)\n')
    expect(signal).not.toBeNull()
  })

  it('detects "listening on port"', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('Express server listening on :3000\n')
    expect(signal).not.toBeNull()
  })

  it('fires only once per detector lifecycle', () => {
    let count = 0
    detector.onReady(() => { count++ })

    detector.feedOutput('http://localhost:8081\n')
    detector.feedOutput('http://localhost:3000\n')
    expect(count).toBe(1)
  })

  it('reports isReady() after detection', () => {
    expect(detector.isReady()).toBe(false)
    detector.feedOutput('http://localhost:8081\n')
    expect(detector.isReady()).toBe(true)
  })

  it('does not fire after dispose()', () => {
    let count = 0
    detector.onReady(() => { count++ })
    detector.dispose()

    detector.feedOutput('http://localhost:8081\n')
    expect(count).toBe(0)
  })

  it('reset() allows re-detection', () => {
    let count = 0
    detector.onReady(() => { count++ })

    detector.feedOutput('http://localhost:8081\n')
    expect(count).toBe(1)

    detector.reset()
    expect(detector.isReady()).toBe(false)

    detector.feedOutput('http://localhost:3000\n')
    expect(count).toBe(2)
  })

  it('handles partial lines across chunks', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    // First chunk — no newline
    detector.feedOutput('Server running at ')
    expect(signal).toBeNull()

    // Second chunk — completes the line
    detector.feedOutput('http://localhost:8081\n')
    expect(signal).not.toBeNull()
    expect(signal.url).toBe('http://localhost:8081')
  })

  it('extracts rawLine', () => {
    let signal: any = null
    detector.onReady((s) => { signal = s })

    detector.feedOutput('  🚀 Server running at http://localhost:8081\n')
    expect(signal.rawLine).toContain('🚀')
    expect(signal.rawLine).toContain('http://localhost:8081')
  })

  it('multiple listeners all receive signals', () => {
    const results: string[] = []
    detector.onReady((s) => results.push('a:' + (s.url ?? s.description)))
    detector.onReady((s) => results.push('b:' + (s.url ?? s.description)))

    detector.feedOutput('http://localhost:8081\n')
    expect(results.length).toBe(2)
    expect(results[0]).toContain('http://localhost:8081')
    expect(results[1]).toContain('http://localhost:8081')
  })
})

// ─── BackgroundTaskManager ────────────────────────────────────────────

describe('BackgroundTaskManager', () => {
  let manager: BackgroundTaskManager

  beforeEach(() => {
    manager = new BackgroundTaskManager()
  })

  afterEach(() => {
    manager.dispose()
  })

  it('registers a task', () => {
    const task = manager.registerTask({
      sessionId: 'sess-1',
      label: 'Shogo (bun run dev)',
      command: 'bun run dev',
      cwd: '/Users/test/project',
    })
    expect(task.sessionId).toBe('sess-1')
    expect(task.isRunning).toBe(true)
    expect(manager.getActiveCount()).toBe(1)
  })

  it('completes a task', () => {
    manager.registerTask({
      sessionId: 'sess-1', label: 'test', command: 'echo', cwd: '/tmp',
    })
    manager.completeTask('sess-1', 0)

    const tasks = manager.getTasks()
    expect(tasks[0].isRunning).toBe(false)
    expect(tasks[0].exitCode).toBe(0)
    expect(tasks[0].completedAt).not.toBeNull()
    expect(manager.getActiveCount()).toBe(0)
  })

  it('removes a completed task', () => {
    manager.registerTask({
      sessionId: 'sess-1', label: 'test', command: 'echo', cwd: '/tmp',
    })
    manager.completeTask('sess-1')
    manager.removeTask('sess-1')

    expect(manager.getTasks()).toHaveLength(0)
  })

  it('tracks multiple concurrent tasks', () => {
    manager.registerTask({ sessionId: 'a', label: 'A', command: 'dev', cwd: '/a' })
    manager.registerTask({ sessionId: 'b', label: 'B', command: 'serve', cwd: '/b' })
    manager.registerTask({ sessionId: 'c', label: 'C', command: 'watch', cwd: '/c' })

    expect(manager.getActiveCount()).toBe(3)

    manager.completeTask('b')
    expect(manager.getActiveCount()).toBe(2)
  })

  it('feedOutput reaches the detector', () => {
    manager.registerTask({
      sessionId: 'sess-1', label: 'test', command: 'bun run dev', cwd: '/tmp',
    })

    let url: string | undefined
    const unsub = manager.onChange((tasks) => {
      const t = tasks.find((t) => t.sessionId === 'sess-1')
      if (t?.url) url = t.url
    })

    manager.feedOutput('sess-1', 'Waiting on http://localhost:8081\n')
    expect(url).toBe('http://localhost:8081')
    unsub()
  })

  it('onChange fires on task registration', () => {
    let fired = false
    manager.onChange(() => { fired = true })

    manager.registerTask({ sessionId: 'a', label: 'A', command: 'dev', cwd: '/a' })
    expect(fired).toBe(true)
  })

  it('onChange fires on task completion', () => {
    manager.registerTask({ sessionId: 'a', label: 'A', command: 'dev', cwd: '/a' })

    let activeCount = -1
    manager.onChange((tasks) => {
      activeCount = tasks.filter((t) => t.isRunning).length
    })

    manager.completeTask('a')
    expect(activeCount).toBe(0)
  })

  it('dispose cleans up all resources', () => {
    manager.registerTask({ sessionId: 'a', label: 'A', command: 'dev', cwd: '/a' })
    manager.dispose()
    expect(manager.getTasks()).toHaveLength(0)
  })
})
