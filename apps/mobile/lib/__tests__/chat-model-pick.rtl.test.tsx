// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-497 — the composer's model pick survives a send.
 *
 * The bug: pick Opus, send, and the picker reads Auto again. The server stamped
 * every reply with the model *the run* used (the agent's model, usually `auto`)
 * and the client took the newest stamp of any role, so the reply rewrote the
 * pick. Both halves are pinned here on the real code `ChatPanel` runs —
 * `useChatComposerMemory` → `lastUserModelStamp` → `resolveChatModel` — with the
 * messages a turn actually produces (a user row carrying the pick, an assistant
 * row carrying what ran).
 *
 * `ChatPanel` itself is not rendered: it needs the whole navigation/stores tree.
 * Every function in its model-resolution chain is exercised here unchained from
 * that tree, so a regression in any of them fails this file.
 *
 *   bun test apps/mobile/lib/__tests__/chat-model-pick.rtl.test.tsx
 */
import { afterEach, beforeAll, describe, expect, test, mock } from 'bun:test'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { createReactNativeMock } from '../../test/react-native-mock'

const stored = new Map<string, string>()
mock.module('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => stored.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      stored.set(k, v)
    },
    removeItem: async (k: string) => {
      stored.delete(k)
    },
  },
}))

mock.module('react-native', () =>
  createReactNativeMock({ Platform: { OS: 'web', select: (spec: any) => spec.web ?? spec.default } as any }),
)

const OPUS = '11111111-2222-3333-4444-555555555555'

type Msg = { id: string; role: 'user' | 'assistant'; model?: string | null; createdAt: number }

type Mod = typeof import('../chat-composer-memory')
let mod: Mod
beforeAll(async () => {
  mod = await import('../chat-composer-memory')
})

afterEach(cleanup)

/** Exactly the chain ChatPanel runs to decide what the picker shows. */
function usePickerModel(args: { memoryKey: string; messages: Msg[] }) {
  const composer = mod.useChatComposerMemory(args.memoryKey)
  const stamp = mod.lastUserModelStamp(args.messages)
  const model = mod.resolveChatModel({
    record: composer.record,
    lastStampedModel: stamp?.model ?? null,
    lastStampedAt: stamp?.createdAt ?? 0,
  })
  return { model, ready: composer.ready, pick: composer.saveModel }
}

/** One turn as the server writes it: the question (the pick) and the reply. */
function send(messages: Msg[], picked: string, ran: string | null, at: number): Msg[] {
  return [
    ...messages,
    { id: `u-${at}`, role: 'user', model: picked, createdAt: at },
    { id: `a-${at}`, role: 'assistant', model: ran, createdAt: at + 1 },
  ]
}

async function readyHook(memoryKey: string) {
  const hook = renderHook(
    ({ messages }: { messages: Msg[] }) => usePickerModel({ memoryKey, messages }),
    { initialProps: { messages: [] as Msg[] } },
  )
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  return hook
}

describe('the picked model survives a send (SHO-497)', () => {
  test('AC1: pick Opus, send twice while the server stamps the replies auto', async () => {
    const hook = await readyHook('project:p-1:chat-c1')

    act(() => hook.result.current.pick(OPUS))
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))

    // Send #1: the user row carries the pick, the reply was stamped with the
    // model that actually ran (Auto's routed tier).
    hook.rerender({ messages: send([], OPUS, 'auto', 100) })
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))

    // Send #2: still Opus after another auto-stamped reply.
    hook.rerender({ messages: send(send([], OPUS, 'auto', 100), OPUS, 'auto', 200) })
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))
  })

  test('a reply stamped `advanced` never becomes the pick', async () => {
    // Rows written before the fix carry the legacy sentinel; they must not be
    // adopted (nor reset to Auto) either.
    const hook = await readyHook('project:p-1:chat-c2')

    act(() => hook.result.current.pick(OPUS))
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))

    hook.rerender({
      messages: [
        { id: 'u-1', role: 'user', createdAt: 100 },
        { id: 'a-1', role: 'assistant', model: 'advanced', createdAt: 101 },
      ],
    })

    // No usable user stamp, so the explicit pick is what the picker shows.
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))
  })

  test('a send from another device still sets the chat model', async () => {
    // Cross-device sync is the reason a user stamp outranks a local pick.
    const hook = await readyHook('project:p-1:chat-c3')

    act(() => hook.result.current.pick(OPUS))
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))

    hook.rerender({
      messages: send([], 'anthropic-sonnet-4-6', 'anthropic-sonnet-4-6', Date.now() + 60_000),
    })

    await waitFor(() => expect(hook.result.current.model).toBe('anthropic-sonnet-4-6'))
  })

  test('AC2: the pick survives switching chats away and back', async () => {
    const hook = await readyHook('project:p-1:chat-c4')

    act(() => hook.result.current.pick(OPUS))
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))
    hook.rerender({ messages: send([], OPUS, 'auto', 100) })
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))

    // Switch to another chat, then back: the record is per chat key.
    const other = renderHook(() => usePickerModel({ memoryKey: 'project:p-1:chat-other', messages: [] }))
    await waitFor(() => expect(other.result.current.ready).toBe(true))
    expect(other.result.current.model).toBeNull()

    hook.rerender({ messages: send([], OPUS, 'auto', 100) })
    await waitFor(() => expect(hook.result.current.model).toBe(OPUS))
  })
})
