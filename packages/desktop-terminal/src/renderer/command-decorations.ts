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
 *   - ● running when command is still executing
 *   - ⏸ interrupted when SIGINT
 *
 * Clicking the glyph fires the `onClick` callback so the surface can show
 * the CmdK popover with "Re-run" / "Copy output" actions.
 */
import type { Terminal as XTerminal } from '@xterm/xterm'
import type { Osc633Tracker, Command, CommandMarker } from './osc633-tracker'

// ─── kinds & styles ──────────────────────────────────────────────────────

export type CommandKind = 'success' | 'failure' | 'running' | 'interrupted'

export interface DecorationStyle {
  glyph: string
  color: string
  ariaLabel: string
}

export const DEFAULT_STYLES: Record<CommandKind, DecorationStyle> = {
  success:     { glyph: '✓', color: '#4ec9b0', ariaLabel: 'Command succeeded' },
  failure:     { glyph: '✗', color: '#f44747', ariaLabel: 'Command failed' },
  running:     { glyph: '●', color: '#569cd6', ariaLabel: 'Command running' },
  interrupted: { glyph: '■', color: '#cc8800', ariaLabel: 'Command interrupted' },
}

function classify(c: Command): CommandKind {
  if (c.state === 'running') return 'running'
  if (c.exitCode === null || c.exitCode === undefined) return 'interrupted'
  return c.exitCode === 0 ? 'success' : 'failure'
}

// ─── host interface ──────────────────────────────────────────────────────

export interface DecorationHost {
  registerDecoration(opts: {
    marker: import('@xterm/xterm').IMarker
    anchor?: 'right' | 'left'
    x?: number
    width?: number
    height?: number
    layer?: 'bottom' | 'top'
    overviewRulerOptions?: { color: string; position?: 'left' | 'center' | 'right' | 'full' }
  }): import('@xterm/xterm').IDecoration | undefined
}

// ─── CommandDecorations ──────────────────────────────────────────────────

export class CommandDecorations {
  private tracker: Osc633Tracker
  private host: DecorationHost
  private styles: Record<CommandKind, DecorationStyle>
  private handles = new Map<number, import('@xterm/xterm').IDecoration>()
  private off?: () => void
  onClick?: (info: { command: Command; kind: CommandKind; mouseEvent: MouseEvent }) => void

  constructor(
    tracker: Osc633Tracker,
    host: DecorationHost,
    styles?: Partial<Record<CommandKind, DecorationStyle>>,
  ) {
    this.tracker = tracker
    this.host = host
    this.styles = { ...DEFAULT_STYLES, ...styles }
  }

  /** Listen for new / finished commands and render decorations. */
  start(): void {
    this.off = this.tracker.on((ev) => {
      if (ev.kind === 'command-finished') {
        this.renderFor(ev.command)
      } else if (ev.kind === 'command-started') {
        this.renderFor(ev.command)
      }
    })

    // Adopt any commands that already exist in the tracker (e.g. snapshot restore)
    for (const c of this.tracker.snapshot().commands) {
      this.renderFor(c)
    }
  }

  dispose(): void {
    this.off?.()
    this.off = undefined
    for (const d of this.handles.values()) {
      d.dispose()
    }
    this.handles.clear()
  }

