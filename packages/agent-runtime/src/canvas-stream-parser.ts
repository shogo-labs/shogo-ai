// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasStreamParser — Incremental component extractor for streaming canvas_update tool calls.
 *
 * Accumulates JSON delta fragments and extracts complete component objects
 * from the `components` array as they close, enabling progressive canvas
 * rendering while the LLM is still generating the tool call arguments.
 *
 * Uses simple brace/bracket depth tracking rather than a full incremental
 * JSON parser — we only need to find complete `{...}` objects at depth 1
 * within the components array.
 */

export interface StreamedComponent {
  id: string
  component: string
  [key: string]: unknown
}

export interface CanvasStreamParserCallbacks {
  onSurfaceId: (surfaceId: string) => void
  onComponents: (components: StreamedComponent[]) => void
}

const enum ParserPhase {
  /** Haven't found the components array yet */
  Scanning,
  /** Inside the components array, looking for objects */
  InArray,
  /** Done (array closed or abandoned) */
  Done,
}

export class CanvasStreamParser {
  private buffer = ''
  private phase = ParserPhase.Scanning as ParserPhase
  private surfaceId: string | null = null
  private emittedIds = new Set<string>()

  private objectStart = -1
  private braceDepth = 0
  private inString = false
  private escape = false
  private scanPos = 0

  constructor(private callbacks: CanvasStreamParserCallbacks) {}

  feed(delta: string): void {
    this.buffer += delta

    if (!this.surfaceId) {
      this.trySurfaceId()
    }

    if (this.phase === ParserPhase.Scanning) {
      this.tryEnterComponentsArray()
    }

    if (this.phase === ParserPhase.InArray) {
      this.scanForComponents()
    }
  }

  private trySurfaceId(): void {
    const match = this.buffer.match(/"surfaceId"\s*:\s*"([^"]+)"/)
    if (match) {
      this.surfaceId = match[1]
      this.callbacks.onSurfaceId(this.surfaceId)
    }
  }

  private tryEnterComponentsArray(): void {
    const idx = this.buffer.indexOf('"components"')
    if (idx === -1) return

    const afterKey = this.buffer.indexOf('[', idx + '"components"'.length)
    if (afterKey === -1) return

    this.phase = ParserPhase.InArray
    this.objectStart = -1
    this.braceDepth = 0
    this.inString = false
    this.escape = false
    this.scanPos = afterKey + 1

    this.scanForComponents()
  }

  /**
   * Scan the buffer from the current scanPos to find complete component objects.
   * Tracks brace depth: `{` at depth 0 starts a component, the matching `}`
   * (depth back to 0) closes it.
   */
  private scanForComponents(): void {
    for (let i = this.scanPos; i < this.buffer.length; i++) {
      const ch = this.buffer[i]

      if (this.escape) {
        this.escape = false
        continue
      }

      if (this.inString) {
        if (ch === '\\') {
          this.escape = true
        } else if (ch === '"') {
          this.inString = false
        }
        continue
      }

      if (ch === '"') {
        this.inString = true
        continue
      }

      if (ch === '{') {
        if (this.braceDepth === 0) {
          this.objectStart = i
        }
        this.braceDepth++
      } else if (ch === '}') {
        this.braceDepth--
        if (this.braceDepth === 0 && this.objectStart !== -1) {
          this.emitObject(this.objectStart, i + 1)
          this.objectStart = -1
        }
      } else if (ch === ']' && this.braceDepth === 0) {
        this.phase = ParserPhase.Done
        this.scanPos = i + 1
        return
      }
    }
    this.scanPos = this.buffer.length
  }

  private emitObject(start: number, end: number): void {
    const raw = this.buffer.slice(start, end)
    try {
      const obj = JSON.parse(raw)
      if (typeof obj.id === 'string' && typeof obj.component === 'string' && !this.emittedIds.has(obj.id)) {
        this.emittedIds.add(obj.id)
        this.callbacks.onComponents([obj as StreamedComponent])
      }
    } catch {
      // Incomplete or malformed — skip, will be caught by final tool execution
    }
  }

  getSurfaceId(): string | null {
    return this.surfaceId
  }

  getEmittedCount(): number {
    return this.emittedIds.size
  }
}
