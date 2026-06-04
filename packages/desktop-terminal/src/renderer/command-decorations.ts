// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Materialise xterm.js IDecoration handles for every command tracked by
 * Osc633Tracker, anchored to `command.promptMarker`.
 *
 * What we draw per command:
 *
 *   - ✓ green   when exitCode === 0
 *   - ✗ red     when exitCode > 0
 *   - ⏵ blue    while running (tracker still has the command as `current`)
 *   - ⏸ amber   when exitCode === null (interrupted — no D ever arrived)
 *
 * Plus an overview-ruler mark in the same colour so the user can see
 * the distribution of successes/failures at-a-glance up the scrollback.
 *
 * The xterm coupling is deliberately narrow: we accept a
 * `DecorationHost` interface that any caller can wire up to a real
 * `Terminal` (or to a test fake) without us importing xterm.js itself
 * — keeping this package install-light and unit-testable.
 */

import type { Command, Osc633Tracker, CommandMarker } from './osc633-tracker'

// ─── glyph + colour palette ─────────────────────────────────────────────

export type DecorationKind = 'success' | 'failure' | 'running' | 'interrupted'

export interface DecorationStyle {
  /** Single-character glyph to render in the gutter. */
  glyph: string
  /** CSS color (used for both glyph + overview-ruler entry). */
  color: string
  /** ARIA label for screen readers. */
  ariaLabel: string
}

export const DEFAULT_STYLES: Record<DecorationKind, DecorationStyle> = {
  success:     { glyph: '✓', color: '#1b9e77', ariaLabel: 'Command succeeded' },
  failure:     { glyph: '✗', color: '#d95f02', ariaLabel: 'Command failed' },
  running:     { glyph: '⏵', color: '#1f77b4', ariaLabel: 'Command running' },
  interrupted: { glyph: '⏸', color: '#b07d24', ariaLabel: 'Command interrupted' },
}

/** Classify a Command by current state. Exported for tests. */
export function classify(command: Command): DecorationKind {
  if (command.state !== 'finished') return 'running'
  if (command.exitCode === null) return 'interrupted'
  if (command.exitCode === 0) return 'success'
  return 'failure'
}

// ─── narrow xterm-like host interfaces ──────────────────────────────────

/**
 * The xterm subset we need. A real `Terminal` from xterm.js satisfies
 * this shape; tests pass a fake that records calls.
 */
export interface DecorationHost {
  /**
   * xterm.js `Terminal.registerDecoration(options)` returns an
   * `IDecoration` with an `onRender(cb)` callback the caller uses to
   * paint into the element AND a `dispose()` method. We narrow to that
   * surface so we can swap a fake in tests.
   */
  registerDecoration(opts: DecorationOptions): DecorationHandle | undefined
}

export interface OverviewRulerOptions {
  color: string
  /** xterm.js supports 'left' | 'center' | 'right' | 'full'. */
  position?: 'left' | 'center' | 'right' | 'full'
}

export interface DecorationOptions {
  marker: CommandMarker
  /** xterm.js puts the decoration inline before the row when set. */
  layer?: 'bottom' | 'top'
  /** Width in columns. 1 is the gutter glyph. */
  width?: number
  /** Decoration foreground/background tint. */
  backgroundColor?: string
  overviewRulerOptions?: OverviewRulerOptions
}

export interface DecorationHandle {
  onRender(cb: (el: HTMLElement) => void): void
  dispose(): void
}

// ─── click context callback ─────────────────────────────────────────────

/**
 * Fired when the user clicks the gutter glyph for a command. Hosts use
 * this to open a context menu (rerun, copy command, copy output, ...);
 * we deliberately don't render UI here because the menu shape is owned
 * by apps/desktop's design system.
 */
export interface CommandClickEvent {
  command: Command
  kind: DecorationKind
  /** Mouse event so the host can position a popover. */
  mouseEvent: MouseEvent
}

export type CommandClickHandler = (ev: CommandClickEvent) => void

// ─── manager ────────────────────────────────────────────────────────────

