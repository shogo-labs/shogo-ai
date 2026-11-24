// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-566 acceptance — the two live problems from the 14-day mobile Sentry
 * review, judged from the outside.
 *
 * A. `SHOGO-IOS-16` (fatal, release `b53d744e`): a value that is not a string
 *    reached `RNCAsyncStorage _writeEntry`, which calls `-length` on it. The
 *    crash is a native `NSInvalidArgumentException` on a dispatch queue, so
 *    this spec models the boundary the way the library does — any non-string
 *    handed to `setItem`/`multiSet` throws the native exception — and then
 *    drives the real composer-draft path (the breadcrumb trail ended at the
 *    composer's "Add") and the real cache writers through it.
 *
 * B. `SHOGO-ANDROID-5` / `-IOS-4` / `-ANDROID-7` / `-ANDROID-1F`: a dropped
 *    connection is transport noise, not a defect. Dropped, named, and left as a
 *    `network` breadcrumb for the next real failure.
 *
 * Nothing here re-implements the fix: it calls the shipped modules and asserts
 * on what reaches (and never reaches) the native module.
 */
import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

interface NativeWrite {
  key: string
  value: unknown
  via: 'setItem' | 'multiSet'
}

const nativeWrites: NativeWrite[] = []
const store = new Map<string, string>()
const breadcrumbs: { category?: string; level?: string; message?: string }[] = []

/** What `-[NSNull length]` is: unreachable from JS `try`/`catch` in the app. */
const nativeThrows = (key: string, value: unknown): never => {
  throw new Error(
    `-[NSNull length]: unrecognized selector sent to instance (${key}: ${typeof value})`,
  )
}

mock.module('@sentry/react-native', () => {
  const stub = {
    init: () => {},
    wrap: <T,>(component: T) => component,
    captureException: () => 'stub-event-id',
    captureMessage: () => 'stub-event-id',
    addBreadcrumb: (b: { category?: string; level?: string; message?: string }) => {
      breadcrumbs.push(b)
    },
  }
  return { ...stub, default: stub }
})

mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => store.get(key) ?? null,
    getAllKeys: async () => [...store.keys()],
    setItem: async (key: string, value: unknown) => {
      nativeWrites.push({ key, value, via: 'setItem' })
      if (typeof value !== 'string') nativeThrows(key, value)
      store.set(key, value as string)
    },
    multiSet: async (pairs: [string, unknown][]) => {
      for (const [key, value] of pairs) {
        nativeWrites.push({ key, value, via: 'multiSet' })
        if (typeof value !== 'string') nativeThrows(key, value)
        store.set(key, value as string)
      }
    },
    removeItem: async (key: string) => {
      store.delete(key)
    },
    multiRemove: async (keys: string[]) => {
      for (const key of keys) store.delete(key)
    },
  },
}))

// `workspace-chats-cache` pulls the API surface, which builds a better-auth
// client at module load; only its cache write is under test here.
mock.module(join(import.meta.dir, '..', 'api'), () => ({
  api: { listWorkspaceSessions: mock(async () => []) },
}))

let storage: typeof import('../storage')
let composerMemory: typeof import('../chat-composer-memory')
let teamChat: typeof import('../team-chat-cache')
let workspaceChats: typeof import('../workspace-chats-cache')
let noise: typeof import('../sentry-noise-filter')

beforeAll(async () => {
  storage = await import('../storage')
  composerMemory = await import('../chat-composer-memory')
  teamChat = await import('../team-chat-cache')
  workspaceChats = await import('../workspace-chats-cache')
  noise = await import('../sentry-noise-filter')
})

beforeEach(() => {
  nativeWrites.length = 0
  breadcrumbs.length = 0
  store.clear()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 120))
const nonStringWrites = () => nativeWrites.filter((w) => typeof w.value !== 'string')

