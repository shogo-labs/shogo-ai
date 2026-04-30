import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Search, X, CaseSensitive, Regex, Loader2, ChevronRight, ChevronDown,
  Replace, ArrowRight, AlertTriangle,
} from "lucide-react-native";
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
  onReplaced,
  initialQuery,
}: {
  roots: Root[];
  services: Record<string, WorkspaceService>;
  /** Jump to (rootId, path, line, col) — open file + scroll editor to match. */
  onReveal: (rootId: string, path: string, line: number, col: number) => void;
  /** Optional toast hook fired after replacements complete. */
  onReplaced?: (matchCount: number, fileCount: number) => void;
  initialQuery?: string;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  const [replacement, setReplacement] = useState("");
  const [showReplace, setShowReplace] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [running, setRunning] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
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

  /**
   * Validate the regex client-side so we can disable Replace and surface a
   * clear inline error instead of silently throwing inside the replace
   * helpers. Only applies when useRegex is on — non-regex queries are always
   * valid because we escape them before constructing the RegExp.
   *
   * Note: the search side (svc.search) may interpret regex differently from
   * the JS engine. If the JS engine rejects what the backend accepted, we
   * tell the user explicitly rather than failing silently. Resolves #6, #7.
   */
  const regexError = useMemo<string | null>(() => {
    if (!useRegex || !query) return null;
    try {
      // eslint-disable-next-line no-new
      new RegExp(query, caseSensitive ? "g" : "gi");
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid regex";
    }
  }, [useRegex, query, caseSensitive]);

  /** Replace just the match at (line, col). Other matches stay intact. */
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
        const lineStr = lines[idx];
        re.lastIndex = Math.max(0, col - 1);
        const m = re.exec(lineStr);
        if (!m) return;
        const before = lineStr.slice(0, m.index);
        const after = lineStr.slice(m.index + m[0].length);
        const replaced = lineStr
          .slice(m.index, m.index + m[0].length)
          .replace(re, replacement);
        lines[idx] = before + replaced + after;
        await svc.writeFile(path, lines.join("\n"));
        onReplaced?.(1, 1);
        // Re-run search so the UI reflects the new state
        void runSearch();
      } catch (err) {
        console.error("[search] replaceSingleMatch failed", err);
      }
    },
    [services, query, replacement, buildReplaceRegex, onReplaced, runSearch],
  );

  /** Replace every match in one file with a single write. */
  const replaceInFile = useCallback(
    async (rootId: string, path: string) => {
      const svc = services[rootId];
      if (!svc || !query) return;
      try {
        const file = await svc.readFile(path);
        const re = buildReplaceRegex();
        const next = file.content.replace(re, replacement);
        if (next === file.content) return;
        // Count matches for the toast
        const re2 = buildReplaceRegex();
        const count = (file.content.match(re2) ?? []).length;
        await svc.writeFile(path, next);
        onReplaced?.(count, 1);
        void runSearch();
      } catch (err) {
        console.error("[search] replaceInFile failed", err);
      }
    },
    [services, query, replacement, buildReplaceRegex, onReplaced, runSearch],
  );

  /** Replace across every matching file. Confirms before doing the write. */
  const replaceAll = useCallback(async () => {
    if (!query || replacing) return;
    setConfirmOpen(false);
    setReplacing(true);
    let totalMatchCount = 0;
    let fileCount = 0;
    try {
      // Bounded parallelism: chunk per-file work so a 50-file replace runs
      // concurrently rather than serially. CHUNK kept conservative because
      // the underlying writeFile path retries on 429s — we don't want to
      // amplify that. Resolves issue #3 from the PR review.
      const CHUNK = 6;
      const tasks: { svc: import("./workspace/types").WorkspaceService; path: string }[] = [];
      for (const rr of rootResults) {
        const svc = services[rr.rootId];
        if (!svc) continue;
        for (const file of rr.results) tasks.push({ svc, path: file.path });
      }
      for (let i = 0; i < tasks.length; i += CHUNK) {
        const slice = tasks.slice(i, i + CHUNK);
        const results = await Promise.all(
          slice.map(async ({ svc, path }) => {
            try {
              const f = await svc.readFile(path);
              const re = buildReplaceRegex();
              const next = f.content.replace(re, replacement);
              if (next === f.content) return { changed: false, matches: 0 };
              const re2 = buildReplaceRegex();
              const matches = (f.content.match(re2) ?? []).length;
              await svc.writeFile(path, next);
              return { changed: true, matches };
            } catch (err) {
              console.error("[search] replaceAll: file failed", path, err);
              return { changed: false, matches: 0 };
            }
          }),
        );
        for (const r of results) {
          if (r.changed) {
            totalMatchCount += r.matches;
            fileCount += 1;
          }
        }
      }
      if (fileCount > 0) onReplaced?.(totalMatchCount, fileCount);
      void runSearch();
    } finally {
      setReplacing(false);
    }
  }, [query, replacing, rootResults, services, replacement, buildReplaceRegex, onReplaced, runSearch]);

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
          <span key={`${m.index}-${i}`} className="bg-[color:var(--ide-highlight-bg)] text-[color:var(--ide-highlight-text)]">
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

  const canReplace = query.length > 0 && totalMatches > 0 && !replacing && !regexError;

  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
        Search
      </div>

      {/* Query + replace inputs */}
      <div className="px-3 pb-1">
        <div className="flex items-start gap-1">
          <button
            onClick={() => setShowReplace((v) => !v)}
            title={showReplace ? "Hide replace" : "Toggle Replace"}
            className="mt-1.5 rounded p-0.5 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
          >
            {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <div className="flex-1 space-y-1">
            <div className="relative flex items-center rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-input-bg)] focus-within:border-[color:var(--ide-active-ring)]">
              <Search size={14} className="ml-2 mr-1 shrink-0 text-[color:var(--ide-muted)]" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void runSearch();
                  if (e.key === "Escape") setQuery("");
                }}
                placeholder="Search across all workspaces"
                className="no-focus-ring min-w-0 flex-1 bg-transparent pl-1 pr-2 py-1.5 text-[12px] text-[color:var(--ide-text-strong)] placeholder:text-[color:var(--ide-muted-strong)] outline-none"
              />
              {query && (
                <button
                  onClick={() => setQuery("")}
                  className="mr-1 rounded p-0.5 text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover-subtle)] hover:text-[color:var(--ide-text-strong)]"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            {regexError && (
              <div className="px-1 text-[10px] text-red-500" title={regexError}>
                Invalid regex: {regexError}
              </div>
            )}
            {showReplace && (
              <div className="relative flex items-center rounded border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-input-bg)] focus-within:border-[color:var(--ide-active-ring)]">
                <Replace size={14} className="ml-2 mr-1 shrink-0 text-[color:var(--ide-muted)]" />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canReplace) setConfirmOpen(true);
                  }}
                  placeholder={useRegex ? "Replace (use $1, $2 for groups)" : "Replace"}
                  className="no-focus-ring min-w-0 flex-1 bg-transparent pl-1 pr-2 py-1.5 text-[12px] text-[color:var(--ide-text-strong)] placeholder:text-[color:var(--ide-muted-strong)] outline-none"
                />
                <button
                  disabled={!canReplace}
                  onClick={() => setConfirmOpen(true)}
                  title="Replace all (with confirmation)"
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
          <div className="ml-auto flex items-center gap-2 text-[10px] text-[color:var(--ide-muted)]">
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
          <div className="px-4 py-6 text-center text-[11px] text-[color:var(--ide-muted-strong)]">
            Type to search across{" "}
            <span className="text-[color:var(--ide-text)]">
              {roots.length} workspace{roots.length === 1 ? "" : "s"}
            </span>
            .
            <div className="mt-2 text-[10px]">⌘⇧F from anywhere</div>
            {showReplace && (
              <div className="mt-2 text-[10px] text-[color:var(--ide-muted)]">
                Replacements write directly to disk after a confirmation prompt.
              </div>
            )}
          </div>
        )}

        {query && !running && rootResults.every((r) => r.results.length === 0 && !r.error) && (
          <div className="px-4 py-6 text-center text-[11px] text-[color:var(--ide-muted-strong)]">No results</div>
        )}

        {rootResults.map((rr) => {
          if (rr.results.length === 0 && !rr.error) return null;
          const multi = roots.length > 1;
          return (
            <div key={rr.rootId} className="mb-1">
              {multi && (
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--ide-muted)]">
                  {rr.rootLabel}
                  {rr.truncated && <span className="ml-2 text-[color:var(--ide-warning)]">(truncated)</span>}
                </div>
              )}
              {rr.error && (
                <div className="px-4 py-1 text-[11px] text-[color:var(--ide-error)]">{rr.error}</div>
              )}
              {rr.results.map((file) => {
                const key = `${rr.rootId}::${file.path}`;
                const hidden = collapsed[key];
                return (
                  <div key={key} className="select-none group">
                    <div className="flex w-full items-center gap-1 px-2 py-0.5 text-left text-[12px] hover:bg-[color:var(--ide-hover)]">
                      <button
                        onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
                        className="flex flex-1 items-center gap-1 truncate"
                      >
                        {hidden ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <span className="truncate text-[color:var(--ide-text)]">
                          {file.path.split("/").pop()}
                        </span>
                        <span className="truncate text-[11px] text-[color:var(--ide-muted)]">
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
                      <span className="ml-1 rounded bg-[color:var(--ide-border)] px-1.5 text-[10px] text-[color:var(--ide-muted)]">
                        {file.matches.length}
                      </span>
                    </div>
                    {!hidden &&
                      file.matches.map((m, i) => (
                        <div
                          key={`${key}-${i}`}
                          className="flex w-full items-baseline gap-2 px-6 py-[2px] text-left font-mono text-[11px] hover:bg-[color:var(--ide-hover)] group/match"
                        >
                          <button
                            onClick={() => onReveal(rr.rootId, file.path, m.line, m.col)}
                            title={`${file.path}:${m.line}:${m.col}`}
                            className="flex flex-1 items-baseline gap-2 truncate text-left"
                          >
                            <span className="w-10 shrink-0 text-right text-[color:var(--ide-muted-strong)]">{m.line}</span>
                            <span className="truncate text-[color:var(--ide-text)]">{highlight(m.preview)}</span>
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

      {/* Confirm dialog — light, no proposal layer (mobile is live-mirror) */}
      {confirmOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="max-w-sm w-full rounded-md border border-[color:var(--ide-border-strong)] bg-[color:var(--ide-input-bg)] p-4 shadow-xl">
            <div className="flex items-start gap-2 mb-3">
              <AlertTriangle size={18} className="shrink-0 text-amber-500" />
              <div className="text-sm text-[color:var(--ide-text-strong)] font-medium">
                Replace {totalMatches} match{totalMatches === 1 ? "" : "es"} in {totalFiles} file{totalFiles === 1 ? "" : "s"}?
              </div>
            </div>
            <div className="text-[12px] text-[color:var(--ide-muted)] mb-3 pl-7 space-y-1">
              <div>
                <span className="font-mono text-[color:var(--ide-text)]">{query || "—"}</span>{" "}
                <ArrowRight size={11} className="inline align-middle" />{" "}
                <span className="font-mono text-[color:var(--ide-text)]">{replacement || "(empty)"}</span>
              </div>
              <div className="text-[11px] text-[color:var(--ide-warning)]">
                This writes directly to disk. The agent's live-mirror will see the changes immediately.
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmOpen(false)}
                className="rounded px-3 py-1 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
              >
                Cancel
              </button>
              <button
                onClick={() => void replaceAll()}
                className="rounded bg-amber-600 px-3 py-1 text-[12px] font-medium text-white hover:bg-amber-500"
              >
                Replace
              </button>
            </div>
          </div>
        </div>
      )}
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
          ? "border-[color:var(--ide-active-ring)] bg-[color:var(--ide-active-ring)]/20 text-[color:var(--ide-accent-file-icon)]"
          : "border-[color:var(--ide-border-strong)] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
      }`}
    >
      {children}
    </button>
  );
}
