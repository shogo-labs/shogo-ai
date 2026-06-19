// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * ReadySignalDetector — monitors terminal output for "dev server ready"
 * signals and emits events when a URL becomes available.
 *
 * Matches patterns like:
 *   - http://localhost:8081
 *   - "compiled successfully"
 *   - "ready", "listening on"
 *   - "Waiting on http://..." (Metro bundler)
 *   - "server.js 1.23 MB (entry point)" (bun build output)
 */

export interface ReadySignal {
  /** The detected URL, if any. */
  url?: string
  /** Human-readable description of what was detected. */
  description: string
  /** The raw line that triggered the detection. */
  rawLine: string
}

export type ReadySignalListener = (signal: ReadySignal) => void

/** Patterns that indicate the server is ready. */
const READY_PATTERNS: Array<{ pattern: RegExp; extractUrl?: boolean; description: string }> = [
  { pattern: /https?:\/\/localhost:\d+/g, extractUrl: true, description: 'Dev server URL detected' },
  { pattern: /Waiting on (https?:\/\/[^\s]+)/, extractUrl: true, description: 'Metro bundler waiting on URL' },
  { pattern: /compiled successfully/i, description: 'Compiled successfully' },
  { pattern: /\bready\b.*\b(port|http|listening)\b/i, description: 'Server ready' },
  { pattern: /\blistening on\b.*\b(:\d+|http|\d+)/i, description: 'Listening on port' },
  { pattern: /\bstarted\b.*\b(server|bundler|dev)\b/i, description: 'Server started' },
  { pattern: /\(entry point\)/, description: 'Build completed (entry point)' },
  { pattern: /Bundled \d+ modules/, description: 'Build completed (modules bundled)' },
  { pattern: /Hot reload enabled/i, description: 'Hot reload enabled' },
]

export class ReadySignalDetector {
  private listeners: Set<ReadySignalListener> = new Set()
  private detected = false
  private accumulated = ''
  private disposed = false

  /** Subscribe to ready signals. Returns unsubscribe function. */
  onReady(listener: ReadySignalListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Whether a ready signal has already been detected. */
  isReady(): boolean {
    return this.detected
  }

  /**
   * Feed output data into the detector.
   * Call this for each chunk of terminal output.
   */
  feedOutput(data: string): void {
    if (this.disposed || this.detected) return

    this.accumulated += data
    const lines = this.accumulated.split('\n')
    // Keep the last line (might be incomplete)
    this.accumulated = lines.pop() ?? ''

    for (const line of lines) {
      this.checkLine(line)
    }
  }

  /**
   * Flush any remaining accumulated data (partial line).
   * Called when a command finishes.
   */
  flush(): void {
    if (this.disposed || this.detected) return
    if (this.accumulated.trim()) {
      this.checkLine(this.accumulated)
    }
    this.accumulated = ''
  }

  /** Reset detection state (for reuse across commands). */
  reset(): void {
    this.detected = false
    this.accumulated = ''
  }

  /** Clean up all listeners. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.accumulated = ''
  }

  private checkLine(line: string): void {
    for (const { pattern, extractUrl, description } of READY_PATTERNS) {
      const match = line.match(pattern)
      if (match) {
        let url: string | undefined
        if (extractUrl) {
          // Extract URL from the match
          const urlMatch = line.match(/https?:\/\/[^\s"')]+/)
          url = urlMatch?.[0]
        }

        this.detected = true
        const signal: ReadySignal = { url, description, rawLine: line }
        for (const listener of this.listeners) {
          listener(signal)
        }
        return // Only fire once
      }
    }
  }
}
