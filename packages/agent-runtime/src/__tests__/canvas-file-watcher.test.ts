// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { CanvasFileWatcher, type CanvasEvent } from '../canvas-file-watcher'

const TMP_BASE = join(import.meta.dir, '..', '..', '.test-tmp-canvas-watcher')

let tmpDir: string
let nextId = 0

function freshDir(): string {
  const dir = join(TMP_BASE, `w-${nextId++}-${Date.now()}`)
  mkdirSync(join(dir, 'src'), { recursive: true })
  return dir
}

function resetSingleton() {
  // @ts-expect-error — accessing private static for test isolation
  CanvasFileWatcher.instance = null
}

beforeEach(() => {
  resetSingleton()
  tmpDir = freshDir()
})

afterEach(() => {
  resetSingleton()
  if (existsSync(TMP_BASE)) {
    rmSync(TMP_BASE, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// onFileChanged — triggers rebuild for src/ files
// ---------------------------------------------------------------------------

describe('onFileChanged', () => {
  test('calls onRebuild for src/*.tsx', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/App.tsx', join(tmpDir, 'src', 'App.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for src/components/*.tsx', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/components/Header.tsx', join(tmpDir, 'src', 'components', 'Header.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for src/*.css', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/index.css', join(tmpDir, 'src', 'index.css'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for index.html', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('index.html', join(tmpDir, 'index.html'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for vite.config.ts', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('vite.config.ts', join(tmpDir, 'vite.config.ts'))

    expect(rebuildCalled).toBe(true)
  })

  // --- Expo / Metro layout ---------------------------------------------------

  test('calls onRebuild for Expo app/*.tsx (expo-router routes)', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('app/index.tsx', join(tmpDir, 'app', 'index.tsx'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for Expo app.json', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('app.json', join(tmpDir, 'app.json'))

    expect(rebuildCalled).toBe(true)
  })

  test('calls onRebuild for babel.config.js / metro.config.js', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let calls = 0
    watcher.setOnRebuild(() => { calls++ })

    watcher.onFileChanged('babel.config.js', join(tmpDir, 'babel.config.js'))
    watcher.onFileChanged('metro.config.js', join(tmpDir, 'metro.config.js'))

    expect(calls).toBe(2)
  })

  test('ignores non-buildable paths', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('MEMORY.md', join(tmpDir, 'MEMORY.md'))
    watcher.onFileChanged('skills/test.md', join(tmpDir, 'skills', 'test.md'))
    watcher.onFileChanged('.shogo/server/schema.prisma', join(tmpDir, '.shogo', 'server', 'schema.prisma'))

    expect(rebuildCalled).toBe(false)
  })

  test('ignores non-buildable extensions under src/', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileChanged('src/data.md', join(tmpDir, 'src', 'data.md'))

    expect(rebuildCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// onFileDeleted — triggers rebuild for src/ files
// ---------------------------------------------------------------------------

describe('onFileDeleted', () => {
  test('calls onRebuild when src/*.tsx is deleted', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileDeleted('src/App.tsx')

    expect(rebuildCalled).toBe(true)
  })

  test('ignores non-buildable deletes', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    let rebuildCalled = false
    watcher.setOnRebuild(() => { rebuildCalled = true })

    watcher.onFileDeleted('MEMORY.md')
    expect(rebuildCalled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// broadcastReload & getInitEvent
// ---------------------------------------------------------------------------

describe('broadcastReload', () => {
  test('broadcasts reload event to subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.broadcastReload()

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('reload')
  })
})

describe('getInitEvent', () => {
  test('returns init event', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const init = watcher.getInitEvent()
    expect(init.type).toBe('init')
  })
})

// ---------------------------------------------------------------------------
// Subscriber management
// ---------------------------------------------------------------------------

describe('subscribe/unsubscribe', () => {
  test('broadcasts to multiple subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events1: CanvasEvent[] = []
    const events2: CanvasEvent[] = []
    watcher.subscribe((e) => events1.push(e))
    watcher.subscribe((e) => events2.push(e))

    watcher.broadcastReload()

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
    expect(events1[0].type).toBe('reload')
  })

  test('unsubscribed listener stops receiving events', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    const fn = (e: CanvasEvent) => events.push(e)
    watcher.subscribe(fn)

    watcher.broadcastReload()
    expect(events).toHaveLength(1)

    watcher.unsubscribe(fn)

    watcher.broadcastReload()
    expect(events).toHaveLength(1)
  })

  test('throwing subscriber does not break other subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe(() => { throw new Error('boom') })
    watcher.subscribe((e) => events.push(e))

    watcher.broadcastReload()

    expect(events).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

describe('getInstance', () => {
  test('returns same instance on repeated calls', () => {
    const a = CanvasFileWatcher.getInstance(tmpDir)
    const b = CanvasFileWatcher.getInstance(tmpDir)
    expect(a).toBe(b)
  })
})
