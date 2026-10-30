// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-chat composer memory (SHO-261).
 *
 * Each agent chat remembers the model the person picked in it and the text they
 * typed but never sent. Both live in the device cache (AsyncStorage — which is
 * `localStorage` on web and the desktop shell, so the `shogo://app` origin keeps
 * it across a restart) and are keyed by the chat session id. The home
 * "describe the project" composer gets its own record, keyed by workspace.
 *
 * The core is storage-injected and React-free so bun:test can drive it with an
 * in-memory Map. `useChatComposerMemory` is the thin React wrapper every agent
 * chat surface goes through (ChatPanel wires it once for project, workspace and
 * side chats; the home screen wires it directly).
 */

import { useEffect, useRef, useState, useCallback } from "react"
import AsyncStorage from "@react-native-async-storage/async-storage"
import { AppState, Platform } from "react-native"
import type { ChatReference } from "./chat-references"
import { safeGetItem } from "./safe-storage"

export const CHAT_COMPOSER_KEY_PREFIX = "shogo:chat-composer:"
export const CHAT_COMPOSER_INDEX_KEY = "shogo:chat-composer:index"

/** At most this many chats keep a record; the rest are evicted LRU-first. */
export const MAX_REMEMBERED_CHATS = 200
/** Records untouched for this long are pruned on load. */
export const MAX_RECORD_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** A draft longer than this is dropped instead of persisted (never throws). */
export const MAX_DRAFT_CHARS = 100_000
/** Keystroke coalescing window for draft writes. */
export const DRAFT_DEBOUNCE_MS = 400

export interface ComposerDraft {
  text: string
  references: ChatReference[]
}

export interface ComposerRecord {
  /** The model the person picked in this chat. */
  model?: string
  /** Wall-clock ms of that pick, so a newer model-stamped message can win. */
  modelAt?: number
  draft?: ComposerDraft
  updatedAt: number
}

export interface ComposerMemoryStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

interface IndexEntry {
  key: string
  updatedAt: number
}

/** A chat session's key. `chatSessionId` is the session id. */
export function composerMemoryKey(chatSessionId: string): string {
  return `${CHAT_COMPOSER_KEY_PREFIX}${chatSessionId}`
}

/** The home "describe the project" composer's key, scoped to the workspace. */
export function homeComposerMemoryKey(workspaceId: string): string {
  return `${CHAT_COMPOSER_KEY_PREFIX}home:${workspaceId}`
}

function sanitizeReferences(raw: unknown): ChatReference[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (r): r is ChatReference =>
      !!r && typeof r === "object" && typeof (r as any).type === "string",
  )
}

/** Tolerant decode: unknown/garbage input returns null instead of throwing. */
export function deserializeRecord(raw: string | null): ComposerRecord | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return sanitizeRecord(parsed)
}

/**
 * Normalizes a decoded value, enforcing the hygiene rules:
 * - a draft over `MAX_DRAFT_CHARS` is dropped (the model pick is kept),
 * - an empty draft (no text, no references) is dropped,
 * - a record with nothing left is `null` (and its key should be removed).
 */
export function sanitizeRecord(raw: unknown): ComposerRecord | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const model = typeof r.model === "string" && r.model.trim() ? r.model : undefined
  const modelAt = typeof r.modelAt === "number" ? r.modelAt : undefined
  const updatedAt = typeof r.updatedAt === "number" ? r.updatedAt : 0

  let draft: ComposerDraft | undefined
  const rawDraft = r.draft as Record<string, unknown> | undefined
  if (rawDraft && typeof rawDraft === "object") {
    const text = typeof rawDraft.text === "string" ? rawDraft.text : ""
    const references = sanitizeReferences(rawDraft.references)
    if (text.length > MAX_DRAFT_CHARS) {
      draft = undefined
    } else if (text.length > 0 || references.length > 0) {
      draft = { text, references }
    }
  }

  if (!model && !draft) return null
  return {
    ...(model ? { model } : {}),
    ...(model && modelAt != null ? { modelAt } : {}),
    ...(draft ? { draft } : {}),
    updatedAt,
  }
}

export function serializeRecord(record: ComposerRecord): string {
  return JSON.stringify(record)
}

const nowMs = () => Date.now()

/**
 * Per-chat composer memory backed by a serializable key/value store, with an
 * in-front memory cache so a remount in the same session restores synchronously
 * (and, on web, so a reload paints the draft on the first frame).
 */
