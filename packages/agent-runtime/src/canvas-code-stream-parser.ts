// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * CanvasCodeStreamParser — Incrementally parses write_file and edit_file tool
 * call JSON to extract canvas code and attempt compilation as it streams in.
 *
 * write_file: buffers the "content" field and attempts Sucrase compilation
 * edit_file:  once "path" and "old_string" are known, reads the current file,
 *             buffers "new_string", applies the replacement, and compiles.
 *
 * Successful compiles are broadcast as renderCode preview events so the UI
 * updates before the tool call finishes.
 */

import { transform } from 'sucrase'

const CANVAS_CODE_RE = /^canvas\/[^/]+\.(tsx|ts|jsx|js)$/

export interface CanvasCodeStreamCallbacks {
  onPreview: (surfaceId: string, code: string) => void
  /** Returns current source code for a surface, used by edit_file streaming. */
  getCurrentCode?: (surfaceId: string) => string | undefined
}

type ToolMode = 'write_file' | 'edit_file'

/**
 * Parses streaming JSON tool arguments for write_file/edit_file to detect
 * canvas file writes and attempt live preview compilation.
 */
export class CanvasCodeStreamParser {
  private buffer = ''
  private pathValue: string | null = null
  private mode: ToolMode
  private callbacks: CanvasCodeStreamCallbacks
  private dead = false
  private lastBroadcastLen = 0

  // write_file fields
  private contentStart = -1
  private contentBuffer = ''

  // edit_file fields
  private oldStringValue: string | null = null
  private newStringStart = -1
  private newStringBuffer = ''
  private baseFileContent: string | null = null

  private static MIN_DELTA_CHARS = 80

  constructor(mode: ToolMode, callbacks: CanvasCodeStreamCallbacks) {
    this.mode = mode
    this.callbacks = callbacks
  }

  feed(delta: string): void {
    if (this.dead) return
    this.buffer += delta

    if (!this.pathValue) {
      this.tryExtractPath()
    }
    if (!this.pathValue) return

    if (this.mode === 'write_file') {
      this.feedWriteFile()
    } else {
      this.feedEditFile()
    }
  }

  flush(): void {
    if (this.dead) return
    if (this.mode === 'write_file' && this.pathValue && this.contentStart !== -1) {
      this.updateJsonString(this.contentStart, (v) => { this.contentBuffer = v })
      this.tryCompilePreview(this.contentBuffer, true)
    } else if (this.mode === 'edit_file' && this.pathValue && this.newStringStart !== -1) {
      this.updateJsonString(this.newStringStart, (v) => { this.newStringBuffer = v })
      const full = this.applyEdit()
      if (full !== null) this.tryCompilePreview(full, true)
    }
    this.dead = true
  }

  isCanvasFile(): boolean {
    return this.pathValue !== null && CANVAS_CODE_RE.test(this.pathValue)
  }

  // ---------------------------------------------------------------------------
  // write_file streaming
  // ---------------------------------------------------------------------------

  private feedWriteFile(): void {
    if (this.contentStart === -1) {
      this.contentStart = this.findStringStart('"content"')
      if (this.contentStart === -1) return
    }
    this.updateJsonString(this.contentStart, (v) => { this.contentBuffer = v })
    this.tryCompilePreview(this.contentBuffer)
  }

  // ---------------------------------------------------------------------------
  // edit_file streaming
  // ---------------------------------------------------------------------------

  private feedEditFile(): void {
    if (this.oldStringValue === null) {
      this.tryExtractOldString()
    }
    if (this.oldStringValue === null) return

    if (this.baseFileContent === null) {
      this.resolveBaseContent()
      if (this.baseFileContent === null) return
    }

    if (this.newStringStart === -1) {
      this.newStringStart = this.findStringStart('"new_string"')
      if (this.newStringStart === -1) return
    }

    this.updateJsonString(this.newStringStart, (v) => { this.newStringBuffer = v })
    const full = this.applyEdit()
    if (full !== null) this.tryCompilePreview(full)
  }

