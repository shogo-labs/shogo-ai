import { useEffect, useMemo, useRef, useState } from "react";
import { highlightMatch } from "./fuzzy";
import { fzfScore } from "./fzf-scorer";
import { getMRUBonusFrom, readMRU, recordPick } from "./palette-mru";

export interface PaletteItem {
  id: string;
  label: string;
  /**
   * Secondary text shown in muted-foreground beneath the label. ALSO
   * searched as a fallback fuzzy tier (below label, above searchText)
   * with the same -8 score penalty. Quick Open uses this for
   * disambiguated parent-dir hints — see UX-QUICKOPEN-PATH.
   */
  sublabel?: string;
  /**
   * Hidden searchable text — fuzzy-matched but NEVER rendered. Quick
   * Open uses this to make the full path searchable even when the
   * basename is unique and no visible sublabel is shown. Same -8
   * penalty as a sublabel-only match, so a label match always wins.
   */
  searchText?: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export function Palette({
  placeholder,
  items,
  onClose,
  emptyHint,
  syntheticItem,
}: {
  placeholder: string;
  items: PaletteItem[];
  onClose: () => void;
  emptyHint?: string;
  syntheticItem?: (query: string) => PaletteItem | null;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    const synth = syntheticItem?.(query);
    if (synth) return [{ item: synth, indices: [] as number[] }];

    // Read MRU map once per filter pass — readMRU() is JSON.parse on
    // a small payload but we still don't want to do it once per item.
    const mru = readMRU();
    const now = Date.now();

    if (!query) {
      // Empty query — surface most-recently-used items at the top,
      // then fall back to insertion order for everything else. The
      // 60-row cap matches the previous behaviour. This is the VS Code
      // "Recently used" pattern users expect when opening the palette
      // with no input.
      const withBonus = items.map((item) => ({
        item,
        bonus: getMRUBonusFrom(mru, item.id, now),
      }));
      withBonus.sort((a, b) => b.bonus - a.bonus);
      return withBonus.slice(0, 60).map(({ item }) => ({ item, indices: [] as number[] }));
    }

    const scored: { item: PaletteItem; score: number; indices: number[] }[] = [];
    for (const item of items) {
      const m = fzfScore(query, item.label);
      if (m) {
        // MRU bonus stacks on top of the fuzzy score — capped at +12
        // (palette-mru.MAX_BONUS), small enough that it only bubbles
        // up ties, never overrides a clearly-better text match.
        const bonus = getMRUBonusFrom(mru, item.id, now);
        scored.push({ item, score: m.score + bonus, indices: m.positions });
        continue;
      }
      // Sublabel-as-fallback: still match against sublabel, but with a
      // penalty so a label match always beats a sublabel match of the
      // same shape. -8 was the rough equivalent of the old -2 against
      // the old score scale; on the new fzf scale -8 ≈ one boundary
      // tier. We DON'T pass positions because they'd be wrong for the
      // label text we render.
      if (item.sublabel) {
        const sm = fzfScore(query, item.sublabel);
        if (sm) {
          const bonus = getMRUBonusFrom(mru, item.id, now);
          scored.push({ item, score: sm.score - 8 + bonus, indices: [] });
          continue;
        }
      }
      // searchText: render-less third tier. Used by Quick Open so
      // `components/app` still matches App.tsx even when no sublabel
      // is rendered (unique basename, single-root mode). Same -8
      // penalty as sublabel — both are non-label-text matches and
      // should rank equally against each other; only label wins.
      if (item.searchText) {
        const sm = fzfScore(query, item.searchText);
        if (sm) {
          const bonus = getMRUBonusFrom(mru, item.id, now);
          scored.push({ item, score: sm.score - 8 + bonus, indices: [] });
        }
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 60);
  }, [items, query, syntheticItem]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const row = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    // Record AFTER close + BEFORE run — recording is sync localStorage
    // and the run() may be async; we never want the run's promise
    // chain to affect whether MRU was bumped. synthetic items pass
    // `{ synthetic: true }` so palette-mru drops them on the floor —
    // see palette-mru.ts:recordPick.
    recordPick(r.item.id, { synthetic: syntheticItem?.(query)?.id === r.item.id });
    void r.item.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30"
      onClick={onClose}
    >
      <div
        className="mt-[12vh] w-[560px] max-w-[calc(100vw-40px)] overflow-hidden rounded-md border border-[color:var(--ide-border-muted)] bg-[color:var(--ide-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(active);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          className="no-focus-ring w-full border-b border-[color:var(--ide-border)] bg-transparent px-4 py-3 text-[14px] text-[color:var(--ide-text-strong)] placeholder:text-[color:var(--ide-muted)] outline-none"
        />
        <div ref={listRef} className="max-h-[50vh] overflow-auto py-1">
          {results.length === 0 ? (
            <div className="px-4 py-4 text-center text-[12px] text-[color:var(--ide-muted)]">
              {emptyHint ?? "No matches"}
            </div>
          ) : (
            results.map(({ item, indices }, i) => {
              const isActive = i === active;
              return (
                <div
                  key={item.id}
                  data-idx={i}
                  onMouseMove={() => setActive(i)}
                  onClick={() => pick(i)}
                  className={`flex cursor-pointer items-center justify-between gap-4 px-4 py-[6px] text-[13px] ${
                    isActive ? "bg-[color:var(--ide-active-bg)] text-white" : "text-[color:var(--ide-text)]"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      {query ? highlightMatch(item.label, indices) : item.label}
                    </div>
                    {item.sublabel && (
                      <div className="truncate text-[11px] text-[color:var(--ide-muted)]">
                        {item.sublabel}
                      </div>
                    )}
                  </div>
                  {item.hint && (
                    <span className="shrink-0 text-[11px] text-[color:var(--ide-muted)]">
                      {item.hint}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
