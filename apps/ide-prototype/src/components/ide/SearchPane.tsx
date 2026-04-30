import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search,
  X,
  CaseSensitive,
  Regex,
  Loader2,
  ChevronRight,
  ChevronDown,
  Replace,
  ArrowRight,
} from "lucide-react";
import type { Root } from "./types";
import type { SearchFileResult, WorkspaceService } from "./workspace/types";

interface RootResult {
  rootId: string;
  rootLabel: string;
  results: SearchFileResult[];
  truncated: boolean;
  error?: string;
}

export function SearchPane({
  roots,
  services,
  onReveal,
  onProposalsCreated,
  initialQuery,
}: {
  roots: Root[];
  services: Record<string, WorkspaceService>;
  /** Jump to (rootId, path, line, col) — open file + scroll editor to match. */
  onReveal: (rootId: string, path: string, line: number, col: number) => void;
  /** Called when batch-replace creates proposals so the host can show a toast / open the pane. */
  onProposalsCreated?: (count: number) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [running, setRunning] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [rootResults, setRootResults] = useState<RootResult[]>([]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setRootResults([]);
      return;
    }
    const myReq = ++reqIdRef.current;
    setRunning(true);

    const out: RootResult[] = [];
    for (const r of roots) {
      const svc = services[r.id];
      if (!svc) continue;
      try {
        const res = await svc.search(q, { caseSensitive, regex: useRegex, limit: 200 });
        if (reqIdRef.current !== myReq) return;
        out.push({ rootId: r.id, rootLabel: r.label, ...res });
      } catch (err) {
        out.push({
          rootId: r.id,
          rootLabel: r.label,
          results: [],
          truncated: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (reqIdRef.current !== myReq) return;
    setRootResults(out);
    setRunning(false);
  }, [query, roots, services, caseSensitive, useRegex]);

  // Debounce 250ms
  useEffect(() => {
    const t = window.setTimeout(() => void runSearch(), 250);
    return () => window.clearTimeout(t);
  }, [runSearch]);

  const totalFiles = rootResults.reduce((n, r) => n + r.results.length, 0);
  const totalMatches = useMemo(
    () =>
      rootResults.reduce(
        (n, r) => n + r.results.reduce((m, f) => m + f.matches.length, 0),
        0,
      ),
    [rootResults],
  );

  // ─── Replace logic ────────────────────────────────────────────────────
  const buildReplaceRegex = useCallback(() => {
    const flags = caseSensitive ? "g" : "gi";
    return useRegex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  }, [query, useRegex, caseSensitive]);

  /** Apply the active query→replacement transform to a file. Returns the new
   *  content, or null if the file was unchanged. */
  const applyReplacementToContent = useCallback(
    (content: string): string | null => {
      if (!query) return null;
      try {
        const re = buildReplaceRegex();
        const next = content.replace(re, replacement);
        return next === content ? null : next;
      } catch {
        return null;
      }
    },
    [query, replacement, buildReplaceRegex],
  );

  /**
   * Replace a single match. Re-reads the file fresh, walks to (line, col),
   * and rewrites just that occurrence. Other matches stay untouched.
   */
  const replaceSingleMatch = useCallback(
    async (rootId: string, path: string, line: number, col: number) => {
      const svc = services[rootId];
      if (!svc || !query) return;
      try {
        const file = await svc.readFile(path);
        const lines = file.content.split("\n");
        const idx = line - 1;
        if (idx < 0 || idx >= lines.length) return;
        const re = buildReplaceRegex();
        // Anchor the regex at (col-1) by replacing only the first match at/after that index.
        const lineStr = lines[idx];
        re.lastIndex = Math.max(0, col - 1);
        const m = re.exec(lineStr);
        if (!m) return;
        const before = lineStr.slice(0, m.index);
        const after = lineStr.slice(m.index + m[0].length);
        // Apply replacement (supports $1, $2, … for regex captures).
        const replaced = lineStr
          .slice(m.index, m.index + m[0].length)
          .replace(re, replacement);
        lines[idx] = before + replaced + after;
        const next = lines.join("\n");
        await svc.writeFile(path, next); // review: true by default → proposal
        onProposalsCreated?.(1);
      } catch (err) {
        console.error("replaceSingleMatch failed", err);
      }
    },
    [services, query, replacement, buildReplaceRegex, onProposalsCreated],
  );

  /** Replace every match in a single file in one proposal. */
  const replaceInFile = useCallback(
    async (rootId: string, path: string) => {
      const svc = services[rootId];
      if (!svc || !query) return;
      try {
        const file = await svc.readFile(path);
        const next = applyReplacementToContent(file.content);
        if (next === null) return;
        await svc.writeFile(path, next);
        onProposalsCreated?.(1);
      } catch (err) {
        console.error("replaceInFile failed", err);
      }
    },
    [services, query, applyReplacementToContent, onProposalsCreated],
  );

  /** Replace across every matching file → one proposal per file. */
  const replaceAll = useCallback(async () => {
    if (!query || replacing) return;
    setReplacing(true);
    let created = 0;
    try {
      for (const rr of rootResults) {
        const svc = services[rr.rootId];
        if (!svc) continue;
        for (const file of rr.results) {
          try {
            const f = await svc.readFile(file.path);
            const next = applyReplacementToContent(f.content);
            if (next === null) continue;
            await svc.writeFile(file.path, next);
            created++;
          } catch (err) {
            console.error("replaceAll: file failed", file.path, err);
          }
        }
      }
      if (created > 0) onProposalsCreated?.(created);
    } finally {
      setReplacing(false);
    }
  }, [query, replacing, rootResults, services, applyReplacementToContent, onProposalsCreated]);

  const highlight = (line: string) => {
    if (!query) return line;
    try {
      const re = useRegex
        ? new RegExp(query, caseSensitive ? "g" : "gi")
        : new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            caseSensitive ? "g" : "gi",
          );
      const parts: React.ReactNode[] = [];
      let last = 0;
      let m: RegExpExecArray | null;
      let i = 0;
      while ((m = re.exec(line)) && i++ < 50) {
        if (m.index > last) parts.push(line.slice(last, m.index));
        parts.push(
          <span key={`${m.index}-${i}`} className="bg-[#514b17] text-[#ffd75e]">
            {m[0]}
          </span>,
        );
        last = m.index + m[0].length;
        if (m[0].length === 0) re.lastIndex++;
      }
      if (last < line.length) parts.push(line.slice(last));
      return parts;
    } catch {
      return line;
    }
  };

  const canReplace = query.length > 0 && totalMatches > 0 && !replacing;

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
        Search
      </div>

      {/* Query input */}
      <div className="px-3 pb-1">
        <div className="flex items-start gap-1">
          <button
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? "Hide replace" : "Toggle Replace"}
            className="mt-1.5 rounded p-0.5 text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
          >
            {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="flex-1 space-y-1">
            <div className="relative flex items-center rounded border border-[#3a3a3a] bg-[#1a1a1a] focus-within:border-[#0078d4]">
              <Search size={12} className="ml-2 text-[#858585]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search across all workspaces"
                className="flex-1 bg-transparent px-2 py-1.5 text-[12px] text-white placeholder:text-[#666] outline-none"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="mr-1 rounded p-0.5 text-[#858585] hover:bg-[#ffffff1a] hover:text-white"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {showReplace && (
              <div className="relative flex items-center rounded border border-[#3a3a3a] bg-[#1a1a1a] focus-within:border-[#0078d4]">
                <Replace size={12} className="ml-2 text-[#858585]" />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canReplace) void replaceAll();
                  }}
                  placeholder={
                    useRegex ? "Replace (use $1, $2 for groups)" : "Replace"
                  }
                  className="flex-1 bg-transparent px-2 py-1.5 text-[12px] text-white placeholder:text-[#666] outline-none"
                />
                <button
                  disabled={!canReplace}
                  onClick={() => void replaceAll()}
                  title="Replace all (creates proposals)"
                  className="mr-1 flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium text-white enabled:bg-amber-600 enabled:hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {replacing ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <ArrowRight size={11} />
                  )}
                  All
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-1.5 flex items-center gap-1 pl-5">
          <ToggleBtn on={caseSensitive} onClick={() => setCaseSensitive((v) => !v)} title="Match Case">
            <CaseSensitive size={12} />
          </ToggleBtn>
          <ToggleBtn on={useRegex} onClick={() => setUseRegex((v) => !v)} title="Use Regular Expression">
            <Regex size={12} />
          </ToggleBtn>
          <div className="ml-auto flex items-center gap-2 text-[10px] text-[#858585]">
            {running && <Loader2 size={11} className="animate-spin" />}
            {query && !running && (
              <span>
                {totalMatches} match{totalMatches === 1 ? "" : "es"} in {totalFiles} file
                {totalFiles === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="mt-2 flex-1 overflow-auto text-[12px]">
        {!query && (
          <div className="px-4 py-6 text-center text-[11px] text-[#666]">
            Type to search across{" "}
            <span className="text-[#cccccc]">
              {roots.length} workspace{roots.length === 1 ? "" : "s"}
            </span>
            .
            <div className="mt-2 text-[10px]">⌘⇧F from anywhere</div>
            {showReplace && (
              <div className="mt-2 text-[10px] text-[#858585]">
                Replacements become Proposals you review in the ⚡ pane before
                they hit disk.
              </div>
            )}
          </div>
        )}

        {query && !running && rootResults.every((r) => r.results.length === 0 && !r.error) && (
          <div className="px-4 py-6 text-center text-[11px] text-[#666]">No results</div>
        )}

        {rootResults.map((rr) => {
          if (rr.results.length === 0 && !rr.error) return null;
          const multi = roots.length > 1;
          return (
            <div key={rr.rootId} className="mb-1">
              {multi && (
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[#858585]">
                  {rr.rootLabel}
                  {rr.truncated && <span className="ml-2 text-[#ffb74d]">(truncated)</span>}
                </div>
              )}
              {rr.error && (
                <div className="px-4 py-1 text-[11px] text-[#f48771]">{rr.error}</div>
              )}
              {rr.results.map((file) => {
                const key = `${rr.rootId}::${file.path}`;
                const hidden = collapsed[key];
                return (
                  <div key={key} className="select-none group">
                    <div className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] hover:bg-[#2a2a2a]">
                      <button
                        onClick={() =>
                          setCollapsed((c) => ({ ...c, [key]: !c[key] }))
                        }
                        className="flex flex-1 items-center gap-1 truncate"
                      >
                        {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <span className="truncate text-[#cccccc]">
                          {file.path.split("/").pop()}
                        </span>
                        <span className="truncate text-[11px] text-[#858585]">
                          {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}
                        </span>
                      </button>
                      {showReplace && canReplace && (
                        <button
                          onClick={() => void replaceInFile(rr.rootId, file.path)}
                          title={`Replace ${file.matches.length} in this file`}
                          className="rounded px-1.5 py-0.5 text-[10px] text-amber-300 opacity-0 hover:bg-amber-500/20 group-hover:opacity-100"
                        >
                          ↪ {file.matches.length}
                        </button>
                      )}
                      <span className="ml-1 rounded bg-[#2a2a2a] px-1.5 text-[10px] text-[#858585]">
                        {file.matches.length}
                      </span>
                    </div>
                    {!hidden &&
                      file.matches.map((m, i) => (
                        <div
                          key={`${key}-${i}`}
                          className="flex w-full items-baseline gap-2 px-6 py-[2px] text-left font-mono text-[11px] hover:bg-[#2a2a2a] group/match"
                        >
                          <button
                            onClick={() => onReveal(rr.rootId, file.path, m.line, m.col)}
                            title={`${file.path}:${m.line}:${m.col}`}
                            className="flex flex-1 items-baseline gap-2 truncate text-left"
                          >
                            <span className="w-10 shrink-0 text-right text-[#666]">{m.line}</span>
                            <span className="truncate text-[#d4d4d4]">{highlight(m.preview)}</span>
                          </button>
                          {showReplace && canReplace && (
                            <button
                              onClick={() =>
                                void replaceSingleMatch(rr.rootId, file.path, m.line, m.col)
                              }
                              title="Replace this match"
                              className="rounded px-1 text-[10px] text-amber-300 opacity-0 hover:bg-amber-500/20 group-hover/match:opacity-100"
                            >
                              ↪
                            </button>
                          )}
                        </div>
                      ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ToggleBtn({
  on,
  onClick,
  title,
  children,
}: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded border px-1.5 py-0.5 ${
        on
          ? "border-[#0078d4] bg-[#0078d4]/20 text-[#75beff]"
          : "border-[#3a3a3a] text-[#858585] hover:bg-[#2a2a2a] hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
