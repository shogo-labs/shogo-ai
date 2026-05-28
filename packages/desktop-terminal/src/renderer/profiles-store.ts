// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Terminal profiles store — persists "named shell launch configs" to a
 * JSON document so the user can keep a `zsh + brew env`, a
 * `pwsh with admin profile`, a `nix-shell devbox`, and so on.
 *
 * Storage is abstracted behind a tiny `KeyValueStore` interface
 * (sync, `get`/`set`/`delete`/`list`). In the Electron main process
 * this is backed by a JSON file under `app.getPath('userData')`; in
 * unit tests we use an in-memory backend.
 *
 * Shell auto-detection runs once on first read (when the store has no
 * profiles yet) and writes whatever it finds. Detection is performed
 * against a caller-supplied `ShellResolver` so tests can stub the
 * filesystem; in production main-process code it scans common paths.
 */

// ─── profile schema ────────────────────────────────────────────────

export interface TerminalProfile {
  /** Stable internal id. */
  id: string
  /** Display label in the picker. */
  label: string
  /** Absolute path to the shell binary. */
  shell: string
  /** Args passed to the shell. Default []. */
  args?: string[]
  /** Extra environment variables merged on top of process.env. */
  env?: Record<string, string>
  /** Optional cwd to launch in. Default: caller-decided. */
  cwd?: string
  /** Icon hint (caller-defined; e.g. 'zsh' / 'pwsh' / 'fish'). */
  icon?: string
  /** Marks the user's default profile. Exactly one must be true; the store enforces this. */
  isDefault?: boolean
}

export interface ProfilesDocument {
  /** Storage schema version — bump on incompatible changes. */
  version: 1
  profiles: TerminalProfile[]
}

const STORAGE_KEY = 'shogo.terminal.profiles.v1'

// ─── KV abstraction ────────────────────────────────────────────────

export interface KeyValueStore {
  get(key: string): string | null
  set(key: string, value: string): void
  delete(key: string): void
}

/** In-memory KV — used in unit tests, can also back ephemeral sessions. */
export class MemoryKeyValueStore implements KeyValueStore {
  private map = new Map<string, string>()
  get(key: string): string | null { return this.map.get(key) ?? null }
  set(key: string, value: string): void { this.map.set(key, value) }
  delete(key: string): void { this.map.delete(key) }
  /** Test helper. */
  snapshot(): Record<string, string> { return Object.fromEntries(this.map) }
}

// ─── shell resolver ────────────────────────────────────────────────

export interface DetectedShell {
  id: string
  label: string
  shell: string
  args?: string[]
  icon?: string
}

export interface ShellResolver {
  /** Returns the set of shells available on this machine. */
  detect(): DetectedShell[]
}

/**
 * Reasonable defaults when no resolver is provided — assumes a POSIX
 * machine with bash + zsh on PATH. Hosts in production should plug in
 * a real resolver that probes the filesystem.
 */
export const DEFAULT_RESOLVER: ShellResolver = {
  detect(): DetectedShell[] {
    return [
      { id: 'bash', label: 'bash', shell: '/bin/bash', args: ['-l'], icon: 'bash' },
      { id: 'zsh', label: 'zsh', shell: '/bin/zsh', args: ['-l'], icon: 'zsh' },
    ]
  },
}

// ─── store ─────────────────────────────────────────────────────────

export interface ProfilesStoreOptions {
  storage?: KeyValueStore
  resolver?: ShellResolver
  /** Override the storage key (tests / migration). */
  storageKey?: string
}

export class ProfilesStore {
  private readonly storage: KeyValueStore
  private readonly resolver: ShellResolver
  private readonly key: string
  private cache: ProfilesDocument | null = null
  private listeners = new Set<(doc: ProfilesDocument) => void>()

