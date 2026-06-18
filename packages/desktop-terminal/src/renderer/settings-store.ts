// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Typed user settings for the desktop terminal.
 *
 * Schema-versioned + persisted via the same `KeyValueStore` interface
 * Phase 5's ProfilesStore and Phase 8's ApprovalStore use, so the
 * production backend (JSON file under userData/) and the test
 * backend (MemoryKeyValueStore) are interchangeable.
 *
 * Settings are deliberately FLAT: one record, no nesting. The
 * tradeoff is dumb to migrate — version bumps add fields with
 * defaults; old fields get retained verbatim. apps/desktop's settings
 * panel binds 1:1 against this shape.
 *
 * `set()` accepts a partial — callers don't need to construct the
 * whole document for one toggle.
 */

import { MemoryKeyValueStore, type KeyValueStore } from './profiles-store'

// ─── schema ─────────────────────────────────────────────────────

export type CursorStyle = 'block' | 'underline' | 'bar'
export type RestorePolicy = 'silent' | 'prompt' | 'never'
export type ApprovalDefault = 'allow-safe' | 'ask-each' | 'deny-all'

export interface TerminalSettings {
  /** CSS font-family stack. */
  fontFamily: string
  /** Pixel size for terminal glyphs. */
  fontSize: number
  /** xterm cursor style. */
  cursorStyle: CursorStyle
  /** Number of scrollback rows xterm retains. */
  scrollbackLines: number
  /** Master toggle for WebGL renderer (Phase 5 GpuRenderer). */
  gpuEnabled: boolean
  /** Phase-5 ProfilesStore id; null = "use store default". */
  defaultProfileId: string | null
  /** Phase-9 restore behaviour. */
  restorePolicy: RestorePolicy
  /** Phase-8 ApprovalStore seeding posture. */
  approvalDefault: ApprovalDefault
  /** Phase-3 shell-integration master toggle. */
  shellIntegrationEnabled: boolean
  /** Phase-10 telemetry consent — defaults OFF (opt-in). */
  telemetryEnabled: boolean
  /** Enable CSS font-ligature rendering (e.g. → ≠ => with Cascadia Code / Fira Code). */
  fontLigatures: boolean
}

export interface TerminalSettingsDocument {
  version: 1
  settings: TerminalSettings
}

// ─── defaults ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: TerminalSettings = {
  // Single safe stack that resolves to a monospace face on every OS we
  // ship to. apps/desktop's settings panel surfaces a font picker on
  // top of this string.
  fontFamily: 'Menlo, "Courier New", "DejaVu Sans Mono", monospace',
  fontSize: 13,
  cursorStyle: 'block',
  scrollbackLines: 5_000,
  gpuEnabled: true,
  defaultProfileId: null,
  restorePolicy: 'silent',
  approvalDefault: 'allow-safe',
  shellIntegrationEnabled: true,
  telemetryEnabled: false,
  fontLigatures: true,
}

// ─── validation ─────────────────────────────────────────────────

const CURSOR_STYLES: readonly CursorStyle[] = ['block', 'underline', 'bar']
const RESTORE_POLICIES: readonly RestorePolicy[] = ['silent', 'prompt', 'never']
const APPROVAL_DEFAULTS: readonly ApprovalDefault[] = ['allow-safe', 'ask-each', 'deny-all']

const FONT_SIZE_MIN = 6
const FONT_SIZE_MAX = 72
const SCROLLBACK_MIN = 500
const SCROLLBACK_MAX = 100_000

export class SettingsValidationError extends Error {
  constructor(field: string, value: unknown, expected: string) {
    super(`SettingsValidationError: ${field}=${JSON.stringify(value)} (expected ${expected})`)
    this.name = 'SettingsValidationError'
    this.field = field
    this.value = value
  }
  readonly field: string
  readonly value: unknown
}

/**
 * Validate a partial settings patch. Throws on bad input so callers
 * never silently persist nonsense (e.g. `fontSize: -3` would freeze
 * xterm's renderer). Returns nothing — throws on first failure.
 */
