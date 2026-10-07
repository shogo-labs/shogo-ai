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
})
