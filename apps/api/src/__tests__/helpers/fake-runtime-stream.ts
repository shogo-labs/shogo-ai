// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A runtime SSE stream, replayed on a wall-clock schedule (SHO-277).
 *
 * The load tests drive the **real** persistence path (`trackUsageFromStream`)
 * with frames shaped exactly like the ones `packages/shogo-worker` emits, so a
 * change to that protocol breaks these tests instead of silently making the
 * measurement meaningless.
 *
 * `makeAgentTurnFrames` builds one tool-heavy turn: a `data-turn-start`, text
 * deltas interleaved with `tool-input-available` / `tool-output-available`
 * pairs, and a terminal `data-turn-complete`. `makeTimedSseStream` replays
 * them with a delay between frames, so a turn with 110 tool calls takes real
 * seconds instead of landing in one microtask.
 */

export interface TurnFrameScript {
  /** Every `data:` payload, in order, as the runtime would send them. */
  frames: string[]
  /** The tool outputs, so a test can assert the final persisted parts. */
  toolOutputs: Array<{ toolCallId: string; toolName: string; output: unknown }>
  /** Concatenation of every text delta — what `content` must equal at the end. */
  text: string
}

export interface TurnFrameOptions {
  /** Number of tool round-trips. A real big turn is ~110. */
  toolCount?: number
  /**
   * Tool output sizes in bytes. Real tool parts range from a short grep hit to
   * a 20 KB file read, and the mix is what makes a big turn big: 110 parts
   * averaging ~11 KB is the ~1.2 MB/turn the evidence measured.
   */
  outputBytesRange?: [number, number]
  /** Text deltas before the first tool and after the last one. */
  textDeltas?: number
  /** Bytes per text delta. */
  textDeltaBytes?: number
  /** Distinct tool names, cycled — keeps each tool call a different shape. */
  toolNames?: string[]
  turnId?: string
}

const DEFAULT_TOOL_NAMES = ['read_file', 'grep', 'list_directory', 'read_file']

function filler(bytes: number, seed: number): string {
  // A repeated, deterministic blob: compressible (like real file content) and
  // large enough that the snapshot write is genuinely costly.
  const unit = `line ${seed} of a file the agent read\n`
  return unit.repeat(Math.max(1, Math.ceil(bytes / unit.length))).slice(0, bytes)
}

export function makeAgentTurnFrames(options: TurnFrameOptions = {}): TurnFrameScript {
  const toolCount = options.toolCount ?? 110
  const [minOutputBytes, maxOutputBytes] = options.outputBytesRange ?? [2 * 1024, 20 * 1024]
  const textDeltas = options.textDeltas ?? 6
  const textDeltaBytes = options.textDeltaBytes ?? 200
  const toolNames = options.toolNames ?? DEFAULT_TOOL_NAMES
  const turnId = options.turnId ?? `turn-${Math.random().toString(36).slice(2, 10)}`
  const startedAt = Date.now()

  const frames: string[] = []
  const toolOutputs: TurnFrameScript['toolOutputs'] = []
  let text = ''

  const emit = (payload: Record<string, unknown>) => {
    frames.push(`data: ${JSON.stringify(payload)}\n\n`)
  }

  emit({ type: 'data-turn-start', data: { startedAt, turnId } })

  const emitText = (round: number) => {
    for (let i = 0; i < textDeltas; i++) {
      const delta = `${filler(textDeltaBytes, round * 100 + i)} `
      text += delta
      emit({ type: 'text-delta', delta })
    }
  }

  emitText(0)

  for (let i = 0; i < toolCount; i++) {
    const toolCallId = `call-${i}`
    const toolName = toolNames[i % toolNames.length]
    // Deterministic spread across the range, so every tool part has a
    // different size (as it does in a real turn).
    const span = maxOutputBytes - minOutputBytes
    const outputBytes = minOutputBytes + (span > 0 ? ((i * 7919) % span) : 0)
    const output = { success: true, text: filler(outputBytes, i) }
    emit({
      type: 'tool-input-available',
      toolCallId,
      toolName,
      input: { path: `src/file-${i}.ts`, pattern: `needle-${i}` },
    })
    emit({ type: 'tool-output-available', toolCallId, output })
    toolOutputs.push({ toolCallId, toolName, output })
    if (i % 10 === 9) emitText(i + 1)
  }

  emitText(toolCount + 1)
  emit({ type: 'data-turn-complete', data: { status: 'completed', turnId } })

  return { frames, toolOutputs, text }
}

/**
 * Replay `frames` as a `ReadableStream<Uint8Array>` with `intervalMs` between
 * frames. One frame per tick, so the reader loop sees the same chunk pattern
 * the network produces (partial lines, multiple lines per chunk).
 */
export function makeTimedSseStream(frames: string[], intervalMs: number): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let cancelled = false
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let index = 0
      const tick = () => {
        if (cancelled) return
        if (index >= frames.length) {
          try { controller.close() } catch { /* already closed */ }
          return
        }
        // Two frames per tick keeps runs short without looking like one huge
        // chunk — the reader still sees its own chunk boundaries.
        const chunk = frames[index] + (frames[index + 1] ?? '')
        index += 2
        try { controller.enqueue(encoder.encode(chunk)) } catch { return }
        setTimeout(tick, intervalMs)
      }
      setTimeout(tick, 0)
    },
    cancel() {
      cancelled = true
    },
  })
}
