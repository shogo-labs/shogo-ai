// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Command navigation — VS Code-parity ⌘↑ / ⌘↓ (mac) and Alt+↑ / Alt+↓
 * (Linux/Windows) jumps between the prompt lines that the tracker has
 * recorded.
 *
 * This module owns:
 *
 *   1. **Pure jump arithmetic** (`findPrevPromptLine`, `findNextPromptLine`)
 *      — given a sorted list of prompt-line anchors and a current line,
 *      return the next prompt above/below it. Easy to test, no DOM.
 *
 *   2. **Keyboard binding** (`CommandNavigation`) — attaches a key
 *      listener to an element, intercepts the platform-correct chord,
 *      consults the tracker for prompt lines, and calls `scrollToLine`
 *      on a narrow `ScrollHost` interface. Shift extends selection;
 *      we mark the range via `selectLines` on the host and leave the
 *      visual rendering to xterm.js.
 *
 * Tests inject a fake ScrollHost + a synthetic Tracker. No xterm.js,
 * no DOM beyond a KeyboardEvent (which we construct).
 */

import type { Osc633Tracker, Command, CommandMarker } from './osc633-tracker'

// ─── pure arithmetic ───────────────────────────────────────────────────

/** A prompt anchor: the row number a command's promptMarker sits at. */
export interface PromptAnchor {
  /** The Command's id. */
  id: number
  /** The marker's `line` field at lookup time. */
  line: number
}

/** Collect prompt anchors from a tracker snapshot, sorted ascending. */
export function collectPromptAnchors(tracker: Osc633Tracker): PromptAnchor[] {
  const snap = tracker.snapshot()
  const anchors: PromptAnchor[] = []
  const add = (c: Command): void => {
    const m: CommandMarker | null = c.promptMarker
    if (m && Number.isFinite(m.line)) anchors.push({ id: c.id, line: m.line })
  }
  for (const c of snap.commands) add(c)
  if (snap.current) add(snap.current)
  anchors.sort((a, b) => a.line - b.line)
  return anchors
}

/**
 * Largest anchor line strictly less than `currentLine`. Returns `null`
 * if no such anchor exists. Anchors must be sorted ascending.
 */
export function findPrevPromptLine(anchors: readonly PromptAnchor[], currentLine: number): PromptAnchor | null {
  // Linear is fine — typical session has < 1000 commands and we only
  // run this on key press. Binary search would be premature.
  let best: PromptAnchor | null = null
  for (const a of anchors) {
    if (a.line < currentLine) best = a
    else break
  }
  return best
}

/**
 * Smallest anchor line strictly greater than `currentLine`. Returns
 * `null` if no such anchor exists.
 */
export function findNextPromptLine(anchors: readonly PromptAnchor[], currentLine: number): PromptAnchor | null {
  for (const a of anchors) if (a.line > currentLine) return a
  return null
}

// ─── platform key chord ─────────────────────────────────────────────────

export type Platform = 'mac' | 'linux' | 'win'

export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux'
  const ua = navigator.userAgent || ''
  // navigator.platform is deprecated but still the most reliable
  // mac discriminator; UA-CH is async and overkill for this.
  const plat = (navigator as { platform?: string }).platform ?? ''
  if (/Mac/i.test(plat) || /Mac OS X/.test(ua)) return 'mac'
  if (/Win/i.test(plat) || /Windows/.test(ua)) return 'win'
  return 'linux'
}

export type NavDirection = 'prev' | 'next'

/**
 * Returns the direction implied by a KeyboardEvent under the current
 * platform's chord, or `null` if the event isn't ours. Shift is
 * separately reported so callers can decide between "scroll" and
 * "scroll + extend selection". Exported for tests.
 */
export function matchNavChord(
  ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  platform: Platform,
): { direction: NavDirection; extend: boolean } | null {
  const isArrow = ev.key === 'ArrowUp' || ev.key === 'ArrowDown'
  if (!isArrow) return null
  const direction: NavDirection = ev.key === 'ArrowUp' ? 'prev' : 'next'
  if (platform === 'mac') {
    // ⌘↑ / ⌘↓; ctrl/alt must not be pressed (those mean other things).
    if (!ev.metaKey || ev.ctrlKey || ev.altKey) return null
  } else {
    // Alt+↑ / Alt+↓; meta/ctrl must not be pressed.
    if (!ev.altKey || ev.metaKey || ev.ctrlKey) return null
  }
  return { direction, extend: ev.shiftKey }
}

// ─── host interface ────────────────────────────────────────────────────

export interface ScrollHost {
  /** xterm's `Terminal.buffer.active.viewportY + (cursor row)`, basically. */
  getCurrentLine(): number
  /** Move the viewport so `line` is visible (xterm.js: scrollToLine). */
  scrollToLine(line: number): void
  /**
   * Select a line range, inclusive. Implementers can call xterm's
   * `selectLines(start, end)`. Optional because some hosts only want
   * scrolling.
   */
  selectLines?(startLine: number, endLine: number): void
}

// ─── manager ────────────────────────────────────────────────────────────

export interface CommandNavigationOptions {
  host: ScrollHost
  tracker: Osc633Tracker
  /** Override platform detection (tests). */
  platform?: Platform
  /**
   * Element to attach the keydown listener to. If omitted, the caller
   * must invoke `handleKeyDown(ev)` themselves (e.g. from a React
   * keydown prop).
   */
  attachTo?: { addEventListener: typeof EventTarget.prototype.addEventListener; removeEventListener: typeof EventTarget.prototype.removeEventListener }
}

export class CommandNavigation {
  private host: ScrollHost
  private tracker: Osc633Tracker
  private platform: Platform
  private listener?: (ev: KeyboardEvent) => void
  private detach?: () => void
  private disposed = false

  constructor(opts: CommandNavigationOptions) {
    this.host = opts.host
    this.tracker = opts.tracker
    this.platform = opts.platform ?? detectPlatform()

    if (opts.attachTo) {
      const handler = (ev: Event): void => {
        // Narrow to KeyboardEvent — listener is registered as keydown.
        this.handleKeyDown(ev as KeyboardEvent)
      }
      opts.attachTo.addEventListener('keydown', handler as EventListener)
      this.detach = () => opts.attachTo!.removeEventListener('keydown', handler as EventListener)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.detach?.()
  }

  /**
   * Public for callers that want to wire the key handler themselves
   * (React onKeyDown). Returns true if the event was consumed.
   */
  handleKeyDown(ev: KeyboardEvent): boolean {
    const match = matchNavChord(ev, this.platform)
    if (!match) return false
    const consumed = this.move(match.direction, match.extend)
    if (consumed) ev.preventDefault?.()
    return consumed
  }

  /** Drive a jump programmatically (also used by tests). */
  move(direction: NavDirection, extend: boolean): boolean {
    const anchors = collectPromptAnchors(this.tracker)
    if (anchors.length === 0) return false
    const cur = this.host.getCurrentLine()
    const next = direction === 'prev'
      ? findPrevPromptLine(anchors, cur)
      : findNextPromptLine(anchors, cur)
    if (!next) return false
    this.host.scrollToLine(next.line)
    if (extend && this.host.selectLines) {
      const lo = Math.min(cur, next.line)
      const hi = Math.max(cur, next.line)
      this.host.selectLines(lo, hi)
    }
    return true
  }
}