  private tryExtractOldString(): void {
    const match = this.buffer.match(/"old_string"\s*:\s*"/)
    if (!match || match.index === undefined) return
    const start = match.index + match[0].length
    const decoded = this.decodeJsonString(start)
    if (decoded !== null) {
      this.oldStringValue = decoded
    }
  }

  private resolveBaseContent(): void {
    if (!this.pathValue || !this.callbacks.getCurrentCode) return
    const surfaceId = extractSurfaceId(this.pathValue)
    const code = this.callbacks.getCurrentCode(surfaceId)
    if (code !== undefined) {
      this.baseFileContent = code
    }
  }

  private applyEdit(): string | null {
    if (this.baseFileContent === null || this.oldStringValue === null) return null
    const idx = this.baseFileContent.indexOf(this.oldStringValue)
    if (idx === -1) return null
    return (
      this.baseFileContent.slice(0, idx) +
      this.newStringBuffer +
      this.baseFileContent.slice(idx + this.oldStringValue.length)
    )
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private tryExtractPath(): void {
    const match = this.buffer.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (match) {
      const raw = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      if (CANVAS_CODE_RE.test(raw)) {
        this.pathValue = raw
      } else {
        this.dead = true
      }
    }
  }

  private findStringStart(key: string): number {
    const idx = this.buffer.indexOf(key)
    if (idx === -1) return -1
    const colonIdx = this.buffer.indexOf(':', idx + key.length)
    if (colonIdx === -1) return -1
    const quoteIdx = this.buffer.indexOf('"', colonIdx + 1)
    if (quoteIdx === -1) return -1
    return quoteIdx + 1
  }

  /**
   * Decode a complete JSON string starting at `start` in the buffer.
   * Returns null if the closing quote hasn't arrived yet.
   */
  private decodeJsonString(start: number): string | null {
    const raw = this.buffer.slice(start)
    let result = ''
    let i = 0
    while (i < raw.length) {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]
        if (next === 'n') { result += '\n'; i += 2; continue }
        if (next === 't') { result += '\t'; i += 2; continue }
        if (next === '"') { result += '"'; i += 2; continue }
        if (next === '\\') { result += '\\'; i += 2; continue }
        if (next === 'r') { result += '\r'; i += 2; continue }
        result += next; i += 2; continue
      }
      if (raw[i] === '"') return result
      result += raw[i]
      i++
    }
    return null
  }

  /**
   * Incrementally decode a JSON string value from `start`, writing the
   * current decoded value via the setter. Does not require a closing quote.
   */
  private updateJsonString(start: number, set: (v: string) => void): void {
    const raw = this.buffer.slice(start)
    let result = ''
    let i = 0
    while (i < raw.length) {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]
        if (next === 'n') { result += '\n'; i += 2; continue }
        if (next === 't') { result += '\t'; i += 2; continue }
        if (next === '"') { result += '"'; i += 2; continue }
        if (next === '\\') { result += '\\'; i += 2; continue }
        if (next === 'r') { result += '\r'; i += 2; continue }
        result += next; i += 2; continue
      }
      if (raw[i] === '"') break
      result += raw[i]
      i++
    }
    set(result)
  }

  private tryCompilePreview(fullCode: string, force = false): void {
    if (!this.pathValue) return
    const delta = fullCode.length - this.lastBroadcastLen
    if (!force && delta < CanvasCodeStreamParser.MIN_DELTA_CHARS) return

    try {
      transform(fullCode, {
        transforms: ['typescript', 'jsx', 'imports'],
        jsxRuntime: 'classic',
        production: true,
      })

      const surfaceId = extractSurfaceId(this.pathValue)
      this.callbacks.onPreview(surfaceId, fullCode)
      this.lastBroadcastLen = fullCode.length
    } catch {
      // Code not yet syntactically valid — skip
    }
  }
}

function extractSurfaceId(path: string): string {
  const fileName = path.slice('canvas/'.length)
  return fileName.replace(/\.(tsx|ts|jsx|js)$/, '')
}