  constructor(opts: ProfilesStoreOptions = {}) {
    this.storage = opts.storage ?? new MemoryKeyValueStore()
    this.resolver = opts.resolver ?? DEFAULT_RESOLVER
    this.key = opts.storageKey ?? STORAGE_KEY
  }

  /** Load (and auto-detect if empty). */
  load(): ProfilesDocument {
    if (this.cache) return this.cache
    const raw = this.storage.get(this.key)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ProfilesDocument
        if (parsed && parsed.version === 1 && Array.isArray(parsed.profiles)) {
          this.cache = normalise(parsed)
          return this.cache
        }
      } catch { /* fall through to auto-detect */ }
    }
    const detected = this.resolver.detect()
    const profiles: TerminalProfile[] = detected.map((d, i) => ({
      ...d,
      isDefault: i === 0,
    }))
    const doc: ProfilesDocument = normalise({ version: 1, profiles })
    this.cache = doc
    this.persist(doc)
    return doc
  }

  list(): TerminalProfile[] { return [...this.load().profiles] }

  get(id: string): TerminalProfile | null {
    return this.load().profiles.find((p) => p.id === id) ?? null
  }

  getDefault(): TerminalProfile | null {
    const doc = this.load()
    return doc.profiles.find((p) => p.isDefault) ?? doc.profiles[0] ?? null
  }

  upsert(profile: TerminalProfile): TerminalProfile {
    const doc = this.load()
    const existing = doc.profiles.findIndex((p) => p.id === profile.id)
    const next = [...doc.profiles]
    if (existing >= 0) next[existing] = { ...profile }
    else next.push({ ...profile })
    const updated = normalise({ version: 1, profiles: next })
    this.commit(updated)
    return updated.profiles.find((p) => p.id === profile.id)!
  }

  remove(id: string): boolean {
    const doc = this.load()
    const next = doc.profiles.filter((p) => p.id !== id)
    if (next.length === doc.profiles.length) return false
    if (next.length === 0) {
      // Never let the store go empty — re-detect.
      const detected = this.resolver.detect()
      const reseeded = detected.map((d, i) => ({ ...d, isDefault: i === 0 }))
      this.commit(normalise({ version: 1, profiles: reseeded }))
      return true
    }
    this.commit(normalise({ version: 1, profiles: next }))
    return true
  }

  setDefault(id: string): boolean {
    const doc = this.load()
    if (!doc.profiles.some((p) => p.id === id)) return false
    const next = doc.profiles.map((p) => ({ ...p, isDefault: p.id === id }))
    this.commit({ version: 1, profiles: next })
    return true
  }

  /** Subscribe to changes; returns an unsubscribe fn. */
  on(listener: (doc: ProfilesDocument) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Force-clear the on-disk doc (test helper / "Reset"). */
  reset(): void {
    this.cache = null
    this.storage.delete(this.key)
  }

  // ─── internals ─────────────────────────────────────────────────

  private commit(doc: ProfilesDocument): void {
    this.cache = doc
    this.persist(doc)
    for (const l of this.listeners) { try { l(doc) } catch { /* */ } }
  }

  private persist(doc: ProfilesDocument): void {
    this.storage.set(this.key, JSON.stringify(doc))
  }
}

/**
 * Enforce invariants on a document: exactly one default, unique ids,
 * non-empty profiles array (caller must have at least one).
 */
function normalise(doc: ProfilesDocument): ProfilesDocument {
  // De-duplicate ids — last write wins (mirrors upsert semantics).
  const seen = new Map<string, TerminalProfile>()
  for (const p of doc.profiles) seen.set(p.id, p)
  let list = [...seen.values()]
  if (list.length === 0) return { version: 1, profiles: [] }
  // Ensure exactly one default — if zero or many, take the first.
  const defaults = list.filter((p) => p.isDefault)
  if (defaults.length !== 1) {
    list = list.map((p, i) => ({ ...p, isDefault: i === 0 }))
  }
  return { version: 1, profiles: list }
}
