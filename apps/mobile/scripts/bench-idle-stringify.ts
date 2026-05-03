// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Microbenchmark for the cost the previous `idleTimeoutRef` effect was
 * paying *per stream chunk*: the full-tree JSON.stringify of every
 * message's parts.
 *
 * Loads the same long-chat fixture the profiler harness uses, then runs
 * the (removed) hashing code against it to report time-per-iteration.
 * Multiply by the number of chunks a streaming turn emits to estimate
 * the main-thread freeze the fix removed.
 *
 * Run:
 *   bun run apps/mobile/scripts/bench-idle-stringify.ts
 */
import fixture from "../test/fixtures/long-chat-session.json"

interface FixtureMessage {
  id: string
  role: string
  content?: string
  parts?: Array<Record<string, unknown>>
}

const messages = (fixture as { messages: FixtureMessage[] }).messages

// Verbatim copy of the body of the OLD effect (pre-PR-2). Kept here only
// to measure what we removed.
function oldStringifyHash(msgs: FixtureMessage[]): string {
  return msgs
    .map((m) => {
      const top = (m as { content?: unknown }).content
      if (typeof top === "string" && top.length > 0) return top
      return (m.parts || [])
        .map((p) => {
          try {
            return JSON.stringify(p)
          } catch {
            const part = p as { text?: string; type?: string }
            return part.text || part.type || ""
          }
        })
        .join("|")
    })
    .join("\n")
}

function ms(n: number): string {
  return n.toFixed(2) + "ms"
}

function bench(label: string, runs: number, fn: () => void) {
  // Warmup
  for (let i = 0; i < 5; i++) fn()

  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const sum = samples.reduce((a, b) => a + b, 0)
  const mean = sum / samples.length
  const p50 = samples[Math.floor(samples.length * 0.5)]
  const p95 = samples[Math.floor(samples.length * 0.95)]
  const max = samples[samples.length - 1]
  console.log(
    `${label.padEnd(28)} runs=${runs.toString().padStart(4)}  ` +
      `mean=${ms(mean).padStart(8)}  ` +
      `p50=${ms(p50).padStart(8)}  ` +
      `p95=${ms(p95).padStart(8)}  ` +
      `max=${ms(max).padStart(8)}`,
  )
}

const totalParts = messages.reduce(
  (acc, m) => acc + (m.parts?.length ?? 0),
  0,
)
const fixtureBytes = JSON.stringify(messages).length
console.log(
  `Fixture: ${messages.length} messages, ${totalParts} parts, ` +
    `${(fixtureBytes / 1024).toFixed(1)} KB serialized\n`,
)

bench("oldStringifyHash (full tree)", 50, () => {
  const _hash = oldStringifyHash(messages)
  // Anchor reference so the engine doesn't DCE the call.
  if (_hash.length < 0) throw new Error("unreachable")
})

// Compare with the cost of the new approach, which is just the React
// dep-check (effectively free).
bench("noopRefIdentityCheck", 50, () => {
  // Mirror what the new useEffect does on each chunk: nothing JS-side.
  // We charge it the cost of one ref read + one comparison so the
  // microbenchmark records *something* measurable.
  const ref = { current: null as FixtureMessage[] | null }
  const changed = ref.current !== messages
  ref.current = messages
  if (!changed && fixtureBytes === 0) throw new Error("unreachable")
})

console.log(
  "\nEach `oldStringifyHash` run is what the previous code paid PER " +
    "STREAM CHUNK on a session this size. The AI SDK typically delivers " +
    "10–60 chunks per second during active streaming.",
)
