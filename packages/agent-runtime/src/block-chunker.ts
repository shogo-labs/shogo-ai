// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Block Chunker — Progressive Response Delivery
 *
 * Buffers streaming text deltas and flushes to a callback at natural
 * boundaries (paragraph breaks, code fence closings). Prevents "single-line
 * spam" by coalescing small deltas and splitting very long blocks.
 *
 * Inspired by OpenClaw's EmbeddedBlockChunker.
 */

export interface BlockChunkerConfig {
  /** Min characters before flushing a chunk (default: 80) */
  minChars: number
  /** Max characters before force-flushing (default: 2000) */
  maxChars: number
  /** Idle time in ms before flushing whatever is buffered (default: 500) */
  idleMs: number
}

const DEFAULT_CONFIG: BlockChunkerConfig = {
  minChars: 80,
  maxChars: 2000,
  idleMs: 500,
}

export class BlockChunker {
  private buffer = ''
  private config: BlockChunkerConfig
  private onFlush: (chunk: string) => void
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private insideCodeFence = false
  private flushedAny = false

  constructor(onFlush: (chunk: string) => void, config: Partial<BlockChunkerConfig> = {}) {
    this.onFlush = onFlush
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  push(delta: string): void {
    this.buffer += delta
    this.resetIdleTimer()

    this.recomputeCodeFenceState()

    if (this.buffer.length >= this.config.maxChars) {
      this.flush()
      return
    }

    if (this.buffer.length >= this.config.minChars) {
      const breakIdx = this.findNaturalBreak()
      if (breakIdx > 0 && !this.isInsideCodeFenceAt(breakIdx)) {
        const chunk = this.buffer.substring(0, breakIdx)
        this.buffer = this.buffer.substring(breakIdx)
        this.emitChunk(chunk)
      }
    }
  }

  /** Force-flush any remaining buffered text */
  flush(): void {
    this.clearIdleTimer()
    if (this.buffer.length > 0) {
      this.emitChunk(this.buffer)
      this.buffer = ''
    }
  }

  /** Whether any chunks have been emitted */
  get hasFlushed(): boolean {
    return this.flushedAny
  }

  /** Current buffer contents (for inspection) */
  get pending(): string {
    return this.buffer
  }

  dispose(): void {
    this.clearIdleTimer()
  }

  private emitChunk(text: string): void {
    const trimmed = text.trimEnd()
    if (trimmed.length > 0) {
      this.flushedAny = true
      this.onFlush(trimmed)
    }
  }

  private recomputeCodeFenceState(): void {
    const fenceMatches = this.buffer.match(/```/g)
    this.insideCodeFence = fenceMatches ? fenceMatches.length % 2 !== 0 : false
  }

  /** Check if a position in the buffer falls inside an unclosed code fence */
  private isInsideCodeFenceAt(pos: number): boolean {
    const prefix = this.buffer.substring(0, pos)
    const fences = prefix.match(/```/g)
    return fences ? fences.length % 2 !== 0 : false
  }

  private findNaturalBreak(): number {
    const doubleNewline = this.buffer.lastIndexOf('\n\n')
    if (doubleNewline > this.config.minChars / 2) return doubleNewline + 2

    const singleNewline = this.buffer.lastIndexOf('\n')
    if (singleNewline > this.config.minChars / 2) return singleNewline + 1

    return -1
  }

  private resetIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      if (this.buffer.length > 0) {
        this.flush()
      }
    }, this.config.idleMs)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