describe('A — nothing in the composer path hands a non-string to native', () => {
  test('a draft with an attachment reference (the "Add" flow) writes only strings', async () => {
    const memory = composerMemory.getComposerMemory()
    const key = composerMemory.composerMemoryKey('session-1')

    memory.setModel(key, 'claude-sonnet-4')
    memory.setDraft(key, 'look at this screenshot', [
      { type: 'file', id: 'file-1', name: 'shot.png', path: '/tmp/shot.png' } as never,
    ])
    memory.flush(key)
    await settle()

    expect(nativeWrites.length).toBeGreaterThan(0)
    expect(nonStringWrites()).toEqual([])
    const stored = JSON.parse(store.get(key) as string)
    expect(stored.draft.text).toBe('look at this screenshot')
    expect(stored.draft.references).toHaveLength(1)
  })

  test('sending the message (draft cleared) removes the key, never writes nothing', async () => {
    const memory = composerMemory.getComposerMemory()
    const key = composerMemory.composerMemoryKey('session-2')
    memory.setModel(key, 'claude-sonnet-4')
    memory.setDraft(key, 'hello', [])
    memory.flush(key)
    await settle()

    memory.clearDraft(key)
    await settle()

    expect(nonStringWrites()).toEqual([])
    const stored = JSON.parse(store.get(key) as string)
    expect(stored.draft).toBeUndefined()
    expect(stored.model).toBe('claude-sonnet-4')
  })

  test('the cache writers that debounce JSON.stringify(unknown) stay string-only', async () => {
    teamChat.cacheTimeline('user-1', 'conv-1', [{ id: 'm1', seq: 1 } as never], false)
    workspaceChats.writeWorkspaceChats('user-1:local:ws-1', [{ id: 'chat-1' } as never])
    await new Promise((resolve) => setTimeout(resolve, 1_300))

    expect(nativeWrites.length).toBeGreaterThan(0)
    expect(nonStringWrites()).toEqual([])
  })
})

describe('A — a value whose static type lied is refused and named, not written', () => {
  const hostile: [string, unknown, string][] = [
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
    ['number', 42, 'number'],
    ['function', () => undefined, 'function'],
    ['symbol', Symbol('sho-566'), 'symbol'],
    ['boolean', true, 'boolean'],
    ['object', { key: 'value' }, 'object'],
  ]

  for (const [label, value, kind] of hostile) {
    test(`a ${label} value removes the key instead of crossing the bridge`, async () => {
      const key = `shogo:qa566:${label}`
      await storage.setStorageItem(key, 'seed')
      await storage.setStorageItem(key, value as string)

      expect(store.has(key)).toBe(false)
      expect(nonStringWrites()).toEqual([])
      const refused = breadcrumbs.filter((b) => b.category === 'storage')
      expect(refused).toHaveLength(1)
      // The next crash of this shape has to name itself: SHOGO-IOS-16 could not.
      expect(refused[0]?.message).toContain(`"${key}"`)
      expect(refused[0]?.message).toContain(kind)
    })
  }

  test('a value JSON cannot serialize removes the key, never writes "undefined"', async () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    await storage.setStorageJson('shogo:qa566:json-undefined', undefined)
    await storage.setStorageJson('shogo:qa566:json-cycle', cycle)
    await storage.setStorageJson('shogo:qa566:json-bigint', { n: 1n })

    expect(store.size).toBe(0)
    expect(nonStringWrites()).toEqual([])
  })

  test('the guard never throws, so correctness does not depend on a caller catch', async () => {
    await expect(storage.setStorageItem('shogo:qa566:no-throw', undefined as never)).resolves.toBe(
      undefined,
    )
    await expect(storage.setStorageJson('shogo:qa566:no-throw-json', undefined)).resolves.toBe(
      undefined,
    )
  })
})

// --- the write barrier, from the outside -----------------------------------

const MOBILE_ROOT = join(import.meta.dir, '../..')
const HELPER = join('lib', 'storage.ts')
const PACKAGE = '@react-native-async-storage/async-storage'
const SHOULD_NOT_WRITE = /^(lib\/storage\.ts)$/
const SOURCE_ROOTS = ['app', 'components', 'contexts', 'lib']
const SKIP_DIRS = new Set([
  'node_modules',
  '.expo',
  '__tests__',
  '__mocks__',
  'ios',
  'android',
  'dist',
  'coverage',
  'stubs',
])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) sourceFiles(path, acc)
      continue
    }
    if (/\.tsx?$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) acc.push(path)
  }
  return acc
}

/** Every local name bound to the package by an import clause in this file. */
function storageBindings(src: string): string[] {
  const names = new Set<string>()
  const imports = /import\s+([^'"]+?)\s+from\s+['"]@react-native-async-storage\/async-storage['"]/g
  for (const match of src.matchAll(imports)) {
    const clause = match[1]
    const namespace = clause.match(/\*\s*as\s+(\w+)/)
    if (namespace) {
      names.add(namespace[1])
      names.add(`${namespace[1]}.default`)
    }
    const braces = clause.match(/\{([^}]*)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) names.add(name)
      }
    }
    const def = clause.match(/^(\w+)\s*(?:,|$)/)
    if (def && def[1] !== 'type') names.add(def[1])
  }
  return [...names]
}

/** Direct writes in one source string — the four spellings that reach native. */
function findDirectWrites(src: string): string[] {
  const found: string[] = []
  for (const name of storageBindings(src)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`\\b${escaped}\\s*\\.\\s*(setItem|multiSet)\\s*\\(`).test(src)) found.push(name)
    // `import { setItem } from …` then `setItem(…)` — the write without an object.
    if (/^(setItem|multiSet)$/.test(name) && new RegExp(`\\b${name}\\s*\\(`).test(src)) {
      found.push(name)
    }
  }
  if (/\bAsyncStorage\s*\.\s*(setItem|multiSet)\s*\(/.test(src)) found.push('AsyncStorage')
  if (new RegExp(`import\\(\\s*['"]${PACKAGE}['"]`).test(src)) found.push('dynamic import')
  return [...new Set(found)]
}