export interface CommandDecorationsOptions {
  host: DecorationHost
  tracker: Osc633Tracker
  /** Click handler — called when the user clicks a gutter glyph. */
  onClick?: CommandClickHandler
  /** Override the glyph/colour palette. */
  styles?: Partial<Record<DecorationKind, DecorationStyle>>
  /**
   * If true, also create a transient decoration for the in-progress
   * command (the running ⏵). It is replaced when the command finishes.
   * Default: true.
   */
  showRunning?: boolean
}

/**
 * Wires a tracker to a DecorationHost: every `command-started` adds a
 * running glyph, every `command-finished` replaces it with the
 * success/failure/interrupted glyph. Manager.dispose() releases all
 * decorations and unsubscribes from the tracker.
 */
export class CommandDecorations {
  private host: DecorationHost
  private tracker: Osc633Tracker
  private onClick?: CommandClickHandler
  private styles: Record<DecorationKind, DecorationStyle>
  private showRunning: boolean

  /** id → live decoration handle. */
  private handles = new Map<number, DecorationHandle>()
  /** Unsubscribe from tracker. */
  private off: () => void
  private disposed = false

  constructor(opts: CommandDecorationsOptions) {
    this.host = opts.host
    this.tracker = opts.tracker
    this.onClick = opts.onClick
    this.styles = { ...DEFAULT_STYLES, ...(opts.styles ?? {}) } as Record<DecorationKind, DecorationStyle>
    this.showRunning = opts.showRunning ?? true

    this.off = this.tracker.on((ev) => {
      if (ev.kind === 'command-started') this.onStarted(ev.command)
      else if (ev.kind === 'command-finished') this.onFinished(ev.command)
    })

    // Adopt any commands the tracker already knows about — important
    // because the tracker may have started receiving events before the
    // terminal mounted and our subscription went live.
    const snap = this.tracker.snapshot()
    for (const c of snap.commands) this.renderFor(c)
    if (snap.current) this.renderFor(snap.current)
  }

  /** Returns the number of live decorations. Test/inspection helper. */
  size(): number { return this.handles.size }

  /** True if this command currently has a live decoration. */
  has(id: number): boolean { return this.handles.has(id) }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.off()
    for (const h of this.handles.values()) {
      try { h.dispose() } catch { /* host already gone */ }
    }
    this.handles.clear()
  }

  // ─── internals ────────────────────────────────────────────────────────

  private onStarted(c: Command): void {
    if (!this.showRunning) return
    this.renderFor(c)
  }

  private onFinished(c: Command): void {
    // Replace the running decoration with the final one. Disposing
    // first guarantees the new render call paints onto a fresh element.
    const prev = this.handles.get(c.id)
    if (prev) {
      try { prev.dispose() } catch { /* */ }
      this.handles.delete(c.id)
    }
    this.renderFor(c)
  }

  private renderFor(c: Command): void {
    const kind = classify(c)
    const marker = c.startMarker ?? c.promptMarker
    if (!marker) return
    const style = this.styles[kind]

    // Small dot anchored to the RIGHT edge of the terminal.
    // anchor:'right' + x:1 positions it 1 cell from the right edge.
    // width:1 makes it a single-cell decoration (tiny dot).
    const handle = this.host.registerDecoration({
      marker,
      anchor: 'right',
      x: 1,
      width: 1,
      layer: 'top',
    })
    if (!handle) return
    this.handles.set(c.id, handle)
    handle.onRender((el) => {
      // Render a small colored circle
      el.style.display = 'flex'
      el.style.alignItems = 'center'
      el.style.justifyContent = 'center'
      el.style.width = '100%'
      el.style.height = '100%'
      el.style.cursor = 'pointer'
      el.style.borderRadius = '50%'
      el.style.background = style.color
      el.title = `${style.ariaLabel}: $ ${c.commandLine}`
      el.setAttribute('aria-label', style.ariaLabel)
      el.setAttribute('data-command-id', String(c.id))
      el.setAttribute('data-command-kind', kind)
      if (this.onClick) {
        el.addEventListener('click', (mouseEvent) => {
          this.onClick!({ command: c, kind, mouseEvent })
        })
      }
    })
  }
}
