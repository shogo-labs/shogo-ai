// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * OutlinePanel — VS Code-parity Outline view (FEAT-OUTLINE).
 *
 * Shows the document-symbol tree of the active editor with:
 *   - a live filter box (substring, keeps ancestors of matches)
 *   - a sort toggle cycling Position → Name → Category
 *   - cursor-follow: the symbol containing the caret is highlighted and
 *     scrolled into view
 *   - collapsible parents (twistie), click-to-reveal in the editor
 *
 * All tree maths live in the pure, unit-tested `outline-model.ts`; this file
 * is just rendering + local UI state.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, X, ArrowUpDown, ListTree } from "lucide-react-native";
import {
  buildOutline,
  filterOutline,
  sortOutline,
  flattenVisible,
  findActiveSymbolId,
  symbolKindLabel,
  OUTLINE_SORT_MODES,
  OUTLINE_SORT_LABELS,
  type DocumentSymbolLike,
  type OutlineSortMode,
} from "./outline-model";

/** Category → tailwind color classes for the kind-letter badge. */
function kindBadgeClass(kind: number): string {
  // Function/Method/Constructor
  if (kind === 5 || kind === 8 || kind === 11) return "text-purple-300 bg-purple-500/15";
  // Class/Interface/Struct/Enum/EnumMember
  if (kind === 4 || kind === 10 || kind === 22 || kind === 9 || kind === 21)
    return "text-amber-300 bg-amber-500/15";
  // Variable/Constant/Field/Property
  if (kind === 12 || kind === 13 || kind === 7 || kind === 6)
    return "text-sky-300 bg-sky-500/15";
  // Module/Namespace/Package/File
  if (kind === 1 || kind === 2 || kind === 3 || kind === 0)
    return "text-emerald-300 bg-emerald-500/15";
  return "text-[color:var(--ide-muted)] bg-[color:var(--ide-hover)]";
}

function KindBadge({ kind }: { kind: number }) {
  const label = symbolKindLabel(kind);
  return (
    <span
      title={label}
      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-[9px] font-bold leading-none ide-mono ${kindBadgeClass(kind)}`}
    >
      {label.charAt(0)}
    </span>
  );
}

export function OutlinePanel({
  symbols,
  loading,
  hasFile,
  activeLine,
  onReveal,
  onCollapse,
}: {
  /** Raw Monaco document symbols for the active file (null = unavailable). */
  symbols: DocumentSymbolLike[] | null;
  /** True while a fetch for the active file is in flight. */
  loading: boolean;
  /** Whether any editor/file is currently open. */
  hasFile: boolean;
  /** 1-indexed caret line, for cursor-follow highlight. */
  activeLine: number | null;
  /** Reveal a symbol: jump the editor caret to (line, col), both 1-indexed. */
  onReveal: (line: number, col: number) => void;
  /** Optional collapse-the-sidebar affordance (parity with FilesPane). */
  onCollapse?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<OutlineSortMode>("position");
  // Ids the user has explicitly collapsed. Default = everything expanded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLButtonElement | null>(null);

  const tree = useMemo(() => buildOutline(symbols ?? []), [symbols]);
  const filtered = useMemo(() => filterOutline(tree, query), [tree, query]);
  const sorted = useMemo(() => sortOutline(filtered, sortMode), [filtered, sortMode]);
  const rows = useMemo(() => flattenVisible(sorted, collapsed), [sorted, collapsed]);

  // Cursor-follow: which row (if any) the caret sits in. Computed against the
  // unfiltered/unsorted tree so a filter doesn't drop the highlight target,
  // then matched into the visible rows by id.
  const activeId = useMemo(
    () => (activeLine == null ? null : findActiveSymbolId(tree, activeLine)),
    [tree, activeLine],
  );

  // Scroll the active row into view when it changes.
  useEffect(() => {
    if (activeId && activeRowRef.current) {
      activeRowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [activeId]);

  const toggleCollapse = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const cycleSort = () => {
    const i = OUTLINE_SORT_MODES.indexOf(sortMode);
    setSortMode(OUTLINE_SORT_MODES[(i + 1) % OUTLINE_SORT_MODES.length]);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
          Outline
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={cycleSort}
            title={OUTLINE_SORT_LABELS[sortMode]}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
          >
            <ArrowUpDown size={12} />
            <span className="capitalize">{sortMode}</span>
          </button>
          {onCollapse && (
            <button
              onClick={onCollapse}
              title="Hide Outline"
              className="rounded p-0.5 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Filter */}
      <div className="px-3 pb-1">
        <div className="relative flex items-center rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-input-bg)] focus-within:border-[color:var(--ide-active-ring)]">
          <ListTree size={13} className="ml-2 mr-1 shrink-0 text-[color:var(--ide-muted)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
            }}
            placeholder="Filter symbols"
            className="no-focus-ring min-w-0 flex-1 bg-transparent pl-1 pr-2 py-1.5 text-[12px] text-[color:var(--ide-text-strong)] placeholder:text-[color:var(--ide-muted-strong)] outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear filter"
              className="mr-1 rounded p-0.5 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto py-1">
        {!hasFile ? (
          <EmptyState text="Open a file to see its outline." />
        ) : loading && rows.length === 0 ? (
          <EmptyState text="Loading symbols…" />
        ) : tree.length === 0 ? (
          <EmptyState text="No symbols in this file." />
        ) : rows.length === 0 ? (
          <EmptyState text={`No symbols matching “${query}”.`} />
        ) : (
          rows.map(({ node, hasChildren, collapsed: isCollapsed }) => {
            const isActive = node.id === activeId;
            return (
              <button
                key={node.id}
                ref={isActive ? activeRowRef : undefined}
                onClick={() => {
                  onReveal(
                    node.selectionRange.startLineNumber,
                    node.selectionRange.startColumn,
                  );
                }}
                className={`group flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[12px] ${
                  isActive
                    ? "bg-[color:var(--ide-active-bg,rgba(255,255,255,0.08))] text-[color:var(--ide-text-strong)]"
                    : "text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
                }`}
                style={{ paddingLeft: 8 + node.depth * 12 }}
              >
                {hasChildren ? (
                  <span
                    role="button"
                    title={isCollapsed ? "Expand" : "Collapse"}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleCollapse(node.id);
                    }}
                    className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[color:var(--ide-muted)]"
                  >
                    {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </span>
                ) : (
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                <KindBadge kind={node.kind} />
                <span className="truncate">{node.name}</span>
                {node.detail ? (
                  <span className="truncate text-[11px] text-[color:var(--ide-muted)]">
                    {node.detail}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="px-4 py-6 text-center text-[12px] text-[color:var(--ide-muted)]">
      {text}
    </div>
  );
}
