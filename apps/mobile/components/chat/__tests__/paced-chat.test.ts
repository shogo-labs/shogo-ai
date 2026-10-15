// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { Chat } from "@ai-sdk/react"
import { createPacedPublisher, PACED_CHAT_SDK_HOOKS, PacedChat } from "../paced-chat"

function fakeClock() {
  let t = 0
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  const microtasks: Array<() => void> = []
  let nextId = 1
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
    schedule(fn: () => void, ms: number) {
      const id = nextId++
      timers.push({ at: t + ms, fn, id })
      return id
    },
    cancelScheduled(handle: unknown) {
      const i = timers.findIndex((x) => x.id === handle)
      if (i >= 0) timers.splice(i, 1)
    },
    afterCommit(fn: () => void) {
      microtasks.push(fn)
    },
    runMicrotasks() {
      while (microtasks.length) microtasks.shift()!()
    },
    /** Run every timer due at the current time, plus its microtasks. */
    runDue() {
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > t) return
        timers.shift()
        next.fn()
        this.runMicrotasks()
      }
    },
    pending: () => timers.length,
    nextAt: () => (timers.length ? Math.min(...timers.map((x) => x.at)) : null),
  }
}

describe("createPacedPublisher", () => {
  test("never publishes synchronously, and coalesces requests into one publication per macrotask", () => {
    const clock = fakeClock()
    let calls = 0
    const pub = createPacedPublisher(() => calls++, { waitMs: 50, ...clock })
    for (let i = 0; i < 500; i++) pub.request()
    expect(calls).toBe(0)
    expect(clock.pending()).toBe(1)
    clock.runDue()
    expect(calls).toBe(1)
  })

  test("waits max(waitMs, last commit cost) after the previous commit finished", () => {
    const clock = fakeClock()
    let calls = 0
    // Each publication "renders" for 130ms (a heavy turn).
    const pub = createPacedPublisher(
      () => {
        calls++
        clock.advance(130)
      },
      { waitMs: 50, ...clock },
    )
    pub.request()
    clock.runDue()
    expect(calls).toBe(1)
    // Commit ended at t=130; next allowed at 130 + max(50, 130) = 260.
    pub.request()
    expect(clock.nextAt()).toBe(260)
    clock.advance(129)
    clock.runDue()
    expect(calls).toBe(1)
    clock.advance(1)
    clock.runDue()
    expect(calls).toBe(2)
  })

  test("cheap renders are paced by waitMs", () => {
    const clock = fakeClock()
    const pub = createPacedPublisher(() => clock.advance(2), { waitMs: 50, ...clock })
    pub.request()
    clock.runDue()
    pub.request()
    expect(clock.nextAt()).toBe(2 + 50)
  })

  test("flush publishes a pending request immediately and cancels its timer", () => {
    const clock = fakeClock()
    let calls = 0
    const pub = createPacedPublisher(() => calls++, { waitMs: 50, ...clock })
    pub.flush()
    expect(calls).toBe(0)
    pub.request()
    expect(pub.isPending()).toBe(true)
    pub.flush()
    expect(calls).toBe(1)
    expect(pub.isPending()).toBe(false)
    expect(clock.pending()).toBe(0)
  })

  test("cancel drops pending work and ignores later requests", () => {
    const clock = fakeClock()
    let calls = 0
    const pub = createPacedPublisher(() => calls++, { waitMs: 50, ...clock })
    pub.request()
    pub.cancel()
    pub.request()
    clock.advance(1000)
    clock.runDue()
    expect(calls).toBe(0)
  })
})

describe("PacedChat", () => {
  test("the installed @ai-sdk/react Chat still has the internal hooks PacedChat wraps", () => {
    // Fails on an SDK upgrade that renames or removes them, before the
    // PacedChat constructor would throw at runtime.
    const chat = new Chat({})
    for (const name of PACED_CHAT_SDK_HOOKS) {
      expect(typeof chat[name]).toBe("function")
    }
    expect(() => new PacedChat({})).not.toThrow()
  })

  test("message subscribers are not called synchronously from a messages update", async () => {
    const chat = new PacedChat({ publishWaitMs: 10 })
    let calls = 0
    const unsubscribe = chat["~registerMessagesCallback"](() => calls++, 5)
    chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]
    chat.messages = [...chat.messages, { id: "a1", role: "assistant", parts: [] }]
    expect(calls).toBe(0)
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(1)
    unsubscribe()
  })

  test("a status change flushes the pending message publication first", () => {
    const chat = new PacedChat({ publishWaitMs: 10_000 })
    const order: string[] = []
    chat["~registerMessagesCallback"](() => order.push(`messages:${chat.messages.length}`))
    chat["~registerStatusCallback"](() => order.push(`status:${chat.status}`))
    ;(chat as any).setStatus({ status: "streaming" })
    order.length = 0
    chat.messages = [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }]
    expect(order).toEqual([])
    ;(chat as any).setStatus({ status: "ready" })
    expect(order).toEqual(["messages:1", "status:ready"])
  })

  test("an error change flushes the pending message publication first", () => {
    const chat = new PacedChat({ publishWaitMs: 10_000 })
    const order: string[] = []
    chat["~registerMessagesCallback"](() => order.push("messages"))
    chat["~registerErrorCallback"](() => order.push("error"))
    chat.messages = [{ id: "u1", role: "user", parts: [] }]
    ;(chat as any).setStatus({ status: "error", error: new Error("boom") })
    expect(order.indexOf("messages")).toBeLessThan(order.indexOf("error"))
  })

  test("unsubscribing cancels a pending publication", async () => {
    const chat = new PacedChat({ publishWaitMs: 5 })
    let calls = 0
    const unsubscribe = chat["~registerMessagesCallback"](() => calls++)
    chat.messages = [{ id: "u1", role: "user", parts: [] }]
    unsubscribe()
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(0)
  })
})
