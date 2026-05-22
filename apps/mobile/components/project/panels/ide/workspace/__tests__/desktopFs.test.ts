// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for DesktopFs — the Electron IPC fast-path WorkspaceService.
 *
 * The interesting behavior to cover here is:
 *
 *   1. Read-path methods (listTree, readFile) hit the IPC bridge first,
 *      reshape the response into the IDE's `WsNode` / `WsFile`, and DO
 *      NOT touch the wrapped SdkFs on the happy path.
 *
 *   2. Bridge errors fall through to SdkFs so the FileTree's error UI is
 *      still served by the canonical HTTP backend (which already knows
 *      how to surface 404s, oversized files, etc.).
 *
 *   3. Write-path methods (writeFile, mkdir, remove, rename) + search +
 *      subscribe always delegate to SdkFs so agent-runtime's file watcher
 *      + RAG indexer see the mutation. This is the invariant the phase-2
 *      docstring promises.
 *
 *   4. The bridge detection helper (`getDesktopFsBridge`) returns null in
 *      anything that isn't an Electron renderer with the right preload
 *      shape — protects the web build from picking up a half-installed
 *      `shogoDesktop` global by accident.
 *
 * We don't boot a real Electron process — DesktopFs treats the bridge as a
 * plain object so a typed mock is all it takes to drive the read-path
 * branches end to end.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DesktopFs, getDesktopFsBridge, type DesktopFsBridge } from '../desktopFs'
import { SdkFs } from '../sdkFs'

const ROOT = '/var/app-data/shogo/workspaces/proj-1'

function makeBridge(overrides: Partial<DesktopFsBridge> = {}): DesktopFsBridge {
  return {
    resolveWorkspace: mock(async () => ({ ok: true, root: ROOT })),
    listTree: mock(async () => ({ ok: true, tree: [] })),
    readFile: mock(async () => ({ ok: true, content: '' })),
    ...overrides,
  }
}

function makeSdkFs(): SdkFs {
  // Real SdkFs — we only need its method signatures so DesktopFs can
  // delegate. We never trigger network because every test that exercises
  // delegation also mocks the relevant method below.
  return new SdkFs('http://example.test', 'fallback')
}

describe('getDesktopFsBridge', () => {
  const originalWindow = (globalThis as any).window
  afterEach(() => {
    if (originalWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = originalWindow
  })

  test('returns null when window is undefined (web SSR / native)', () => {
    delete (globalThis as any).window
    expect(getDesktopFsBridge()).toBeNull()
  })

  test('returns null when shogoDesktop is missing', () => {
    ;(globalThis as any).window = {}
    expect(getDesktopFsBridge()).toBeNull()
  })

  test('returns null when shogoDesktop.fs is missing required methods', () => {
    ;(globalThis as any).window = { shogoDesktop: { fs: { resolveWorkspace: () => {} } } }
    expect(getDesktopFsBridge()).toBeNull()
  })

  test('returns the bridge when all three methods are present', () => {
    const bridge = makeBridge()
    ;(globalThis as any).window = { shogoDesktop: { fs: bridge } }
    expect(getDesktopFsBridge()).toBe(bridge)
  })
})

describe('DesktopFs.listTree', () => {
  test('reshapes IPC response into WsNode[] (files, dirs, lazy, nested)', async () => {
    const bridge = makeBridge({
      listTree: mock(async () => ({
        ok: true,
        tree: [
          { name: 'package.json', path: 'package.json', type: 'file' as const, size: 12, modified: 1 },
          {
            name: 'src',
            path: 'src',
            type: 'directory' as const,
            modified: 2,
            children: [
              { name: 'index.ts', path: 'src/index.ts', type: 'file' as const, size: 5, modified: 3 },
            ],
          },
          { name: 'node_modules', path: 'node_modules', type: 'directory' as const, modified: 4, lazy: true },
        ],
      })),
    })
    const svc = new DesktopFs(bridge, ROOT, makeSdkFs(), 'desktop-test')
    const nodes = await svc.listTree()
    expect(bridge.listTree).toHaveBeenCalledWith(ROOT, undefined)
    expect(nodes).toEqual([
      { name: 'package.json', path: 'package.json', kind: 'file', language: 'json' },
      {
        name: 'src',
        path: 'src',
        kind: 'dir',
        children: [{ name: 'index.ts', path: 'src/index.ts', kind: 'file', language: 'typescript' }],
      },
      { name: 'node_modules', path: 'node_modules', kind: 'dir', lazy: true },
    ])
  })

  test('passes the subPath through for lazy expand', async () => {
    const bridge = makeBridge({
      listTree: mock(async () => ({ ok: true, tree: [] })),
    })
    const svc = new DesktopFs(bridge, ROOT, makeSdkFs(), 'desktop-test')
    await svc.listTree('node_modules')
    expect(bridge.listTree).toHaveBeenCalledWith(ROOT, 'node_modules')
  })

  test('falls back to SdkFs when the bridge reports an error', async () => {
    const bridge = makeBridge({
      listTree: mock(async () => ({ ok: false, error: 'boom' })),
    })
    const sdk = makeSdkFs()
    const sdkListTree = mock(async () => [
      { name: 'fallback.txt', path: 'fallback.txt', kind: 'file' as const, language: 'plaintext' },
    ])
    ;(sdk as any).listTree = sdkListTree

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    const nodes = await svc.listTree('foo')
    expect(sdkListTree).toHaveBeenCalledWith('foo')
    expect(nodes[0]?.name).toBe('fallback.txt')
  })
})

describe('DesktopFs.readFile', () => {
  test('returns a WsFile assembled from the IPC payload on success', async () => {
    const bridge = makeBridge({
      readFile: mock(async () => ({ ok: true, content: 'export const x = 1', size: 18, mtime: 1234 })),
    })
    const svc = new DesktopFs(bridge, ROOT, makeSdkFs(), 'desktop-test')
    const file = await svc.readFile('src/index.ts')
    expect(bridge.readFile).toHaveBeenCalledWith(ROOT, 'src/index.ts')
    expect(file.path).toBe('src/index.ts')
    expect(file.name).toBe('index.ts')
    expect(file.language).toBe('typescript')
    expect(file.content).toBe('export const x = 1')
    expect(file.size).toBe(18)
    expect(file.mtime).toBe(1234)
  })

  test('falls back to SdkFs.readFile when the bridge reports an error (oversize, missing, etc.)', async () => {
    const bridge = makeBridge({
      readFile: mock(async () => ({ ok: false, error: 'File too large' })),
    })
    const sdk = makeSdkFs()
    const sdkReadFile = mock(async () => ({
      path: 'big.txt',
      name: 'big.txt',
      language: 'plaintext',
      size: 999999,
      mtime: 0,
      content: 'from-http',
    }))
    ;(sdk as any).readFile = sdkReadFile

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    const file = await svc.readFile('big.txt')
    expect(sdkReadFile).toHaveBeenCalledWith('big.txt')
    expect(file.content).toBe('from-http')
  })

  test('dedups concurrent reads of the same path', async () => {
    let calls = 0
    const bridge = makeBridge({
      readFile: mock(async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return { ok: true, content: 'x', size: 1, mtime: 1 }
      }),
    })
    const svc = new DesktopFs(bridge, ROOT, makeSdkFs(), 'desktop-test')
    const [a, b, c] = await Promise.all([
      svc.readFile('a.ts'),
      svc.readFile('a.ts'),
      svc.readFile('a.ts'),
    ])
    expect(calls).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)

    // Subsequent reads after settle do hit the bridge again.
    await svc.readFile('a.ts')
    expect(calls).toBe(2)
  })
})

