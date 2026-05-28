// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GPU renderer manager — loads `@xterm/addon-webgl` when available,
 * listens for `onContextLost`, and falls back to xterm's built-in
 * canvas/DOM renderer when WebGL is unhealthy.
 *
 * Rationale: on integrated Intel GPUs (especially older macOS Intel
 * boxes and some Windows laptops with switching GPUs) the WebGL
 * context dies under memory pressure or when the OS pauses the GPU
 * pipeline. xterm.js emits `onContextLost` from the addon; the
 * documented recovery path is to dispose the addon and let xterm
 * fall back. We do that here once; if the new context dies again
 * within `flapWindowMs` we permanently disable WebGL for the rest
 * of this session.
 *
 * The whole module is wired against a narrow interface so unit tests
 * don't need a real Terminal or WebGL context.
 */

// ─── narrow interfaces (a real Terminal + WebGL addon satisfy these) ──

export interface XtermLike {
  /** xterm.js's `Terminal.loadAddon(addon)`. */
  loadAddon(addon: { dispose?(): void }): void
}

export interface WebglAddonLike {
  dispose?(): void
  /** Subscribes to context-lost; returns a dispose-style handle. */
  onContextLost(cb: () => void): { dispose(): void } | (() => void)
}

export type WebglAddonFactory = () => WebglAddonLike

// ─── status + options ────────────────────────────────────────────────

export type RendererState =
  /** Trying WebGL. */
  | 'webgl-active'
  /** WebGL was tried and disposed once; now on canvas/DOM. */
  | 'fallback-canvas'
  /** Disabled by user setting / config. */
  | 'disabled-by-config'
  /** Disabled because WebGL flapped (lost twice within flapWindowMs). */
  | 'disabled-flapping'
  /** Constructor parameters invalid — failed before any attempt. */
  | 'unsupported'

export interface GpuRendererOptions {
  term: XtermLike
  /** Returns a fresh WebGL addon instance. Throws if WebGL unsupported. */
  createWebglAddon: WebglAddonFactory
  /**
   * If `false`, never attempts WebGL — useful for "force-disable WebGL"
   * settings toggle. Defaults to `true`.
   */
  enabled?: boolean
  /**
   * If WebGL is lost twice within this many ms, permanently disable
   * for the session. Default 60_000.
   */
  flapWindowMs?: number
  /** Inject a clock for tests. */
  now?: () => number
  /** Optional listener for state transitions (telemetry). */
  onStateChange?(state: RendererState): void
}

// ─── manager ─────────────────────────────────────────────────────────

export class GpuRenderer {
  private readonly term: XtermLike
  private readonly create: WebglAddonFactory
  private readonly flapWindowMs: number
  private readonly now: () => number
  private readonly onStateChange?: (s: RendererState) => void

  private addon: WebglAddonLike | null = null
  private unsubscribeLost: (() => void) | null = null
  private lastLostAt: number | null = null
  private _state: RendererState = 'disabled-by-config'
  private disposed = false

  constructor(opts: GpuRendererOptions) {
    this.term = opts.term
    this.create = opts.createWebglAddon
    this.flapWindowMs = Math.max(1_000, opts.flapWindowMs ?? 60_000)
    this.now = opts.now ?? Date.now
    this.onStateChange = opts.onStateChange

    if (opts.enabled === false) {
      this.setState('disabled-by-config')
      return
    }
    this.tryAttachWebgl()
  }

  get state(): RendererState { return this._state }

  /** True iff WebGL is currently the active renderer. */
  isGpu(): boolean { return this._state === 'webgl-active' }

  /** Force-disable WebGL (e.g. from settings toggle). Idempotent. */
  disable(): void {
    if (this._state === 'disabled-by-config') return
    this.teardown()
    this.setState('disabled-by-config')
  }

  /** Try to re-enable after `disable()`. Returns the resulting state. */
  enable(): RendererState {
    if (this.disposed) return this._state
    if (this._state === 'disabled-flapping') return this._state
    this.tryAttachWebgl()
    return this._state
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.teardown()
  }

  // ─── internals ───────────────────────────────────────────────────

  private tryAttachWebgl(): void {
    let addon: WebglAddonLike
    try {
      addon = this.create()
    } catch {
      this.setState('unsupported')
      return
    }
    this.addon = addon
    try {
      this.term.loadAddon(addon as { dispose?(): void })
    } catch {
      this.teardown()
      this.setState('unsupported')
      return
    }
    const handle = addon.onContextLost(() => this.onContextLost())
    this.unsubscribeLost = typeof handle === 'function'
      ? handle
      : () => handle.dispose()
    this.setState('webgl-active')
  }

  private onContextLost(): void {
    const t = this.now()
    const flapping = this.lastLostAt !== null && t - this.lastLostAt < this.flapWindowMs
    this.lastLostAt = t
    this.teardown()
    if (flapping) {
      this.setState('disabled-flapping')
      return
    }
    // First loss — fall back to canvas (xterm's default when the addon
    // is gone). One automatic retry is intentionally NOT done here:
    // VS Code's data shows retries tend to flap immediately on the
    // problematic GPUs. User can re-enable via `enable()` if they want.
    this.setState('fallback-canvas')
  }

  private teardown(): void {
    if (this.unsubscribeLost) {
      try { this.unsubscribeLost() } catch { /* */ }
      this.unsubscribeLost = null
    }
    if (this.addon && typeof this.addon.dispose === 'function') {
      try { this.addon.dispose() } catch { /* */ }
    }
    this.addon = null
  }

  private setState(s: RendererState): void {
    if (this._state === s) return
    this._state = s
    try { this.onStateChange?.(s) } catch { /* */ }
  }
}