describe('A — no module writes around the barrier', () => {
  test('lib/storage.ts is the only writer in apps/mobile', () => {
    const offenders: string[] = []
    for (const root of SOURCE_ROOTS) {
      for (const file of sourceFiles(join(MOBILE_ROOT, root))) {
        const rel = relative(MOBILE_ROOT, file).split('\\').join('/')
        if (SHOULD_NOT_WRITE.test(rel)) continue
        for (const how of findDirectWrites(readFileSync(file, 'utf8'))) {
          offenders.push(`${rel} → ${how}.setItem/multiSet`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('the scan is not vacuous — it catches every spelling of a direct write', () => {
    const spellings = [
      `import AsyncStorage from '${PACKAGE}'\nAsyncStorage.setItem('k', v)`,
      `import AsyncStorage from '${PACKAGE}'\nAsyncStorage.multiSet([['k', v]])`,
      `import { default as AS } from '${PACKAGE}'\nAS.setItem('k', v)`,
      `import * as AC from '${PACKAGE}'\nAC.default.setItem('k', v)`,
      `import { setItem } from '${PACKAGE}'\nsetItem('k', v)`,
      `const m = await import('${PACKAGE}')\nm.default.setItem('k', v)`,
    ]
    for (const src of spellings) expect(findDirectWrites(src).length).toBeGreaterThan(0)

    const reads = `import AsyncStorage from '${PACKAGE}'\nawait AsyncStorage.getItem('k')`
    expect(findDirectWrites(reads)).toEqual([])
  })

  test('the helper itself still writes (the barrier is not a no-op)', () => {
    expect(findDirectWrites(readFileSync(join(MOBILE_ROOT, HELPER), 'utf8'))).toContain(
      'AsyncStorage',
    )
  })
})

// --- B. dropped connections are noise, not defects -------------------------

const exc = (type: string, value: string) => ({ exception: { values: [{ type, value }] } })

describe('B — the transient-network issues stop reporting', () => {
  const issues: [string, string, string][] = [
    ['SHOGO-ANDROID-5', 'Error', 'Software caused connection abort'],
    ['SHOGO-IOS-4', 'Error', 'The network connection was lost.'],
    [
      'SHOGO-ANDROID-7',
      'Error',
      'Unable to resolve host "studio.shogo.ai": No address associated with hostname',
    ],
    ['SHOGO-ANDROID-1F', 'Error', 'Unable to resolve host "studio.shogo.ai"'],
    ['RN fetch', 'TypeError', 'Network request failed'],
    ['offline', 'Error', 'The Internet connection appears to be offline.'],
    ['reset', 'Error', 'Connection reset by peer'],
  ]

  for (const [issue, type, value] of issues) {
    test(`${issue} is dropped and named as transport noise`, () => {
      expect(noise.isNoiseEvent(exc(type, value))).toBe(true)
      expect(noise.transientTransportMessage(exc(type, value))).toBe(value)
    })
  }

  test('real defects that mention the network still report', () => {
    // A JS bug, a server that answered, and a deliberate capture.
    expect(noise.isNoiseEvent(exc('TypeError', "Cannot read property 'network' of undefined"))).toBe(
      false,
    )
    // 502/503/504 are already transient-backend noise on main; 500 is a real failure.
    expect(noise.isNoiseEvent(exc('ShogoError', 'Request failed with status 500'))).toBe(false)
    expect(
      noise.isNoiseEvent({
        ...exc('Error', 'The network connection was lost.'),
        tags: { shogo_telemetry: 'true' },
      }),
    ).toBe(false)
  })

  test('beforeSend keeps the trail: the dropped connection becomes a network breadcrumb', () => {
    // `beforeSend` is a closure inside the root layout, so the wiring is pinned
    // where it lives: an `isNoiseEvent` branch that asks for the dropped
    // message and leaves it as a breadcrumb before returning null.
    const layout = readFileSync(join(MOBILE_ROOT, 'app', '_layout.tsx'), 'utf8')
    const branch = layout.match(/if \(isNoiseEvent\(event\)\) \{[\s\S]{0,600}?return null;/)
    expect(branch).not.toBeNull()
    expect(branch?.[0]).toContain('transientTransportMessage(event)')
    expect(branch?.[0]).toMatch(/category:\s*["']network["']/)
    expect(branch?.[0]).toContain('Sentry.addBreadcrumb')
  })
})