describe('DesktopFs delegation to SdkFs', () => {
  // The phase-2 invariant: every mutation + the live event subscription
  // MUST flow through agent-runtime so its file watcher + RAG indexer
  // observe the change. These tests pin that DesktopFs never sneaks
  // around the SDK on the write path.

  test('writeFile / mkdir / remove / rename all delegate to SdkFs', async () => {
    const bridge = makeBridge()
    const sdk = makeSdkFs()
    const writeFile = mock(async () => ({ mtime: 1, size: 2 }))
    const mkdir = mock(async () => {})
    const remove = mock(async () => {})
    const rename = mock(async () => {})
    ;(sdk as any).writeFile = writeFile
    ;(sdk as any).mkdir = mkdir
    ;(sdk as any).remove = remove
    ;(sdk as any).rename = rename

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    await svc.writeFile('a.ts', 'content')
    await svc.mkdir('newdir')
    await svc.remove('old.txt')
    await svc.rename('from.txt', 'to.txt')

    expect(writeFile).toHaveBeenCalledWith('a.ts', 'content')
    expect(mkdir).toHaveBeenCalledWith('newdir')
    expect(remove).toHaveBeenCalledWith('old.txt')
    expect(rename).toHaveBeenCalledWith('from.txt', 'to.txt')

    // Bridge handlers never touched on the write path.
    expect((bridge.readFile as any).mock.calls).toHaveLength(0)
    expect((bridge.listTree as any).mock.calls).toHaveLength(0)
  })

  test('subscribe is forwarded to SdkFs (SSE stays on HTTP)', () => {
    const bridge = makeBridge()
    const sdk = makeSdkFs()
    const disposer = mock(() => {})
    const subscribe = mock(() => disposer)
    ;(sdk as any).subscribe = subscribe

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    const handler = () => {}
    const dispose = svc.subscribe!(handler)
    expect(subscribe).toHaveBeenCalledWith(handler)
    expect(dispose).toBe(disposer)
  })

  test('search delegates to SdkFs', async () => {
    const bridge = makeBridge()
    const sdk = makeSdkFs()
    const search = mock(async () => ({ results: [], truncated: false }))
    ;(sdk as any).search = search

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    await svc.search('TODO', { caseSensitive: true })
    expect(search).toHaveBeenCalledWith('TODO', { caseSensitive: true })
  })

  test('readFileUrl (blob preview) delegates to SdkFs', async () => {
    const bridge = makeBridge()
    const sdk = makeSdkFs()
    const readFileUrl = mock(async () => 'blob:fake-url')
    ;(sdk as any).readFileUrl = readFileUrl

    const svc = new DesktopFs(bridge, ROOT, sdk, 'desktop-test')
    const url = await svc.readFileUrl!('logo.png')
    expect(readFileUrl).toHaveBeenCalledWith('logo.png')
    expect(url).toBe('blob:fake-url')
  })
})