export function validateSettingsPatch(patch: Partial<TerminalSettings>): void {
  if ('fontFamily' in patch) {
    const v = patch.fontFamily
    if (typeof v !== 'string' || v.trim().length === 0) {
      throw new SettingsValidationError('fontFamily', v, 'non-empty string')
    }
  }
  if ('fontSize' in patch) {
    const v = patch.fontSize
    if (typeof v !== 'number' || !Number.isFinite(v) || v < FONT_SIZE_MIN || v > FONT_SIZE_MAX) {
      throw new SettingsValidationError('fontSize', v, `number in [${FONT_SIZE_MIN}, ${FONT_SIZE_MAX}]`)
    }
  }
  if ('cursorStyle' in patch) {
    if (!CURSOR_STYLES.includes(patch.cursorStyle as CursorStyle)) {
      throw new SettingsValidationError('cursorStyle', patch.cursorStyle, CURSOR_STYLES.join(' | '))
    }
  }
  if ('scrollbackLines' in patch) {
    const v = patch.scrollbackLines
    if (typeof v !== 'number' || !Number.isFinite(v) || v < SCROLLBACK_MIN || v > SCROLLBACK_MAX) {
      throw new SettingsValidationError('scrollbackLines', v, `number in [${SCROLLBACK_MIN}, ${SCROLLBACK_MAX}]`)
    }
  }
  if ('gpuEnabled' in patch && typeof patch.gpuEnabled !== 'boolean') {
    throw new SettingsValidationError('gpuEnabled', patch.gpuEnabled, 'boolean')
  }
  if ('defaultProfileId' in patch) {
    const v = patch.defaultProfileId
    if (v !== null && (typeof v !== 'string' || v.length === 0)) {
      throw new SettingsValidationError('defaultProfileId', v, 'non-empty string or null')
    }
  }
  if ('restorePolicy' in patch) {
    if (!RESTORE_POLICIES.includes(patch.restorePolicy as RestorePolicy)) {
      throw new SettingsValidationError('restorePolicy', patch.restorePolicy, RESTORE_POLICIES.join(' | '))
    }
  }
  if ('approvalDefault' in patch) {
    if (!APPROVAL_DEFAULTS.includes(patch.approvalDefault as ApprovalDefault)) {
      throw new SettingsValidationError('approvalDefault', patch.approvalDefault, APPROVAL_DEFAULTS.join(' | '))
    }
  }
  if ('shellIntegrationEnabled' in patch && typeof patch.shellIntegrationEnabled !== 'boolean') {
    throw new SettingsValidationError('shellIntegrationEnabled', patch.shellIntegrationEnabled, 'boolean')
  }
  if ('telemetryEnabled' in patch && typeof patch.telemetryEnabled !== 'boolean') {
    throw new SettingsValidationError('telemetryEnabled', patch.telemetryEnabled, 'boolean')
  }
  if ('fontLigatures' in patch && typeof patch.fontLigatures !== 'boolean') {
    throw new SettingsValidationError('fontLigatures', patch.fontLigatures, 'boolean')
  }
}

// ─── store ──────────────────────────────────────────────────────

const STORAGE_KEY = 'shogo.terminal.settings.v1'

export interface SettingsStoreOptions {
  storage?: KeyValueStore
  storageKey?: string
}

export class SettingsStore {
  private readonly storage: KeyValueStore
  private readonly key: string
  private cache: TerminalSettings | null = null
  private listeners = new Set<(s: TerminalSettings) => void>()

  constructor(opts: SettingsStoreOptions = {}) {
    this.storage = opts.storage ?? new MemoryKeyValueStore()
    this.key = opts.storageKey ?? STORAGE_KEY
  }

  /** Load + memoise. Missing or malformed storage → defaults. */
  get(): TerminalSettings {
    if (this.cache) return this.cache
    const raw = this.storage.get(this.key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as TerminalSettingsDocument
        if (parsed && parsed.version === 1 && parsed.settings && typeof parsed.settings === 'object') {
          // Merge persisted over defaults — additive migrations: a
          // new field added in a later release picks up its default
          // automatically because the persisted doc lacks the key.
          this.cache = { ...DEFAULT_SETTINGS, ...parsed.settings }
          return this.cache
        }
      } catch { /* fall through */ }
    }
    this.cache = { ...DEFAULT_SETTINGS }
    return this.cache
  }

  /**
   * Apply a partial patch. Throws on validation failure; on success,
   * persists + notifies listeners + returns the new full settings.
   */
  set(patch: Partial<TerminalSettings>): TerminalSettings {
    validateSettingsPatch(patch)
    const current = this.get()
    const next: TerminalSettings = { ...current, ...patch }
    this.commit(next)
    return next
  }

  /** Subscribe; returns an unsubscribe fn. */
  on(listener: (s: TerminalSettings) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Reset to defaults; persists + notifies. */
  reset(): TerminalSettings {
    this.commit({ ...DEFAULT_SETTINGS })
    return this.get()
  }

  // ─── internals ───────────────────────────────────────────

  private commit(settings: TerminalSettings): void {
    this.cache = settings
    const doc: TerminalSettingsDocument = { version: 1, settings }
    this.storage.set(this.key, JSON.stringify(doc))
    for (const l of this.listeners) {
      try { l(settings) } catch { /* */ }
    }
  }
}
