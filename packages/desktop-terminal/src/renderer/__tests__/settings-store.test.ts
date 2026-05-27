// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, it, expect } from 'bun:test'
import { MemoryKeyValueStore } from '../profiles-store'
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  SettingsValidationError,
  validateSettingsPatch,
  type TerminalSettings,
  type TerminalSettingsDocument,
} from '../settings-store'

const fresh = (): { store: SettingsStore; storage: MemoryKeyValueStore } => {
  const storage = new MemoryKeyValueStore()
  return { storage, store: new SettingsStore({ storage }) }
}

// ─── defaults + load ───────────────────────────────────────────

describe('SettingsStore — load', () => {
  it('returns DEFAULT_SETTINGS when storage is empty', () => {
    const { store } = fresh()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns DEFAULT_SETTINGS when storage has malformed JSON', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.settings.v1', 'not-json')
    const store = new SettingsStore({ storage })
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('returns DEFAULT_SETTINGS when persisted doc has wrong schema version', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.settings.v1', JSON.stringify({ version: 99, settings: { fontSize: 20 } }))
    const store = new SettingsStore({ storage })
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges persisted partial over defaults (additive migration)', () => {
    const storage = new MemoryKeyValueStore()
    storage.set('shogo.terminal.settings.v1', JSON.stringify({
      version: 1,
      settings: { fontSize: 20, cursorStyle: 'bar' },
    } satisfies { version: 1; settings: Partial<TerminalSettings> }))
    const store = new SettingsStore({ storage })
    const s = store.get()
    expect(s.fontSize).toBe(20)
    expect(s.cursorStyle).toBe('bar')
    // Unspecified fields fall back to defaults.
    expect(s.scrollbackLines).toBe(DEFAULT_SETTINGS.scrollbackLines)
    expect(s.telemetryEnabled).toBe(DEFAULT_SETTINGS.telemetryEnabled)
  })

  it('memoises — repeated get() calls return the same object reference', () => {
    const { store } = fresh()
    expect(store.get()).toBe(store.get())
  })
})

// ─── set + validate ────────────────────────────────────────────

describe('SettingsStore — set + validation', () => {
  it('applies a partial patch, persists, and notifies listeners', () => {
    const { store, storage } = fresh()
    const seen: TerminalSettings[] = []
    store.on((s) => seen.push(s))
    const next = store.set({ fontSize: 16, cursorStyle: 'underline' })
    expect(next.fontSize).toBe(16)
    expect(next.cursorStyle).toBe('underline')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.fontSize).toBe(16)
    const persisted = JSON.parse(storage.get('shogo.terminal.settings.v1')!) as TerminalSettingsDocument
    expect(persisted.settings.fontSize).toBe(16)
  })

  it('rejects non-string fontFamily', () => {
    const { store } = fresh()
    expect(() => store.set({ fontFamily: '' })).toThrow(SettingsValidationError)
  })

  it('rejects out-of-range fontSize', () => {
    const { store } = fresh()
    expect(() => store.set({ fontSize: 0 })).toThrow(SettingsValidationError)
    expect(() => store.set({ fontSize: 999 })).toThrow(SettingsValidationError)
    expect(() => store.set({ fontSize: Number.NaN })).toThrow(SettingsValidationError)
  })

  it('rejects unknown cursorStyle values', () => {
    const { store } = fresh()
    expect(() => store.set({ cursorStyle: 'diamond' as never })).toThrow(SettingsValidationError)
  })

  it('rejects scrollback outside [500, 100000]', () => {
    const { store } = fresh()
    expect(() => store.set({ scrollbackLines: 100 })).toThrow(SettingsValidationError)
    expect(() => store.set({ scrollbackLines: 1_000_000 })).toThrow(SettingsValidationError)
  })

  it('rejects non-boolean gpuEnabled', () => {
    const { store } = fresh()
    expect(() => store.set({ gpuEnabled: 'yes' as never })).toThrow(SettingsValidationError)
  })

  it('rejects unknown restorePolicy / approvalDefault', () => {
    const { store } = fresh()
    expect(() => store.set({ restorePolicy: 'whenever' as never })).toThrow(SettingsValidationError)
    expect(() => store.set({ approvalDefault: 'allow-all' as never })).toThrow(SettingsValidationError)
  })

  it('accepts null defaultProfileId but rejects empty string', () => {
    const { store } = fresh()
    expect(() => store.set({ defaultProfileId: null })).not.toThrow()
    expect(() => store.set({ defaultProfileId: '' })).toThrow(SettingsValidationError)
  })

  it('rejects non-boolean shellIntegrationEnabled / telemetryEnabled', () => {
    const { store } = fresh()
    expect(() => store.set({ shellIntegrationEnabled: 1 as never })).toThrow(SettingsValidationError)
    expect(() => store.set({ telemetryEnabled: 'on' as never })).toThrow(SettingsValidationError)
  })

  it('SettingsValidationError carries field + value for UI display', () => {
    try {
      validateSettingsPatch({ fontSize: -5 })
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SettingsValidationError)
      expect((e as SettingsValidationError).field).toBe('fontSize')
      expect((e as SettingsValidationError).value).toBe(-5)
    }
  })
})

// ─── reset + listener lifecycle ────────────────────────────────

describe('SettingsStore — reset + listeners', () => {
  it('reset() restores defaults and notifies', () => {
    const { store } = fresh()
    store.set({ fontSize: 18 })
    let seen: TerminalSettings | null = null
    store.on((s) => { seen = s })
    store.reset()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
    expect(seen).toEqual(DEFAULT_SETTINGS)
  })

  it('unsubscribe stops further notifications', () => {
    const { store } = fresh()
    let count = 0
    const off = store.on(() => count++)
    store.set({ fontSize: 14 })
    off()
    store.set({ fontSize: 16 })
    expect(count).toBe(1)
  })
})

// ─── cross-instance persistence ────────────────────────────────

describe('SettingsStore — persistence', () => {
  it('a second store with the same storage sees the saved settings', () => {
    const storage = new MemoryKeyValueStore()
    const a = new SettingsStore({ storage })
    a.set({ fontSize: 20, telemetryEnabled: true })
    const b = new SettingsStore({ storage })
    expect(b.get().fontSize).toBe(20)
    expect(b.get().telemetryEnabled).toBe(true)
  })

  it('different storageKey isolates settings', () => {
    const storage = new MemoryKeyValueStore()
    const a = new SettingsStore({ storage, storageKey: 'ws-A' })
    const b = new SettingsStore({ storage, storageKey: 'ws-B' })
    a.set({ fontSize: 22 })
    expect(b.get().fontSize).toBe(DEFAULT_SETTINGS.fontSize)
  })
})
