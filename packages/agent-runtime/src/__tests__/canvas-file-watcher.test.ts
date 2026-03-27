// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { CanvasFileWatcher, type CanvasEvent } from '../canvas-file-watcher'

const TMP_BASE = join(import.meta.dir, '..', '..', '.test-tmp-canvas-watcher')

let tmpDir: string
let nextId = 0

function freshDir(): string {
  const dir = join(TMP_BASE, `w-${nextId++}-${Date.now()}`)
  mkdirSync(join(dir, 'canvas'), { recursive: true })
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
// Construction & loadExisting
// ---------------------------------------------------------------------------

describe('loadExisting', () => {
  test('loads .js files from canvas/ on construction', () => {
    writeFileSync(join(tmpDir, 'canvas', 'dashboard.js'), 'return h("div", null, "hi")')
    const watcher = new CanvasFileWatcher(tmpDir)
    const init = watcher.getInitEvent()

    expect(init.type).toBe('init')
    expect(init.surfaces).toHaveLength(1)
    expect(init.surfaces![0].surfaceId).toBe('dashboard')
    expect(init.surfaces![0].code).toBe('return h("div", null, "hi")')
    expect(init.surfaces![0].title).toBe('Dashboard')
  })

  test('loads .tsx files from canvas/ on construction', () => {
    writeFileSync(join(tmpDir, 'canvas', 'app.tsx'), 'export default function App() { return <div>hi</div> }')
    const watcher = new CanvasFileWatcher(tmpDir)
    const init = watcher.getInitEvent()

    expect(init.surfaces).toHaveLength(1)
    expect(init.surfaces![0].surfaceId).toBe('app')
    expect(init.surfaces![0].code).toContain('export default')
  })

  test('loads .ts and .jsx files from canvas/', () => {
    writeFileSync(join(tmpDir, 'canvas', 'utils.ts'), 'const x = 1')
    writeFileSync(join(tmpDir, 'canvas', 'view.jsx'), 'export default () => <div/>')
    const watcher = new CanvasFileWatcher(tmpDir)

    expect(watcher.getInitEvent().surfaces).toHaveLength(2)
  })

  test('loads .data.json files and pairs them with code surfaces', () => {
    writeFileSync(join(tmpDir, 'canvas', 'stats.tsx'), 'export default function Stats() { return <div/> }')
    writeFileSync(join(tmpDir, 'canvas', 'stats.data.json'), JSON.stringify({ count: 42 }))
    const watcher = new CanvasFileWatcher(tmpDir)
    const init = watcher.getInitEvent()

    expect(init.surfaces).toHaveLength(1)
    expect(init.surfaces![0].data).toEqual({ count: 42 })
  })

  test('returns empty surfaces when canvas/ does not exist', () => {
    const emptyDir = join(TMP_BASE, 'empty-' + Date.now())
    mkdirSync(emptyDir, { recursive: true })
    const watcher = new CanvasFileWatcher(emptyDir)

    expect(watcher.getInitEvent().surfaces).toEqual([])
  })

  test('loads multiple surfaces', () => {
    writeFileSync(join(tmpDir, 'canvas', 'dashboard.tsx'), 'code1')
    writeFileSync(join(tmpDir, 'canvas', 'settings.js'), 'code2')
    writeFileSync(join(tmpDir, 'canvas', 'todo_list.tsx'), 'code3')
    const watcher = new CanvasFileWatcher(tmpDir)

    expect(watcher.getInitEvent().surfaces).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// titleFromId
// ---------------------------------------------------------------------------

describe('titleFromId', () => {
  test('converts underscore-separated ids to title case', () => {
    writeFileSync(join(tmpDir, 'canvas', 'my_dashboard.js'), 'code')
    const watcher = new CanvasFileWatcher(tmpDir)
    const surface = watcher.getInitEvent().surfaces![0]
    expect(surface.title).toBe('My Dashboard')
  })

  test('converts hyphen-separated ids to title case', () => {
    writeFileSync(join(tmpDir, 'canvas', 'user-profile.js'), 'code')
    const watcher = new CanvasFileWatcher(tmpDir)
    const surface = watcher.getInitEvent().surfaces![0]
    expect(surface.title).toBe('User Profile')
  })

  test('capitalizes single-word ids', () => {
    writeFileSync(join(tmpDir, 'canvas', 'counter.js'), 'code')
    const watcher = new CanvasFileWatcher(tmpDir)
    const surface = watcher.getInitEvent().surfaces![0]
    expect(surface.title).toBe('Counter')
  })
})

// ---------------------------------------------------------------------------
// onFileChanged
// ---------------------------------------------------------------------------

describe('onFileChanged', () => {
  test('emits renderCode for canvas/*.js', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    const absPath = join(tmpDir, 'canvas', 'todo.js')
    writeFileSync(absPath, 'return h("div", null, "todos")')
    watcher.onFileChanged('canvas/todo.js', absPath)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('renderCode')
    expect(events[0].surfaceId).toBe('todo')
    expect(events[0].title).toBe('Todo')
    expect(events[0].code).toBe('return h("div", null, "todos")')
  })

  test('emits renderCode for canvas/*.tsx', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    const absPath = join(tmpDir, 'canvas', 'dashboard.tsx')
    const code = 'export default function Dashboard() { return <div>hi</div> }'
    writeFileSync(absPath, code)
    watcher.onFileChanged('canvas/dashboard.tsx', absPath)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('renderCode')
    expect(events[0].surfaceId).toBe('dashboard')
    expect(events[0].code).toBe(code)
  })

  test('emits dataUpdate for canvas/*.data.json', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    const absPath = join(tmpDir, 'canvas', 'todo.data.json')
    writeFileSync(absPath, JSON.stringify({ items: [1, 2, 3] }))
    watcher.onFileChanged('canvas/todo.data.json', absPath)

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('dataUpdate')
    expect(events[0].surfaceId).toBe('todo')
    expect(events[0].data).toEqual({ items: [1, 2, 3] })
  })

  test('ignores non-canvas paths', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.onFileChanged('src/index.js', join(tmpDir, 'src', 'index.js'))
    watcher.onFileChanged('MEMORY.md', join(tmpDir, 'MEMORY.md'))

    expect(events).toHaveLength(0)
  })

  test('ignores nested canvas subdirectory files', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.onFileChanged('canvas/nested/deep.js', join(tmpDir, 'canvas', 'nested', 'deep.js'))

    expect(events).toHaveLength(0)
  })

  test('updates internal state accessible via getInitEvent', () => {
    const watcher = new CanvasFileWatcher(tmpDir)

    expect(watcher.getInitEvent().surfaces).toHaveLength(0)

    const absPath = join(tmpDir, 'canvas', 'app.js')
    writeFileSync(absPath, 'return h("span", null, "v1")')
    watcher.onFileChanged('canvas/app.js', absPath)

    const surfaces = watcher.getInitEvent().surfaces!
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].code).toBe('return h("span", null, "v1")')

    writeFileSync(absPath, 'return h("span", null, "v2")')
    watcher.onFileChanged('canvas/app.js', absPath)

    expect(watcher.getInitEvent().surfaces![0].code).toBe('return h("span", null, "v2")')
  })
})