export class ComposerMemory {
  private cache = new Map<string, ComposerRecord | null>()
  private timers = new Map<string, unknown>()
  private indexEntries: IndexEntry[] | null = null
  private indexLoading: Promise<void> | null = null
  /**
   * Serializes persistence. Writes are fire-and-forget from the callers, so the
   * record write and its index/prune bookkeeping must not interleave with
   * another chat's — otherwise an eviction can race a still-queued write and
   * leave an evicted record behind.
   */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly storage: ComposerMemoryStorage,
    private readonly options: {
      now?: () => number
      debounceMs?: number
      /** Synchronous read for platforms that have one (web localStorage). */
      readSync?: (key: string) => string | null
      schedule?: (fn: () => void, ms: number) => unknown
      cancel?: (handle: unknown) => void
    } = {},
  ) {}

  private get now(): () => number {
    return this.options.now ?? nowMs
  }

  private get debounceMs(): number {
    return this.options.debounceMs ?? DRAFT_DEBOUNCE_MS
  }

  /** True when this backend can be read synchronously (web `localStorage`). */
  hasSyncRead(): boolean {
    return !!this.options.readSync
  }

  /** Synchronous best-effort read — the cache, else an optional sync backend. */
  peek(key: string): ComposerRecord | null {
    if (this.cache.has(key)) return this.cache.get(key) ?? null
    const readSync = this.options.readSync
    if (!readSync) return null
    let raw: string | null = null
    try {
      raw = readSync(key)
    } catch {
      raw = null
    }
    const record = deserializeRecord(raw)
    this.cache.set(key, record)
    return record
  }

  /**
   * Loads a chat's record, pruning stale records / evicting overflow.
   *
   * Always reads storage: the cache can legitimately hold `null` from an
   * earlier synchronous `peek()` on a key that had not been written yet, and
   * short-circuiting on that would strand a draft that is on disk.
   */
  load(key: string): Promise<ComposerRecord | null> {
    return this.enqueue(async () => {
      await this.ensureIndex()
      let stored: ComposerRecord | null = null
      try {
        stored = deserializeRecord(await this.storage.getItem(key))
      } catch {
        stored = null
      }
      // Never go backwards: a write may still be debounced, so the cache can be
      // newer than what storage holds.
      const cached = this.cache.get(key) ?? null
      const record =
        cached && (!stored || cached.updatedAt > stored.updatedAt)
          ? cached
          : stored
      this.cache.set(key, record)
      return record
    })
  }

  /** Records a model pick for this chat immediately (no debounce). */
  setModel(key: string, modelId: string): void {
    const at = this.now()
    const current = this.peek(key)
    const record: ComposerRecord = {
      ...(current ?? {}),
      model: modelId,
      modelAt: at,
      updatedAt: at,
    }
    this.cache.set(key, record)
    this.cancelTimer(key)
    void this.write(key, record)
  }

  /** Stores (debounced) the text typed in this chat. Empty text clears it. */
  setDraft(key: string, text: string, references: ChatReference[] = []): void {
    if (!text && references.length === 0) {
      this.clearDraft(key)
      return
    }
    if (text.length > MAX_DRAFT_CHARS) {
      // Never fail a keystroke on an unwritable draft: drop it, keep the model.
      this.clearDraft(key)
      return
    }
    const current = this.peek(key)
    const record: ComposerRecord = {
      ...(current ?? {}),
      draft: { text, references },
      updatedAt: this.now(),
    }
    this.cache.set(key, record)
    this.cancelTimer(key)
    const schedule =
      this.options.schedule ??
      ((fn: () => void, ms: number) => setTimeout(fn, ms))
    const handle = schedule(() => {
      this.timers.delete(key)
      void this.write(key, record)
    }, this.debounceMs)
    this.timers.set(key, handle)
  }

  /** Forgets this chat's draft right away (used once a message is sent). */
  clearDraft(key: string): void {
    this.cancelTimer(key)
    const current = this.peek(key)
    if (!current) {
      this.cache.set(key, null)
      return
    }
    const { draft: _dropped, ...rest } = current
    if (!rest.model) {
      this.cache.set(key, null)
      void this.write(key, null)
      return
    }
    const record: ComposerRecord = { ...rest, updatedAt: this.now() }
    this.cache.set(key, record)
    void this.write(key, record)
  }

  /** Writes a still-debounced draft now (pagehide, background, unmount). */
  flush(key: string): void {
    if (!this.timers.has(key)) return
    this.cancelTimer(key)
    const record = this.peek(key)
    if (record) void this.write(key, record)
  }

  private cancelTimer(key: string): void {
    const handle = this.timers.get(key)
    if (handle === undefined) return
    this.timers.delete(key)
    const cancel =
      this.options.cancel ??
      ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>))
    cancel(handle)
  }

  /** Runs `fn` after every previously queued persistence step settled. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private write(key: string, record: ComposerRecord | null): Promise<void> {
    return this.enqueue(async () => {
      try {
        if (!record) {
          await this.storage.removeItem(key)
          await this.touchIndex(key, null)
          return
        }
        await this.storage.setItem(key, serializeRecord(record))
        await this.touchIndex(key, record.updatedAt)
      } catch {
        // Persistence is best effort — the in-memory cache still serves this run.
      }
    })
  }

  private async ensureIndex(): Promise<void> {
    if (this.indexEntries) return
    if (!this.indexLoading) this.indexLoading = this.loadIndex()
    await this.indexLoading
  }

  private async loadIndex(): Promise<void> {
    let entries: IndexEntry[] = []
    try {
      const raw = await this.storage.getItem(CHAT_COMPOSER_INDEX_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      if (Array.isArray(parsed)) {
        entries = parsed.filter(
          (e): e is IndexEntry =>
            !!e && typeof e === "object" && typeof e.key === "string",
        )
      }
    } catch {
      entries = []
    }

    const at = this.now()
    const stale = entries.filter(
      (e) => at - (e.updatedAt || 0) > MAX_RECORD_AGE_MS,
    )
    const fresh = entries
      .filter((e) => at - (e.updatedAt || 0) <= MAX_RECORD_AGE_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const overflow = fresh.slice(MAX_REMEMBERED_CHATS)
    const kept = fresh.slice(0, MAX_REMEMBERED_CHATS)

    for (const entry of [...stale, ...overflow]) {
      this.cache.delete(entry.key)
      try {
        await this.storage.removeItem(entry.key)
      } catch {
        // best effort
      }
    }

    this.indexEntries = kept
    if (stale.length || overflow.length) await this.saveIndex(kept)
  }

  private async touchIndex(
    key: string,
    updatedAt: number | null,
  ): Promise<void> {
    await this.ensureIndex()
    const entries = this.indexEntries ?? []
    const rest = entries.filter((e) => e.key !== key)
    if (updatedAt != null) rest.push({ key, updatedAt })
    rest.sort((a, b) => b.updatedAt - a.updatedAt)
    const evicted = rest.slice(MAX_REMEMBERED_CHATS)
    const kept = rest.slice(0, MAX_REMEMBERED_CHATS)
    for (const entry of evicted) {
      this.cache.delete(entry.key)
      try {
        await this.storage.removeItem(entry.key)
      } catch {
        // best effort
      }
    }
    this.indexEntries = kept
    await this.saveIndex(kept)
  }

  private async saveIndex(entries: IndexEntry[]): Promise<void> {
    try {
      await this.storage.setItem(
        CHAT_COMPOSER_INDEX_KEY,
        JSON.stringify(entries),
      )
    } catch {
      // best effort
    }
  }
}

const asyncStorageAdapter: ComposerMemoryStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
}

let defaultMemory: ComposerMemory | null = null
let listenersInstalled = false

/**
 * The device-wide composer memory. On web it also reads `localStorage`
 * synchronously so a reload paints the draft on the first frame; on native the
 * async load resolves a tick later.
 */
