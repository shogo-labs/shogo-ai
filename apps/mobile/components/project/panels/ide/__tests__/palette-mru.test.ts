// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-CMDPAL — palette-mru storage + weight tests.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  _CONSTANTS,
  clearMRU,
  getMRUBonus,
  getMRUBonusFrom,
  readMRU,
  recordPick,
} from "../palette-mru"

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  localStorage.clear()
})

describe("palette-mru — readMRU defensive cases", () => {
  test("empty storage → {}", () => {
    expect(readMRU()).toEqual({})
  })

  test("malformed JSON → {} (does not throw)", () => {
    localStorage.setItem(_CONSTANTS.STORAGE_KEY, "{not json")
    expect(readMRU()).toEqual({})
  })

  test("non-object payload → {} (defensive)", () => {
    localStorage.setItem(_CONSTANTS.STORAGE_KEY, JSON.stringify(42))
    expect(readMRU()).toEqual({})
  })

  test("entries missing required fields are dropped, valid entries kept", () => {
    localStorage.setItem(
      _CONSTANTS.STORAGE_KEY,
      JSON.stringify({
        good: { freq: 3, lastUsedMs: 1000 },
        noFreq: { lastUsedMs: 1000 },
        noTs: { freq: 1 },
        negFreq: { freq: -1, lastUsedMs: 1000 },
        nullEntry: null,
        notObject: "string",
      }),
    )
    const map = readMRU()
    expect(map).toEqual({ good: { freq: 3, lastUsedMs: 1000 } })
  })
})

describe("palette-mru — recordPick / write path", () => {
  test("first pick creates an entry with freq=1", () => {
    recordPick("cmd:open", { now: 1000 })
    expect(readMRU()).toEqual({
      "cmd:open": { freq: 1, lastUsedMs: 1000 },
    })
  })

  test("repeated picks bump freq and update lastUsedMs", () => {
    recordPick("cmd:open", { now: 1000 })
    recordPick("cmd:open", { now: 2000 })
    recordPick("cmd:open", { now: 3000 })
    expect(readMRU()).toEqual({
      "cmd:open": { freq: 3, lastUsedMs: 3000 },
    })
  })

  test("synthetic items are dropped (no persistence)", () => {
    recordPick("file:foo.ts", { synthetic: true, now: 1000 })
    expect(readMRU()).toEqual({})
  })

  test("empty id is silently ignored", () => {
    recordPick("", { now: 1000 })
    expect(readMRU()).toEqual({})
  })

  test("LRU eviction at MAX_ENTRIES", () => {
    // Fill exactly MAX_ENTRIES with ascending timestamps, then add one
    // more — the OLDEST (id "0") should be evicted.
    for (let i = 0; i < _CONSTANTS.MAX_ENTRIES; i++) {
      recordPick(`id-${i}`, { now: 1000 + i })
    }
    expect(Object.keys(readMRU())).toHaveLength(_CONSTANTS.MAX_ENTRIES)
    recordPick("brand-new", { now: 999_999 })
    const map = readMRU()
    expect(Object.keys(map)).toHaveLength(_CONSTANTS.MAX_ENTRIES)
    expect(map["brand-new"]).toBeDefined()
    expect(map["id-0"]).toBeUndefined() // oldest evicted
  })

  test("LRU eviction never evicts the just-written entry", () => {
    // Adversarial — the entry we just wrote has lastUsedMs older than
    // some existing entries (clock skew, manual now override). The
    // code must still preserve it.
    for (let i = 0; i < _CONSTANTS.MAX_ENTRIES; i++) {
      recordPick(`id-${i}`, { now: 1_000_000 + i })
    }
    recordPick("late-but-fresh", { now: 1 }) // ancient timestamp
    const map = readMRU()
    expect(map["late-but-fresh"]).toBeDefined()
  })
})

describe("palette-mru — getMRUBonus / weight semantics", () => {
  test("unknown id → 0 bonus", () => {
    expect(getMRUBonus("nope")).toBe(0)
  })

  test("fresh single pick → bonus ≈ 6", () => {
    recordPick("cmd", { now: 1_000_000 })
    expect(getMRUBonus("cmd", 1_000_000)).toBeCloseTo(6, 1)
  })

  test("frequency boost diminishes (log scale)", () => {
    for (let i = 0; i < 16; i++) recordPick("hot", { now: 1_000_000 })
    // freqTerm = log2(17) ≈ 4.09, decay=1, raw=24.5 → CLAMPED to MAX_BONUS
    const bonus = getMRUBonus("hot", 1_000_000)
    expect(bonus).toBe(_CONSTANTS.MAX_BONUS)
  })

  test("decay halves bonus every HALF_LIFE_DAYS", () => {
    recordPick("cmd", { now: 0 })
    const fresh = getMRUBonus("cmd", 0)
    const oneHalfLife = getMRUBonus(
      "cmd",
      _CONSTANTS.DECAY_HALF_LIFE_DAYS * _CONSTANTS.MS_PER_DAY,
    )
    expect(oneHalfLife).toBeCloseTo(fresh / 2, 2)
  })

  test("decay essentially zeroes after ~6 half-lives (60 days)", () => {
    recordPick("cmd", { now: 0 })
    const old = getMRUBonus(
      "cmd",
      6 * _CONSTANTS.DECAY_HALF_LIFE_DAYS * _CONSTANTS.MS_PER_DAY,
    )
    expect(old).toBeLessThan(0.5)
  })

  test("bonus never exceeds MAX_BONUS even with extreme frequency", () => {
    // Fake an extreme frequency entry directly via storage.
    localStorage.setItem(
      _CONSTANTS.STORAGE_KEY,
      JSON.stringify({ cmd: { freq: 1_000_000, lastUsedMs: 999 } }),
    )
    expect(getMRUBonus("cmd", 999)).toBe(_CONSTANTS.MAX_BONUS)
  })

  test("bonus never negative even for far-future timestamps (clock skew defence)", () => {
    // Entry's lastUsedMs is in the future relative to `now`. ageDays
    // becomes negative; we clamp to 0 so decay coefficient is 1.
    recordPick("cmd", { now: 1_000_000 })
    expect(getMRUBonus("cmd", 999_999)).toBeGreaterThanOrEqual(0)
  })

  test("getMRUBonusFrom uses caller-supplied map (no localStorage read)", () => {
    // The hot-loop variant: caller reads once, scores many.
    const map = {
      a: { freq: 1, lastUsedMs: 0 },
      b: { freq: 4, lastUsedMs: 0 },
    }
    const aBonus = getMRUBonusFrom(map, "a", 0)
    const bBonus = getMRUBonusFrom(map, "b", 0)
    expect(bBonus).toBeGreaterThan(aBonus) // b picked more, bonus higher
  })
})

describe("palette-mru — clearMRU", () => {
  test("removes all entries", () => {
    recordPick("a", { now: 1 })
    recordPick("b", { now: 2 })
    expect(Object.keys(readMRU())).toHaveLength(2)
    clearMRU()
    expect(readMRU()).toEqual({})
  })
})
