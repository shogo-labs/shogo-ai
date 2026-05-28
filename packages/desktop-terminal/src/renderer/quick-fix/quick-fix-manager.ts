// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * QuickFixManager — subscribes to the Phase-3 tracker, runs the
 * engine on every non-zero command-finished event, and materialises a
 * lightbulb decoration on the failed command's prompt line.
 *
 * Wiring (host responsibilities):
 *   - DecorationHost → typically xterm.js's Terminal.registerDecoration.
 *   - BufferReader   → typically `term.buffer.active.getLine(i)?.translateToString(true)`.
 *   - tracker        → an Osc633Tracker instance.
 *   - onSuggestion   → callback fired when the user clicks a suggestion;
 *                      the host turns the action into IPC / cmdk / shell open.
 *
 * Lifecycle: construct + start ⇒ subscribe, then `dispose()` once at
 * teardown. Idempotent.
 */

import type { Command, Osc633Tracker, TrackerEvent, CommandMarker } from '../osc633-tracker'
import type { DecorationHandle, DecorationHost, DecorationOptions } from '../command-decorations'
import {
  QuickFixEngine,
  type QuickFixContext,
  type QuickFixSuggestion,
  tailLines,
} from './quick-fix-engine'
import { BUILT_IN_RULES } from './quick-fix-rules'

// ─── narrow xterm interfaces ──────────────────────────────────────

/**
 * The manager needs to read the rows between a command's startMarker
 * and endMarker to feed `outputTail`. xterm.js's buffer surface is
 * heavy; we narrow to just what we need.
 */
export interface BufferReader {
  /**
   * Read terminal rows [start, end) inclusive of start, exclusive of
   * end. Returns one logical line per row (xterm's
   * `translateToString(true)` is the canonical implementation).
   * Out-of-range indices yield empty strings.
   */
  readRows(startLine: number, endLine: number): string[]
}

// ─── click event ───────────────────────────────────────────────────

export interface QuickFixClickEvent {
  command: Command
  suggestion: QuickFixSuggestion
  mouseEvent: MouseEvent
}

// ─── options ───────────────────────────────────────────────────────

export interface QuickFixManagerOptions {
  tracker: Osc633Tracker
  host: DecorationHost
  buffer: BufferReader
  /** Fired when the user clicks a suggestion. */
  onSuggestion(ev: QuickFixClickEvent): void
  /** Engine override; defaults to a fresh QuickFixEngine using BUILT_IN_RULES. */
  engine?: QuickFixEngine
  /** Number of trailing output lines fed to the engine. Default 12. */
  tailRows?: number
  /** Glyph to render on the gutter. Default 💡. */
  glyph?: string
  /** Class applied to the rendered glyph; styling owned by the host. */
  glyphClass?: string
}

// ─── manager ───────────────────────────────────────────────────────

interface DecorationEntry {
  handle: DecorationHandle
  suggestions: QuickFixSuggestion[]
}

export class QuickFixManager {
  private readonly tracker: Osc633Tracker
  private readonly host: DecorationHost
  private readonly buffer: BufferReader
  private readonly onSuggestion: (ev: QuickFixClickEvent) => void
  private readonly engine: QuickFixEngine
  private readonly tailRows: number
  private readonly glyph: string
  private readonly glyphClass?: string

  private decorations = new Map<number, DecorationEntry>()
  private off: () => void = () => undefined
  private disposed = false

  constructor(opts: QuickFixManagerOptions) {
    this.tracker = opts.tracker
    this.host = opts.host
    this.buffer = opts.buffer
    this.onSuggestion = opts.onSuggestion
    this.engine = opts.engine ?? new QuickFixEngine({ rules: BUILT_IN_RULES })
    this.tailRows = Math.max(1, opts.tailRows ?? 12)
    this.glyph = opts.glyph ?? '💡'
    this.glyphClass = opts.glyphClass

    this.off = this.tracker.on((ev: TrackerEvent) => {
      if (ev.kind === 'command-finished') this.onFinished(ev.command)
    })

    // Adopt commands the tracker already saw — same pattern Phase-4's
    // CommandDecorations uses to handle late mount.
    for (const c of this.tracker.snapshot().commands) this.onFinished(c)
  }