export function getComposerMemory(): ComposerMemory {
  if (!defaultMemory) {
    defaultMemory = new ComposerMemory(asyncStorageAdapter, {
      readSync: Platform.OS === "web" ? (key) => safeGetItem(key) : undefined,
    })
    installFlushListeners(defaultMemory)
  }
  return defaultMemory
}

/**
 * Best-effort flush of any still-debounced write when the page is hidden, the
 * app is backgrounded, or the tab is torn down — a draft typed within the
 * debounce window must survive a reload.
 */
function installFlushListeners(memory: ComposerMemory): void {
  if (listenersInstalled) return
  listenersInstalled = true
  const flush = () => {
    for (const key of memory["timers"].keys()) memory.flush(key)
  }
  try {
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("pagehide", flush)
      window.addEventListener("beforeunload", flush)
    }
  } catch {
    // no window
  }
  try {
    AppState.addEventListener("change", (state) => {
      if (state !== "active") flush()
    })
  } catch {
    // no AppState (web SSR / tests)
  }
}

export interface ChatComposerMemoryState {
  /** The chat's stored record, once loaded. */
  record: ComposerRecord | null
  /** The chat key `record` belongs to — null until a load for that key settled. */
  loadedKey: string | null
  /** True only once THIS chat's record is known (never for "no chat yet"). */
  ready: boolean
  saveDraft: (text: string, references: ChatReference[]) => void
  clearDraft: () => void
  saveModel: (modelId: string) => void
  flush: () => void
}

