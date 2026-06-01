// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * UX-CMDPAL — Palette + fzf + MRU integration.
 *
 * Covers user-visible behaviours:
 *   • fzf ranking (better matches surface first)
 *   • MRU bumps repeated picks to the top
 *   • Empty query → MRU-ordered list at the top (recently-used affordance)
 *   • recordPick on Enter / click; NOT on Escape
 *   • Synthetic items are picked but NOT MRU-recorded
 *   • Sublabel matches rank below label matches of equal text quality
 *
 * The fzf scorer and MRU module each have their own pinning unit tests
 * (fzf-scorer.test.ts, palette-mru.test.ts). This file proves the THREE
 * are wired together correctly in the consumer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Palette, type PaletteItem } from "../Palette"
import { _CONSTANTS as MRU_CONST } from "../palette-mru"

beforeEach(() => {
  localStorage.clear()
})
afterEach(() => {
  cleanup()
  localStorage.clear()
})

function mk(id: string, label: string, extra: Partial<PaletteItem> = {}): PaletteItem {
  return { id, label, run: () => {}, ...extra }
}

/** Read the rendered row labels in display order. */
function visibleLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-idx]"))
    .map((el) => el.querySelector("div > div")?.textContent ?? "")
}

describe("Palette — fzf ranking integration", () => {
  test("renders all items when query is empty", () => {
    const items = [mk("a", "Alpha"), mk("b", "Beta"), mk("c", "Gamma")]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    expect(visibleLabels()).toEqual(["Alpha", "Beta", "Gamma"])
  })

  test("typing narrows + reorders by fzf score", () => {
    const items = [
      mk("ot", "Open Terminal"),
      mk("ct", "Close Tab"),
      mk("tt", "Toggle Terminal"),
    ]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    const input = screen.getByPlaceholderText("…") as HTMLInputElement
    fireEvent.change(input, { target: { value: "tt" } })
    // "Toggle Terminal" matches 't','t' consecutively at start of words
    // — beats "Open Terminal" / "Close Tab" decisively.
    const labels = visibleLabels()
    expect(labels[0]).toBe("Toggle Terminal")
  })

  test("non-matching query produces empty result + emptyHint", () => {
    render(
      <Palette
        placeholder="…"
        items={[mk("a", "Alpha")]}
        emptyHint="Nothing here"
        onClose={() => {}}
      />,
    )
    const input = screen.getByPlaceholderText("…") as HTMLInputElement
    fireEvent.change(input, { target: { value: "xyz" } })
    expect(screen.getByText("Nothing here")).toBeDefined()
  })
})