  /** Expose the engine so hosts can register custom rules. */
  getEngine(): QuickFixEngine { return this.engine }

  /** Current count of live lightbulb decorations. */
  size(): number { return this.decorations.size }

  /** Test/inspection — whether this command has a live decoration. */
  has(id: number): boolean { return this.decorations.has(id) }

  /** Test/inspection — pull the suggestions attached to a command. */
  getSuggestions(id: number): readonly QuickFixSuggestion[] {
    return this.decorations.get(id)?.suggestions ?? []
  }

  /**
   * Manually run a suggestion for a command id (used by keyboard
   * shortcuts or hosts that own their own UI). Returns true iff the
   * suggestion was found and fired.
   */
  invoke(commandId: number, suggestionIndex: number, mouseEvent: MouseEvent): boolean {
    const entry = this.decorations.get(commandId)
    if (!entry) return false
    const suggestion = entry.suggestions[suggestionIndex]
    if (!suggestion) return false
    const command = this.findCommandById(commandId)
    if (!command) return false
    this.onSuggestion({ command, suggestion, mouseEvent })
    return true
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
    for (const e of this.decorations.values()) {
      try { e.handle.dispose() } catch { /* */ }
    }
    this.decorations.clear()
  }

  // ─── internals ──────────────────────────────────────────────────

  private onFinished(c: Command): void {
    if (this.disposed) return
    // Already decorated this command (re-emitted on adoption).
    if (this.decorations.has(c.id)) return

    // Only suggest for failures or interruptions; success commands
    // don't need a Quick Fix lightbulb.
    if (c.exitCode === 0) return

    const ctx = this.buildContext(c)
    const suggestions = this.engine.evaluate(ctx)
    if (suggestions.length === 0) return

    const marker = c.endMarker ?? c.startMarker ?? c.promptMarker
    if (!marker) return

    const handle = this.host.registerDecoration(this.decorationOpts(marker))
    if (!handle) return
    this.decorations.set(c.id, { handle, suggestions })
    handle.onRender((el) => this.paint(el, c, suggestions))
  }

  private buildContext(c: Command): QuickFixContext {
    let outputTail = ''
    const start = c.startMarker?.line
    const end = c.endMarker?.line
    if (start !== undefined && end !== undefined && start !== null && end !== null && end > start) {
      const rows = this.buffer.readRows(start, end)
      outputTail = tailLines(rows.join('\n'), this.tailRows)
    }
    return {
      commandLine: (c.commandLine ?? '').trim(),
      outputTail,
      cwd: c.cwd ?? null,
      exitCode: c.exitCode,
    }
  }

  private decorationOpts(marker: CommandMarker): DecorationOptions {
    return {
      marker,
      layer: 'top',
      width: 1,
      overviewRulerOptions: { color: '#f5d76e', position: 'right' },
    }
  }

  private paint(el: HTMLElement, c: Command, suggestions: QuickFixSuggestion[]): void {
    el.textContent = this.glyph
    el.style.cursor = 'pointer'
    el.setAttribute('aria-label', `Quick fix: ${suggestions[0]!.title}`)
    el.setAttribute('role', 'button')
    el.setAttribute('data-quick-fix-command-id', String(c.id))
    el.setAttribute('data-quick-fix-count', String(suggestions.length))
    if (this.glyphClass) el.className = this.glyphClass
    el.addEventListener('click', (mouseEvent) => {
      // For now we forward the first suggestion; multi-suggestion UI
      // is the host's call (popover with all entries, etc.). The host
      // can also use invoke(commandId, index) directly.
      this.onSuggestion({ command: c, suggestion: suggestions[0]!, mouseEvent })
    })
  }

  private findCommandById(id: number): Command | null {
    const snap = this.tracker.snapshot()
    for (const c of snap.commands) if (c.id === id) return c
    if (snap.current?.id === id) return snap.current
    return null
  }
}