/**
 * React wrapper around `ComposerMemory` for one chat key. `key` is null when
 * there is no chat yet (nothing is remembered).
 *
 * `record` and `loadedKey` are set together, so a caller can require
 * `loadedKey === key` before acting on `record`. That matters on a session
 * switch: an effect runs with the previous render's values, and acting on
 * "ready but still the last chat's record" is exactly how a one-shot draft
 * restore gets spent on an empty box.
 */
export function useChatComposerMemory(
  key: string | null,
): ChatComposerMemoryState {
  const memory = getComposerMemory()
  /**
   * The state a synchronous read justifies.
   *
   * A sync backend means the record *can* be read on the first render — not
   * that it was. Claiming `loadedKey` when `peek()` found nothing tells the
   * caller "this chat has no draft" while it may simply not have been read yet,
   * and the one-shot restore then spends itself on an empty box. Only a hit
   * counts; a miss leaves `ready` false until the async load settles.
   */
  const syncState = (forKey: string) => {
    const record = memory.peek(forKey)
    return { record, loadedKey: record ? forKey : null }
  }
  const [state, setState] = useState<{
    record: ComposerRecord | null
    loadedKey: string | null
  }>(() => (key ? syncState(key) : { record: null, loadedKey: null }))
  const keyRef = useRef<string | null>(key)
  keyRef.current = key

  useEffect(() => {
    if (!key) {
      setState({ record: null, loadedKey: null })
      return
    }
    let cancelled = false
    setState(syncState(key))
    void memory.load(key).then((loaded) => {
      if (cancelled) return
      setState({ record: loaded, loadedKey: key })
    })
    return () => {
      cancelled = true
      memory.flush(key)
    }
  }, [key, memory])

  const recordForCurrentKey =
    key && state.loadedKey === key ? state.record : null

  const saveDraft = useCallback(
    (text: string, references: ChatReference[]) => {
      const current = keyRef.current
      if (!current) return
      memory.setDraft(current, text, references)
      setState((prev) => ({
        record: memory.peek(current),
        // Writing a draft means we know everything this chat has: mark it
        // loaded so a still-pending read can never undo the edit.
        loadedKey: current,
      }))
    },
    [memory],
  )

  const clearDraft = useCallback(() => {
    const current = keyRef.current
    if (!current) return
    memory.clearDraft(current)
    setState((prev) => ({
      record: memory.peek(current),
      loadedKey: current,
    }))
  }, [memory])

  const saveModel = useCallback(
    (modelId: string) => {
      const current = keyRef.current
      if (!current) return
      memory.setModel(current, modelId)
      setState((prev) => ({
        record: memory.peek(current),
        loadedKey: current,
      }))
    },
    [memory],
  )

  const flush = useCallback(() => {
    const current = keyRef.current
    if (current) memory.flush(current)
  }, [memory])

  return {
    record: recordForCurrentKey,
    loadedKey: state.loadedKey,
    ready: !!key && state.loadedKey === key,
    saveDraft,
    clearDraft,
    saveModel,
    flush,
  }
}

/**
 * Which model a chat should show. A model recorded by an explicit pick wins,
 * unless a model-stamped message is newer (it may have been sent from another
 * device) — then the stamp wins. Null means "nothing chat-specific": the caller
 * falls back to the global/new-chat preference.
 */
export function resolveChatModel(args: {
  record: ComposerRecord | null
  lastStampedModel: string | null
  lastStampedAt: number
}): string | null {
  const { record, lastStampedModel, lastStampedAt } = args
  const picked = record?.model ?? null
  const pickedAt = record?.modelAt ?? 0
  if (lastStampedModel && lastStampedAt > pickedAt) return lastStampedModel
  return picked ?? lastStampedModel ?? null
}