describe("Palette — MRU integration", () => {
  test("empty query surfaces MRU-ordered items first", () => {
    const items = [
      mk("a", "Alpha"),
      mk("b", "Beta"),
      mk("c", "Gamma"),
    ]
    // Pre-seed MRU: 'c' picked yesterday, 'b' picked just now.
    const now = Date.now()
    localStorage.setItem(
      MRU_CONST.STORAGE_KEY,
      JSON.stringify({
        c: { freq: 1, lastUsedMs: now - 86_400_000 },
        b: { freq: 1, lastUsedMs: now - 1000 },
      }),
    )
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    // Both 'b' and 'c' should rank above 'a' (which has no MRU).
    // 'b' (fresher) above 'c'.
    const labels = visibleLabels()
    expect(labels.indexOf("Beta")).toBeLessThan(labels.indexOf("Alpha"))
    expect(labels.indexOf("Gamma")).toBeLessThan(labels.indexOf("Alpha"))
  })

  test("clicking a row records the pick in MRU", () => {
    const items = [mk("alpha-id", "Alpha"), mk("beta-id", "Beta")]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    fireEvent.click(document.querySelector('[data-idx="1"]')!) // pick "Beta"
    const map = JSON.parse(localStorage.getItem(MRU_CONST.STORAGE_KEY) ?? "{}")
    expect(map["beta-id"]).toBeDefined()
    expect(map["beta-id"].freq).toBe(1)
  })

  test("pressing Enter records the pick in MRU", () => {
    const items = [mk("alpha-id", "Alpha"), mk("beta-id", "Beta")]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    const input = document.querySelector("input")!
    fireEvent.keyDown(input, { key: "Enter" })
    const map = JSON.parse(localStorage.getItem(MRU_CONST.STORAGE_KEY) ?? "{}")
    // active=0 → "Alpha" is recorded.
    expect(map["alpha-id"]).toBeDefined()
  })

  test("pressing Escape does NOT record any pick", () => {
    const items = [mk("alpha-id", "Alpha")]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    fireEvent.keyDown(document.querySelector("input")!, { key: "Escape" })
    expect(localStorage.getItem(MRU_CONST.STORAGE_KEY)).toBeNull()
  })

  test("after several picks, repeated item bubbles to the top of empty query", () => {
    const items = [mk("a", "Alpha"), mk("b", "Beta"), mk("c", "Gamma")]
    // Pick "Gamma" 3 times via direct API (the recordPick path used
    // by the palette internally). Re-render and confirm ordering.
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    // Click Gamma three times — but each click closes the palette,
    // so we re-render between clicks. Easier: directly drive the
    // localStorage via recordPick semantics.
    const now = Date.now()
    localStorage.setItem(
      MRU_CONST.STORAGE_KEY,
      JSON.stringify({ c: { freq: 8, lastUsedMs: now } }),
    )
    cleanup()
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    expect(visibleLabels()[0]).toBe("Gamma")
  })
})

describe("Palette — synthetic items", () => {
  test("synthetic item is shown when syntheticItem returns one", () => {
    render(
      <Palette
        placeholder="…"
        items={[]}
        onClose={() => {}}
        syntheticItem={(q) =>
          q ? { id: `synth-${q}`, label: `Create file '${q}'`, run: () => {} } : null
        }
      />,
    )
    fireEvent.change(document.querySelector("input")!, { target: { value: "newfile" } })
    expect(screen.getByText("Create file 'newfile'")).toBeDefined()
  })

  test("picking a synthetic item does NOT pollute the MRU cache", () => {
    render(
      <Palette
        placeholder="…"
        items={[]}
        onClose={() => {}}
        syntheticItem={(q) =>
          q ? { id: `synth-${q}`, label: `Create '${q}'`, run: () => {} } : null
        }
      />,
    )
    fireEvent.change(document.querySelector("input")!, { target: { value: "x" } })
    fireEvent.click(document.querySelector('[data-idx="0"]')!) // pick the synthetic
    // The synthetic id ("synth-x") MUST NOT appear in MRU storage —
    // otherwise the cache slowly fills with one-off file names the
    // user never types again.
    const raw = localStorage.getItem(MRU_CONST.STORAGE_KEY)
    if (raw) {
      const map = JSON.parse(raw)
      expect(map["synth-x"]).toBeUndefined()
    }
  })
})

describe("Palette — sublabel fallback", () => {
  test("sublabel-only match scores below label match of same shape", () => {
    const items = [
      mk("a", "Format Document", { sublabel: "formatter" }),
      mk("b", "Toggle Word Wrap", { sublabel: "format" }), // "format" only in sublabel
    ]
    render(<Palette placeholder="…" items={items} onClose={() => {}} />)
    fireEvent.change(document.querySelector("input")!, { target: { value: "format" } })
    // Both items should render — pull them by data-idx and check text
    // content directly, bypassing the more fragile label extractor.
    const rows = Array.from(document.querySelectorAll<HTMLElement>("[data-idx]"))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const text = rows.map((r) => r.textContent ?? "")
    const idxFormatDoc = text.findIndex((t) => t.includes("Format Document"))
    const idxToggle = text.findIndex((t) => t.includes("Toggle Word Wrap"))
    expect(idxFormatDoc).toBeGreaterThanOrEqual(0)
    expect(idxToggle).toBeGreaterThanOrEqual(0)
    // Label-match must rank above sublabel-only match.
    expect(idxFormatDoc).toBeLessThan(idxToggle)
  })
})
