// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, expect, test } from "bun:test"
import { coalesceChunkBursts, coalesceChunks } from "../chunk-coalescer"

const seq = (n: number) => ({ type: "data-turn-seq", data: { turnId: "t", seq: n }, transient: true })

async function readAll(stream: ReadableStream<any>): Promise<any[]> {
  const out: any[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) return out
    out.push(value)
  }
}

describe("coalesceChunks", () => {
  test("merges consecutive deltas of the same part", () => {
    expect(
      coalesceChunks([
        { type: "text-start", id: "a" },
        { type: "text-delta", id: "a", delta: "Hel" },
        { type: "text-delta", id: "a", delta: "lo" },
        { type: "text-end", id: "a" },
        { type: "reasoning-delta", id: "r", delta: "x" },
        { type: "reasoning-delta", id: "r", delta: "y" },
        { type: "tool-input-delta", toolCallId: "c", inputTextDelta: '{"a"' },
        { type: "tool-input-delta", toolCallId: "c", inputTextDelta: ":1}" },
      ] as any),
    ).toEqual([
      { type: "text-start", id: "a" },
      { type: "text-delta", id: "a", delta: "Hello" },
      { type: "text-end", id: "a" },
      { type: "reasoning-delta", id: "r", delta: "xy" },
      { type: "tool-input-delta", toolCallId: "c", inputTextDelta: '{"a":1}' },
    ] as any)
  })

  test("never merges across parts or deltas carrying provider metadata", () => {
    const chunks = [
      { type: "text-delta", id: "a", delta: "1" },
      { type: "text-delta", id: "b", delta: "2" },
      { type: "reasoning-delta", id: "r", delta: "3", providerMetadata: { anthropic: { signature: "s" } } },
      { type: "reasoning-delta", id: "r", delta: "4" },
    ] as any
    expect(coalesceChunks(chunks)).toEqual(chunks)
  })

  test("keeps only the last seq heartbeat, at its own position", () => {
    expect(
      coalesceChunks([
        { type: "text-delta", id: "a", delta: "a" },
        seq(1),
        { type: "text-delta", id: "a", delta: "b" },
        seq(2),
        { type: "text-delta", id: "a", delta: "c" },
        { type: "finish" },
      ] as any),
    ).toEqual([
      { type: "text-delta", id: "a", delta: "ab" },
      seq(2),
      { type: "text-delta", id: "a", delta: "c" },
      { type: "finish" },
    ] as any)
  })
})

describe("coalesceChunkBursts", () => {
  test("a buffered replay collapses to one delta per part", async () => {
    const burst: any[] = [{ type: "start" }, { type: "text-start", id: "a" }]
    for (let i = 0; i < 10_000; i++) burst.push({ type: "text-delta", id: "a", delta: "w " })
    burst.push(seq(10_002))
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of burst) controller.enqueue(chunk)
        controller.close()
      },
    })
    const out = await readAll(coalesceChunkBursts(source))
    expect(out.map((c) => c.type)).toEqual(["start", "text-start", "text-delta", "data-turn-seq"])
    expect(out[2].delta).toBe("w ".repeat(10_000))
  })

  test("a steady stream still delivers a batch every maxWaitMs", async () => {
    let push!: (chunk: any) => void
    let close!: () => void
    const source = new ReadableStream({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk)
        close = () => controller.close()
      },
    })
    const reading = readAll(coalesceChunkBursts(source, { idleMs: 20, maxWaitMs: 40 }))
    for (let i = 0; i < 10; i++) {
      push({ type: "text-delta", id: "a", delta: String(i) })
      await new Promise((r) => setTimeout(r, 10))
    }
    close()
    const out = await reading
    expect(out.length).toBeGreaterThan(1)
    expect(out.map((c) => c.delta).join("")).toBe("0123456789")
  })

  test("chunks that arrive apart are delivered separately", async () => {
    let push!: (chunk: any) => void
    let close!: () => void
    const source = new ReadableStream({
      start(controller) {
        push = (chunk) => controller.enqueue(chunk)
        close = () => controller.close()
      },
    })
    const reading = readAll(coalesceChunkBursts(source, { idleMs: 5 }))
    push({ type: "text-delta", id: "a", delta: "a" })
    await new Promise((r) => setTimeout(r, 30))
    push({ type: "text-delta", id: "a", delta: "b" })
    close()
    expect((await reading).map((c) => c.delta)).toEqual(["a", "b"])
  })

  test("yields to the event loop while the consumer is busy, so renders can commit between slices", async () => {
    const burst: any[] = []
    for (let i = 0; i < 30; i++) burst.push({ type: "text-start", id: `p${i}` })
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of burst) controller.enqueue(chunk)
        controller.close()
      },
    })
    let yields = 0
    const out = coalesceChunkBursts(source, {
      sliceMs: 5,
      yieldToEventLoop: async () => {
        yields++
        await new Promise((r) => setTimeout(r, 0))
      },
    })
    const reader = out.getReader()
    let seen = 0
    while (true) {
      const { done } = await reader.read()
      if (done) break
      seen++
      const until = performance.now() + 6 // the SDK applying a chunk
      while (performance.now() < until) {}
    }
    expect(seen).toBe(30)
    expect(yields).toBeGreaterThanOrEqual(25)
  })

  test("a fast consumer never pays for a yield", async () => {
    const burst: any[] = []
    for (let i = 0; i < 200; i++) burst.push({ type: "text-start", id: `p${i}` })
    const source = new ReadableStream({
      start(controller) {
        for (const chunk of burst) controller.enqueue(chunk)
        controller.close()
      },
    })
    let yields = 0
    const out = await readAll(
      coalesceChunkBursts(source, {
        yieldToEventLoop: async () => {
          yields++
        },
      }),
    )
    expect(out).toHaveLength(200)
    expect(yields).toBe(0)
  })

  test("cancelling mid-burst stops delivery and cancels the source", async () => {
    let cancelled = false
    const source = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 50; i++) controller.enqueue({ type: "text-start", id: `p${i}` })
      },
      cancel() {
        cancelled = true
      },
    })
    const reader = coalesceChunkBursts(source).getReader()
    expect((await reader.read()).done).toBe(false)
    await reader.cancel()
    expect(cancelled).toBe(true)
  })

  test("a source error surfaces to the reader instead of hanging", async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-start", id: "a" })
        controller.error(new Error("boom"))
      },
    })
    const reader = coalesceChunkBursts(source).getReader()
    await expect(
      (async () => {
        while (true) {
          const { done } = await reader.read()
          if (done) return
        }
      })(),
    ).rejects.toThrow("boom")
  })
})
