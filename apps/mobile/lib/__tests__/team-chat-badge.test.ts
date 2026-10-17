// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for the web/desktop unread badge.
 *
 * The badge used to record its count before the IPC call resolved, so a count
 * the OS refused was remembered as applied and the icon stayed stale until the
 * number happened to change again. These tests pin the retry.
 *
 * Run: bun test apps/mobile/lib/__tests__/team-chat-badge.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

type BadgeMod = typeof import('../team-chat-badge')

const ORIGINALS = {
  document: (globalThis as any).document,
  window: (globalThis as any).window,
}

function installEnv(options: { accept?: boolean; resolvesUndefined?: boolean } = {}) {
  const calls: number[] = []
  let accept = options.accept ?? true
  const win: any = {
    shogoDesktop: {
      isDesktop: true,
      setBadgeCount: async (count: number) => {
        calls.push(count)
        if (options.resolvesUndefined) return undefined
        return accept ? { ok: true } : { ok: false, reason: 'no-window' }
      },
    },
  }
  ;(globalThis as any).window = win
  ;(globalThis as any).document = {
    title: 'Shogo chat',
    querySelector: () => null,
  }
  return {
    calls,
    win,
    accept: (value: boolean) => {
      accept = value
    },
  }
}

function uninstallEnv() {
  if (ORIGINALS.document !== undefined) (globalThis as any).document = ORIGINALS.document
  else delete (globalThis as any).document
  if (ORIGINALS.window !== undefined) (globalThis as any).window = ORIGINALS.window
  else delete (globalThis as any).window
}

async function freshModule(): Promise<BadgeMod> {
  return (await import('../team-chat-badge?t=' + Math.random())) as BadgeMod
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('team-chat-badge — desktop dock/taskbar badge', () => {
  beforeEach(() => uninstallEnv())
  afterEach(() => uninstallEnv())

  test('sends the count once, and not again for the same count', async () => {
    const { calls } = installEnv()
    const mod = await freshModule()

    mod.setChatBadgeCount(3)
    await flush()
    mod.setChatBadgeCount(3)
    await flush()

    expect(calls).toEqual([3])
  })

  test('retries a refused count on the next update instead of caching the failure', async () => {
    const env = installEnv({ accept: false })
    const mod = await freshModule()

    mod.setChatBadgeCount(3)
    await flush()
    expect(env.calls).toEqual([3])

    env.accept(true)
    mod.setChatBadgeCount(3)
    await flush()

    expect(env.calls).toEqual([3, 3])
  })

  test('treats a bridge that resolves without a result as applied', async () => {
    const { calls } = installEnv({ resolvesUndefined: true })
    const mod = await freshModule()

    mod.setChatBadgeCount(2)
    await flush()
    mod.setChatBadgeCount(2)
    await flush()

    expect(calls).toEqual([2])
  })

  test('keeps the tab title prefix in sync', async () => {
    installEnv()
    const mod = await freshModule()

    mod.setChatBadgeCount(2)
    expect((globalThis as any).document.title).toBe('(2) Shogo chat')

    mod.setChatBadgeCount(0)
    expect((globalThis as any).document.title).toBe('Shogo chat')
  })

  test('does nothing without a desktop bridge', async () => {
    installEnv()
    ;(globalThis as any).window = {}
    const mod = await freshModule()

    expect(() => mod.setChatBadgeCount(5)).not.toThrow()
  })
})