// ---------------------------------------------------------------------------
// onFileDeleted
// ---------------------------------------------------------------------------

describe('onFileDeleted', () => {
  test('emits removeSurface for canvas/*.js', () => {
    writeFileSync(join(tmpDir, 'canvas', 'page.js'), 'code')
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.onFileDeleted('canvas/page.js')

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('removeSurface')
    expect(events[0].surfaceId).toBe('page')
  })

  test('emits removeSurface for canvas/*.tsx', () => {
    writeFileSync(join(tmpDir, 'canvas', 'app.tsx'), 'export default () => <div/>')
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.onFileDeleted('canvas/app.tsx')

    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('removeSurface')
    expect(events[0].surfaceId).toBe('app')
  })

  test('removes surface from getInitEvent after delete', () => {
    writeFileSync(join(tmpDir, 'canvas', 'a.tsx'), 'codeA')
    writeFileSync(join(tmpDir, 'canvas', 'b.js'), 'codeB')
    const watcher = new CanvasFileWatcher(tmpDir)

    expect(watcher.getInitEvent().surfaces).toHaveLength(2)

    watcher.onFileDeleted('canvas/a.tsx')

    const surfaces = watcher.getInitEvent().surfaces!
    expect(surfaces).toHaveLength(1)
    expect(surfaces[0].surfaceId).toBe('b')
  })

  test('cleans up data on .data.json delete without emitting removeSurface', () => {
    writeFileSync(join(tmpDir, 'canvas', 'dash.js'), 'code')
    writeFileSync(join(tmpDir, 'canvas', 'dash.data.json'), '{"x":1}')
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    expect(watcher.getInitEvent().surfaces![0].data).toEqual({ x: 1 })

    watcher.onFileDeleted('canvas/dash.data.json')

    expect(events).toHaveLength(0)
    expect(watcher.getInitEvent().surfaces![0].data).toEqual({})
  })

  test('ignores non-canvas deletes', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe((e) => events.push(e))

    watcher.onFileDeleted('src/old.js')
    expect(events).toHaveLength(0)
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

    const absPath = join(tmpDir, 'canvas', 'x.js')
    writeFileSync(absPath, 'code')
    watcher.onFileChanged('canvas/x.js', absPath)

    expect(events1).toHaveLength(1)
    expect(events2).toHaveLength(1)
  })

  test('unsubscribed listener stops receiving events', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    const fn = (e: CanvasEvent) => events.push(e)
    watcher.subscribe(fn)

    const absPath = join(tmpDir, 'canvas', 'a.js')
    writeFileSync(absPath, 'v1')
    watcher.onFileChanged('canvas/a.js', absPath)
    expect(events).toHaveLength(1)

    watcher.unsubscribe(fn)

    writeFileSync(absPath, 'v2')
    watcher.onFileChanged('canvas/a.js', absPath)
    expect(events).toHaveLength(1)
  })

  test('throwing subscriber does not break other subscribers', () => {
    const watcher = new CanvasFileWatcher(tmpDir)
    const events: CanvasEvent[] = []
    watcher.subscribe(() => { throw new Error('boom') })
    watcher.subscribe((e) => events.push(e))

    const absPath = join(tmpDir, 'canvas', 'ok.js')
    writeFileSync(absPath, 'code')
    watcher.onFileChanged('canvas/ok.js', absPath)

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
