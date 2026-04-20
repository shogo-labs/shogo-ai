import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, X, CaseSensitive, Regex, Loader2, ChevronRight, ChevronDown } from "lucide-react";
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
  initialQuery,
}: {
  roots: Root[];
  services: Record<string, WorkspaceService>;
  /** Jump to (rootId, path, line, col) — open file + scroll editor to match. */
  onReveal: (rootId: string, path: string, line: number, col: number) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [running, setRunning] = useState(false);
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

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[#858585]">
        Search
      </div>

      {/* Query input */}
      <div className="px-3 pb-1">
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

        <div className="mt-1.5 flex items-center gap-1">
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
                  <div key={key} className="select-none">
                    <button
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [key]: !c[key] }))
                      }
                      className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] hover:bg-[#2a2a2a]"
                    >
                      {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      <span className="truncate text-[#cccccc]">
                        {file.path.split("/").pop()}
                      </span>
                      <span className="truncate text-[11px] text-[#858585]">
                        {file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ""}
                      </span>
                      <span className="ml-auto rounded bg-[#2a2a2a] px-1.5 text-[10px] text-[#858585]">
                        {file.matches.length}
                      </span>
                    </button>
                    {!hidden &&
                      file.matches.map((m, i) => (
                        <button
                          key={`${key}-${i}`}
                          onClick={() => onReveal(rr.rootId, file.path, m.line, m.col)}
                          className="flex w-full items-baseline gap-2 px-6 py-[2px] text-left font-mono text-[11px] hover:bg-[#2a2a2a]"
                          title={`${file.path}:${m.line}:${m.col}`}
                        >
                          <span className="w-10 shrink-0 text-right text-[#666]">{m.line}</span>
                          <span className="truncate text-[#d4d4d4]">{highlight(m.preview)}</span>
                        </button>
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