  private renderFor(c: Command): void {
    const kind = classify(c)
    const marker = c.startMarker ?? c.promptMarker
    if (!marker) return
    const style = this.styles[kind]

    // Anchor to the LEFT gutter. The terminal's .xterm-rows has padding-left
    // that creates a gutter zone; decorations sit in that zone without
    // overlapping text.
    const handle = this.host.registerDecoration({
      marker,
      anchor: 'left',
      x: 0,
      width: 1,
      layer: 'top',
    })
    if (!handle) return

    // Dispose previous decoration for this command (e.g. running → finished)
    const prev = this.handles.get(c.id)
    if (prev) prev.dispose()
    this.handles.set(c.id, handle)

    handle.onRender((el) => {
      el.style.cursor = 'pointer'
      el.style.display = 'flex'
      el.style.alignItems = 'center'
      el.style.justifyContent = 'center'
      el.style.width = '12px'
      el.style.height = '12px'
      el.style.margin = '0'
      el.title = `${style.ariaLabel}: $ ${c.commandLine}`
      el.setAttribute('aria-label', style.ariaLabel)
      el.setAttribute('data-command-id', String(c.id))
      el.setAttribute('data-command-kind', kind)

      // SVG icon — 6×6px, clean circular appearance
      const ns = 'http://www.w3.org/2000/svg'
      const svg = document.createElementNS(ns, 'svg')
      svg.setAttribute('width', '6')
      svg.setAttribute('height', '6')
      svg.setAttribute('viewBox', '0 0 8 8')
      svg.style.flexShrink = '0'

      if (kind === 'success') {
        const circ = document.createElementNS(ns, 'circle')
        circ.setAttribute('cx', '4')
        circ.setAttribute('cy', '4')
        circ.setAttribute('r', '3')
        circ.setAttribute('fill', style.color)
        svg.appendChild(circ)
      } else if (kind === 'failure') {
        const circ = document.createElementNS(ns, 'circle')
        circ.setAttribute('cx', '4')
        circ.setAttribute('cy', '4')
        circ.setAttribute('r', '3')
        circ.setAttribute('fill', 'none')
        circ.setAttribute('stroke', style.color)
        circ.setAttribute('stroke-width', '1')
        svg.appendChild(circ)
        const l1 = document.createElementNS(ns, 'line')
        l1.setAttribute('x1', '2.5')
        l1.setAttribute('y1', '2.5')
        l1.setAttribute('x2', '5.5')
        l1.setAttribute('y2', '5.5')
        l1.setAttribute('stroke', style.color)
        l1.setAttribute('stroke-width', '1')
        l1.setAttribute('stroke-linecap', 'round')
        svg.appendChild(l1)
        const l2 = document.createElementNS(ns, 'line')
        l2.setAttribute('x1', '5.5')
        l2.setAttribute('y1', '2.5')
        l2.setAttribute('x2', '2.5')
        l2.setAttribute('y2', '5.5')
        l2.setAttribute('stroke', style.color)
        l2.setAttribute('stroke-width', '1')
        l2.setAttribute('stroke-linecap', 'round')
        svg.appendChild(l2)
      } else if (kind === 'running') {
        const circ = document.createElementNS(ns, 'circle')
        circ.setAttribute('cx', '4')
        circ.setAttribute('cy', '4')
        circ.setAttribute('r', '3')
        circ.setAttribute('fill', 'none')
        circ.setAttribute('stroke', style.color)
        circ.setAttribute('stroke-width', '1')
        circ.setAttribute('stroke-dasharray', '8 12')
        circ.setAttribute('stroke-linecap', 'round')
        svg.appendChild(circ)
        const anim = document.createElementNS(ns, 'animateTransform')
        anim.setAttribute('attributeName', 'transform')
        anim.setAttribute('type', 'rotate')
        anim.setAttribute('from', '0 4 4')
        anim.setAttribute('to', '360 4 4')
        anim.setAttribute('dur', '1s')
        anim.setAttribute('repeatCount', 'indefinite')
        svg.appendChild(anim)
      } else {
        // interrupted — pause bars
        const circ = document.createElementNS(ns, 'circle')
        circ.setAttribute('cx', '4')
        circ.setAttribute('cy', '4')
        circ.setAttribute('r', '3')
        circ.setAttribute('fill', 'none')
        circ.setAttribute('stroke', style.color)
        circ.setAttribute('stroke-width', '1')
        svg.appendChild(circ)
        const b1 = document.createElementNS(ns, 'line')
        b1.setAttribute('x1', '3')
        b1.setAttribute('y1', '2.5')
        b1.setAttribute('x2', '3')
        b1.setAttribute('y2', '5.5')
        b1.setAttribute('stroke', style.color)
        b1.setAttribute('stroke-width', '1')
        b1.setAttribute('stroke-linecap', 'round')
        svg.appendChild(b1)
        const b2 = document.createElementNS(ns, 'line')
        b2.setAttribute('x1', '5')
        b2.setAttribute('y1', '2.5')
        b2.setAttribute('x2', '5')
        b2.setAttribute('y2', '5.5')
        b2.setAttribute('stroke', style.color)
        b2.setAttribute('stroke-width', '1')
        b2.setAttribute('stroke-linecap', 'round')
        svg.appendChild(b2)
      }

      el.replaceChildren(svg)

      if (this.onClick) {
        el.addEventListener('click', (mouseEvent) => {
          this.onClick!({ command: c, kind, mouseEvent })
        })
      }
    })
  }
}
