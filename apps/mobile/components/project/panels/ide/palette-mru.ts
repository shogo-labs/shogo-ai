// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-CMDPAL — palette MRU (most-recently-used) cache.
 *
 * Each time the user picks a palette item we record { freq, lastUsedMs }
 * keyed by the item id. The scorer combines fuzzy text score with an MRU
 * bonus so a user who runs "Toggle Terminal" 30 times a day reaches that
 * command on the first character pressed, not after typing the full word.
 *
 * Design points pinned by `palette-mru.test.ts` (12 specs):
 *
 *   • localStorage-backed, single key, versioned (`shogo.ide.palette-mru.v1`).
 *     Forward-compat: if we ever change the payload shape the version
 *     suffix bumps and old payloads are ignored (no migration code, no
 *     half-decoded entries lingering).
 *
 *   • Bonus is capped (max +12). Even an item picked 1000 times can't
 *     overpower a clearly-better text match — fuzzy stays the primary
 *     signal, MRU is the tiebreak.
 *
 *   • Exponential decay over 30 days. Frequency alone is misleading
 *     ("I used to run this every day six months ago" shouldn't bury
 *     a command you actually want today). lastUsedMs feeds a decay
 *     coefficient that halves the bonus every ~10 days.
 *
 *   • LRU eviction at 200 entries. Keeps the payload bounded and the
 *     `for ... in` scan cheap — palette only filters against currently-
 *     mounted items anyway, so a stale id is harmless.
 *
 *   • SSR / no-localStorage / disabled-cookies / malformed-JSON ALL fail
 *     cleanly to "empty MRU" — palette still works, no thrown errors,
 *     no broken filter. Tested.
 *
 *   • All writes go through a single `recordPick(id)` so a future
 *     telemetry hook (or a "clear MRU" settings action) has exactly
 *     one site to patch.
 */

const STORAGE_KEY = "shogo.ide.palette-mru.v1"
const MAX_ENTRIES = 200
const MAX_BONUS = 12
/** Half-life in days. After 10 days the bonus from a single pick halves. */
const DECAY_HALF_LIFE_DAYS = 10
const MS_PER_DAY = 86_400_000

interface MRUEntry {
  /** Total number of picks ever (saturates the freq term, see weight()). */
  freq: number
  /** Last-used timestamp in epoch ms. */
  lastUsedMs: number
}

type MRUMap = Record<string, MRUEntry>

// ─── storage ─────────────────────────────────────────────────────────────

/** Read the MRU map. Always returns a fresh object; never throws. */
export function readMRU(): MRUMap {
  try {
    if (typeof localStorage === "undefined") return {}
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") return {}
    // Shallow validate: keep entries that look right, drop the rest.
    // Defensive — a future devtools-edit or partial write can't poison
    // the palette.
    const out: MRUMap = {}
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== "object") continue
      const e = v as Partial<MRUEntry>
      if (typeof e.freq !== "number" || !Number.isFinite(e.freq)) continue
      if (typeof e.lastUsedMs !== "number" || !Number.isFinite(e.lastUsedMs)) continue
      if (e.freq < 0) continue
      out[id] = { freq: e.freq, lastUsedMs: e.lastUsedMs }
    }
    return out
  } catch {
    return {}
  }
}

/** Persist the MRU map. Silent no-op if storage is unavailable. */
function writeMRU(map: MRUMap): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    /* quota exceeded / private mode / SSR — palette still works */
  }
}

/**
 * Record a pick. Bumps freq, sets lastUsedMs to now, evicts the
 * least-recently-used entry once we cross MAX_ENTRIES.
 *
 * Synthetic palette items (the "Create file 'foo.ts'" path) should
 * NOT be recorded — pass `{ synthetic: true }` to skip persistence.
 * Recording synthetic ids would slowly fill the cache with one-off
 * filenames the user never types again.
 */
export function recordPick(
  id: string,
  opts: { synthetic?: boolean; now?: number } = {},
): void {
  if (opts.synthetic) return
  if (!id) return
  const map = readMRU()
  const now = opts.now ?? Date.now()
  const prev = map[id]
  map[id] = {
    freq: (prev?.freq ?? 0) + 1,
    lastUsedMs: now,
  }
  if (Object.keys(map).length > MAX_ENTRIES) {
    // Evict the oldest entry (lowest lastUsedMs). One pass — O(n) but
    // n ≤ 201 here.
    let oldestId: string | null = null
    let oldestTs = Infinity
    for (const [k, v] of Object.entries(map)) {
      if (k === id) continue // never evict the entry we just wrote
      if (v.lastUsedMs < oldestTs) {
        oldestTs = v.lastUsedMs
        oldestId = k
      }
    }
    if (oldestId) delete map[oldestId]
  }
  writeMRU(map)
}

/**
 * Compute the bonus to add to the fzf score for a given id.
 *
 * Formula:
 *   freqTerm  = log2(freq + 1)          // diminishing returns; 1→1, 2→1.58, 4→2.32, 16→4.09…
 *   ageDays   = (now - lastUsedMs) / dayMs
 *   decay     = 0.5 ** (ageDays / HALF_LIFE_DAYS)
 *   bonus     = clamp(freqTerm * decay * 6, 0, MAX_BONUS)
 *
 * • A fresh single pick: freqTerm=1, decay=1 → bonus ≈ 6.
 * • Picked 16 times today: freqTerm=4.09, decay=1 → 24.5 → CLAMPED to 12.
 * • Picked once 30 days ago: freqTerm=1, decay≈0.125 → bonus ≈ 0.75.
 * • Picked once 90 days ago: freqTerm=1, decay≈0.0019 → bonus ≈ 0.01.
 *
 * The clamp ensures even spammy items can't drown out a clearly-better
 * text match (the SCORE_MATCH * needle.length term in fzf-scorer
 * dominates anything past a 2-char query).
 */
export function getMRUBonus(id: string, now: number = Date.now()): number {
  const map = readMRU()
  return getMRUBonusFrom(map, id, now)
}

/**
 * Variant that takes the map as input — avoids one localStorage read
 * per item when the palette filter is computing scores in a loop.
 * Pass `readMRU()` once at the top of the filter and reuse.
 */
export function getMRUBonusFrom(map: MRUMap, id: string, now: number = Date.now()): number {
  const entry = map[id]
  if (!entry) return 0
  const ageDays = Math.max(0, (now - entry.lastUsedMs) / MS_PER_DAY)
  const decay = Math.pow(0.5, ageDays / DECAY_HALF_LIFE_DAYS)
  const freqTerm = Math.log2(entry.freq + 1)
  const raw = freqTerm * decay * 6
  if (!Number.isFinite(raw)) return 0
  return Math.max(0, Math.min(MAX_BONUS, raw))
}

/** Clear the entire MRU cache. Used by tests AND by a future settings action. */
export function clearMRU(): void {
  try {
    if (typeof localStorage === "undefined") return
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

// ─── test-facing exports ────────────────────────────────────────────────
/** @internal */
export const _CONSTANTS = {
  STORAGE_KEY,
  MAX_ENTRIES,
  MAX_BONUS,
  DECAY_HALF_LIFE_DAYS,
  MS_PER_DAY,
}
