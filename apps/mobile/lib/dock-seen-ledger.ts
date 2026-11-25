// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Which settled dock rows this device has already watched retire, per chat.
 *
 * The runtime keeps a finished task in `listDock()` for ten minutes, so a chat
 * reopened inside that window is handed every row again and the dock replays
 * each one's readable window and exit — rows the person already watched go
 * (SHO-535). This is the device's memory of them, bounded by
 * `DOCK_SEEN_RETENTION_MS`: in memory while the app runs, mirrored to
 * AsyncStorage so a reload or restart inside the window does not replay either.
 *
 * A row is recorded only once it has finished its exit (see RunningDockPanel),
 * so leaving during its readable window leaves it unread and it plays again.
 * Running and `stale` rows are never recorded. Any storage failure falls back to
 * today's behaviour — the ledger never hides a row it could not read.
 */

import AsyncStorage from "@react-native-async-storage/async-storage"
import { setStorageItem } from './storage'
import {
  markSeenRow,
  pruneSeenLedger,
  type DockSeenLedger,
  wasSeenRow,
} from "../components/chat/dock/finished-rows"

const STORAGE_KEY = "shogo:dock-seen-rows"
/** Coalesce the writes a burst of retirements would otherwise cause. */
const WRITE_DEBOUNCE_MS = 400

let ledger: DockSeenLedger = {}
let hydrateStarted = false
let hydrated = false
let revision = 0
const listeners = new Set<() => void>()
let writeTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function parseLedger(raw: string | null): DockSeenLedger {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  const out: DockSeenLedger = {}
  for (const [sessionId, entries] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue
    const kept: Record<string, number> = {}
    for (const [key, at] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof at === "number" && Number.isFinite(at)) kept[key] = at
    }
    if (Object.keys(kept).length > 0) out[sessionId] = kept
  }
  return out
}

function scheduleWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    const snapshot = JSON.stringify(ledger)
    void Promise.resolve(setStorageItem(STORAGE_KEY, snapshot)).catch(() => {})
  }, WRITE_DEBOUNCE_MS)
}

/**
 * Read the device's ledger once. Entries already marked this session win over
 * the stored ones, so a mark that lands while storage is still loading survives.
 */
export async function hydrateDockSeenLedger(): Promise<void> {
  if (hydrated || hydrateStarted) return
  hydrateStarted = true
  let stored: DockSeenLedger = {}
  try {
    stored = parseLedger(await AsyncStorage.getItem(STORAGE_KEY))
  } catch {
    stored = {}
  }
  const merged: DockSeenLedger = { ...stored }
  for (const [sessionId, entries] of Object.entries(ledger)) {
    merged[sessionId] = { ...stored[sessionId], ...entries }
  }
  ledger = pruneSeenLedger(merged, Date.now())
  hydrated = true
  notify()
}

export function getDockSeenLedgerRevision(): number {
  return revision
}

export function subscribeDockSeenLedger(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Has this device already watched this row retire in this chat? Read during
 * render, so it must stay pure — expired entries are pruned on the next write.
 */
export function wasDockRowShown(
  sessionId: string | null | undefined,
  key: string,
  now: number = Date.now(),
): boolean {
  return wasSeenRow(ledger, sessionId, key, now)
}

/** This device watched the row finish its exit: do not replay it. */
export function markDockRowShown(
  sessionId: string | null | undefined,
  key: string,
  at: number = Date.now(),
): void {
  if (!sessionId) return
  const next = markSeenRow(ledger, sessionId, key, at, at)
  if (next === ledger) return
  ledger = next
  scheduleWrite()
  notify()
}

/** Test seam: forget every row, cancel a pending write and stay hydrated. */
export function __resetDockSeenLedgerForTests(): void {
  ledger = {}
  hydrated = true
  hydrateStarted = true
  if (writeTimer) {
    clearTimeout(writeTimer)
    writeTimer = null
  }
  notify()
}

/**
 * Test seam: also forget that storage was ever read, so the next
 * `hydrateDockSeenLedger()` loads it again — the store's own test needs more
 * than one "app start" in a process.
 */
export function __resetDockSeenLedgerStorageForTests(): void {
  __resetDockSeenLedgerForTests()
  hydrated = false
  hydrateStarted = false
}

/** Test seam: seed a chat's ledger as if those rows had already retired here. */
export function __seedDockSeenLedgerForTests(
  sessionId: string,
  keys: readonly string[],
  at: number = Date.now(),
): void {
  let next = ledger
  for (const key of keys) next = markSeenRow(next, sessionId, key, at, at)
  ledger = next
  notify()
}
