import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyMatch, highlightMatch } from "./fuzzy";

export interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
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
    if (!query) {
      return items.slice(0, 60).map((item) => ({ item, indices: [] as number[] }));
    }
    const scored: { item: PaletteItem; score: number; indices: number[] }[] = [];
    for (const item of items) {
      const m = fuzzyMatch(query, item.label);
      if (!m && item.sublabel) {
        const sm = fuzzyMatch(query, item.sublabel);
        if (sm) scored.push({ item, score: sm.score - 2, indices: [] });
        continue;
      }
      if (m) scored.push({ item, score: m.score, indices: m.indices });
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
