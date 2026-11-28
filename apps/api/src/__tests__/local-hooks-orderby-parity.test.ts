// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// A `local*Hooks` set may not lose the cloud set's default list order (SHO-610).
//
// The desktop transcript vanished a reply at turn end and painted stale rows on
// reopen because `localChatMessageHooks` installed no `beforeList`, so the
// generated list route passed no `orderBy` and SQLite answered in primary-key
// order. Nothing in CI noticed: the cloud set still had `createdAt: 'desc'`, and
// the divergence between the two sets was invisible.
//
// This walks every `local<Model>Hooks` export in `src/generated`, pairs it with
// its cloud set, and — where the cloud `beforeList` yields a default `orderBy` —
// requires the local set to yield the same one. A new local hook set that drops
// the ordering fails here instead of shipping.
//
// If a future cloud hook needs more of the fake context than `permissiveCtx`
// provides, extend it here; do not weaken the comparison.
//
// Run: bun test apps/api/src/__tests__/local-hooks-orderby-parity.test.ts

import { describe, expect, test } from 'bun:test'
import { join } from 'path'

const GENERATED_DIR = join(import.meta.dir, '..', 'generated')

/**
 * Listed through Bun's own glob rather than `node:fs`: this file runs in the
 * same process as suites that `mock.module('node:fs', …)` with a partial
 * factory, and a named `readdirSync` import then fails to link.
 */
function hookFiles(): string[] {
  const glob = new (globalThis as any).Bun.Glob('*.hooks.ts')
  return [...(glob.scanSync({ cwd: GENERATED_DIR }) as string[])]
}

/**
 * Every Prisma call resolves to a truthy stand-in, so a cloud `beforeList` that
 * only reads a row to authorize the caller gets through to its ordering.
 */
function tolerantPrisma(): any {
  const make = (): any =>
    new Proxy(function standIn() {} as any, {
      get: (_target, prop) => (prop === 'then' ? undefined : make()),
      apply: () => make(),
    })
  return make()
}

function permissiveCtx(): any {
  return {
    body: {},
    params: {},
    // `sessionId` lets the chat-message cloud hook reach its ordering instead of
    // rejecting the read as unscoped; other sets ignore params they don't read.
    query: { sessionId: 'sess-1' },
    userId: 'user-1',
    tunnelAuthenticated: true,
    auth: { userId: 'user-1' },
    prisma: tolerantPrisma(),
  }
}

type HookSet = { beforeList?: (ctx: any) => Promise<any> }

type Pair = {
  module: string
  localExport: string
  cloudExport: string
  local: HookSet
  cloud: HookSet
}

async function hookPairs(): Promise<{ pairs: Pair[]; localExports: string[] }> {
  const files = hookFiles()
  const pairs: Pair[] = []
  const localExports: string[] = []

  for (const file of files) {
    const mod = (await import(join(GENERATED_DIR, file))) as Record<string, unknown>
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.startsWith('local') || !exportName.endsWith('Hooks')) continue
      if (!value || typeof value !== 'object') continue
      localExports.push(exportName)
      const modelName = exportName.slice('local'.length)
      const cloudName = modelName.charAt(0).toLowerCase() + modelName.slice(1)
      const cloud = mod[cloudName]
      if (!cloud || typeof cloud !== 'object') continue
      pairs.push({
        module: file,
        localExport: exportName,
        cloudExport: cloudName,
        local: value as HookSet,
        cloud: cloud as HookSet,
      })
    }
  }

  return { pairs, localExports }
}

describe('local hook sets keep the cloud default list order', () => {
  test('every local<Model>Hooks export has a cloud set to compare against', async () => {
    const { pairs, localExports } = await hookPairs()
    expect(pairs.map((pair) => pair.localExport).sort()).toEqual([...localExports].sort())
  })

  test('the sets this card fixes carry the order', async () => {
    const { pairs } = await hookPairs()
    const ordered = pairs.filter(
      (pair) => pair.localExport === 'localChatMessageHooks' || pair.localExport === 'localChatSessionHooks',
    )
    expect(ordered).toHaveLength(2)
    for (const pair of ordered) {
      expect(typeof pair.local.beforeList).toBe('function')
      const result = await pair.local.beforeList!(permissiveCtx())
      expect(result?.data?.orderBy).toBeDefined()
    }
  })

  test('a cloud default orderBy is never missing from the local set', async () => {
    for (const pair of (await hookPairs()).pairs) {
      if (typeof pair.cloud.beforeList !== 'function') continue

      const cloudResult = await pair.cloud.beforeList(permissiveCtx())
      const cloudOrder = cloudResult?.data?.orderBy
      if (!cloudOrder) continue

      expect(
        typeof pair.local.beforeList,
        `${pair.module}: ${pair.cloudExport}.beforeList defaults orderBy ${JSON.stringify(cloudOrder)} ` +
          `but ${pair.localExport} has no beforeList`,
      ).toBe('function')

      const localResult = await pair.local.beforeList!(permissiveCtx())
      expect(
        localResult?.data?.orderBy,
        `${pair.module}: ${pair.localExport} must default the same orderBy as ${pair.cloudExport}`,
      ).toEqual(cloudOrder)
    }
  })
})
