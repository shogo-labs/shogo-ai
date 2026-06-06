// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// VS Code-style Source Control viewlet. Layout:
//
// ┌──────────────────────────────────────────┐
// │ SOURCE CONTROL                    ...     │ ← section header
// ├──────────────────────────────────────────┤
// │ repository-name          ↻  (⋯)          │ ← repo header (36px)
// │ main  origin/main  ↑26 ↓3                │ ← branch row
// ├──────────────────────────────────────────┤
// │ Message (⌘Enter to commit...)    ✨      │ ← commit input (32px)
// │ ✓ Commit               ▼                 │ ← commit button (36px)
// ├──────────────────────────────────────────┤
// │ ▼ Staged Changes               1         │ ← section header
// │   file.ts  dir/               2, M       │ ← file row (22px)
// ├──────────────────────────────────────────┤
// │ ▼ Changes                        2       │
// │   file.ts  dir/               3, M       │
// ├──────────────────────────────────────────┤
// │ ▼ GRAPH  ⊕ Auto  ⊙  ↓↓ ↑↑ ↻  (⋯)      │ ← graph toolbar
// │ ● commit message                         │ ← graph rows (22px)
// │ ● commit message                         │
// └──────────────────────────────────────────┘

import {
  GitBranch,
  GitCommitHorizontal,
  MoreHorizontal,
  RefreshCw,
  CloudDownload,
  CloudUpload,
  ArrowDownToLine,
  ArrowUpFromLine,
  Globe,
  Circle,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BranchPicker } from "../git/BranchPicker";
import { useGitStatusContext } from "../git/GitStatusContext";
import { ScmMenu } from "../git/ScmMenu";
import { StashList } from "../git/StashList";
import { ChangesList } from "./ChangesList";
import { CommitInput } from "./CommitInput";
import { useScmActions } from "./useScmActions";


/** localStorage key for persisting graph splitter position. */
const GRAPH_HEIGHT_KEY = "sourceControl.graphHeight";
const GRAPH_HEIGHT_DEFAULT = 250;
const GRAPH_HEIGHT_MIN = 120;
const GRAPH_HEIGHT_MAX_RATIO = 0.8;
const CHANGES_MIN_HEIGHT = 100;

/**
 * Hook that manages the draggable splitter between Changes and Graph sections.
 * Persists the graph height in localStorage, matching VS Code's behavior.
 */
function useGraphSplitter() {
  const [graphHeight, setGraphHeight] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(GRAPH_HEIGHT_KEY);
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n >= GRAPH_HEIGHT_MIN) return n;
      }
    } catch { /* SSR / private browsing */ }
    return GRAPH_HEIGHT_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  // Persist on change
  useEffect(() => {
    try { localStorage.setItem(GRAPH_HEIGHT_KEY, String(graphHeight)); } catch { /* noop */ }
  }, [graphHeight]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    startYRef.current = e.clientY;
    startHeightRef.current = graphHeight;
    setDragging(true);

    const container = containerRef.current;
    const maxGraph = container
      ? Math.floor(container.clientHeight * GRAPH_HEIGHT_MAX_RATIO)
      : 800;

    const onMove = (ev: PointerEvent) => {
      const dy = startYRef.current - ev.clientY; // up = positive = grow graph
      const newH = Math.max(GRAPH_HEIGHT_MIN, Math.min(maxGraph, startHeightRef.current + dy));
      // Also ensure Changes min height
      if (container) {
        const changesAvailable = container.clientHeight - newH - 4; // 4 = splitter
        if (changesAvailable < CHANGES_MIN_HEIGHT) {
          setGraphHeight(container.clientHeight - CHANGES_MIN_HEIGHT - 4);
          return;
        }
      }
      setGraphHeight(newH);
    };

    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }, [graphHeight]);

  return { graphHeight, dragging, containerRef, onPointerDown };
}

/**
 * VS Code-style section header. Uppercase, 11px, collapsible.
 */
function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  actions,
}: {
  label: string;
  count?: number;
  collapsed?: boolean;
  onToggle?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center h-[28px] px-2 text-[11px] font-semibold uppercase tracking-wider text-[color:var(--ide-text-strong)] hover:bg-[color:var(--ide-hover)] select-none group/section"
      style={{ minHeight: 28 }}
    >
      {onToggle && (
        <button onClick={onToggle} className="mr-1 p-0.5 rounded hover:bg-[color:var(--ide-surface)]">
          <svg width={12} height={12} viewBox="0 0 12 12" className={`text-[color:var(--ide-muted)] transition-transform ${collapsed ? "-rotate-90" : ""}`}>
            <path d="M4.5 3L8 6L4.5 9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="text-[11px] text-[color:var(--ide-muted)] tabular-nums mr-1">{count}</span>
      )}
      <div className="opacity-0 group-hover/section:opacity-100 flex items-center gap-0.5">
        {actions}
      </div>
    </div>
  );
}

/**
 * VS Code-style repository header (36px).
 */
function RepoHeader({
  branch,
  upstream,
  ahead,
  behind,
  detached,
  onRefresh,
  onBranchPicker,
  onMenuToggle,
}: {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  onRefresh: () => void;
  onBranchPicker: () => void;
  onMenuToggle: () => void;
}) {
  return (
    <div className="flex items-center h-[36px] px-3 border-b border-[color:var(--ide-border)]" style={{ minHeight: 36 }}>
      {/* Branch name + upstream */}
      <button
        onClick={onBranchPicker}
        title="Change branch"
        className="flex items-center gap-1.5 -mx-1 px-1 py-0.5 rounded text-left hover:bg-[color:var(--ide-hover)]"
      >
        <span className="text-[13px] font-medium text-[color:var(--ide-text-strong)]">
          {detached ? "HEAD detached" : branch ?? "—"}
        </span>
      </button>
      {upstream && (
        <span className="text-[11px] text-[color:var(--ide-muted)] ml-1.5 truncate max-w-[120px]" title={`Tracking ${upstream}`}>
          {upstream}
        </span>
      )}
      {ahead > 0 && (
        <span className="text-[10px] ml-1.5 text-emerald-400" title={`${ahead} ahead`}>↑{ahead}</span>
      )}
      {behind > 0 && (
        <span className="text-[10px] ml-1 text-amber-400" title={`${behind} behind`}>↓{behind}</span>
      )}
      <span className="flex-1" />
      <button
        title="Sync Changes (Fetch + Pull + Push)"
        onClick={onRefresh}
        className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
      >
        <RefreshCw size={13} />
      </button>
      <button
        title="More Actions..."
        onClick={onMenuToggle}
        className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
      >
        <MoreHorizontal size={13} />
      </button>
    </div>
  );
}

/**
 * VS Code-style graph toolbar (28px, sticky).
 */
function GraphToolbar({
  onFetch,
  onPull,
  onPush,
  onRefresh,
}: {
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="flex items-center h-[28px] px-2 border-t border-[color:var(--ide-border)] gap-0.5" style={{ minHeight: 28 }}>
      <SectionHeader label="GRAPH" />
      <span className="flex-1" />
      <button title="Auto" className="p-1 rounded text-[10px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        Auto
      </button>
      <button title="Focus Current Branch" className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        <Circle size={11} />
      </button>
      <button title="Fetch" onClick={onFetch} className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        <CloudDownload size={12} />
      </button>
      <button title="Pull" onClick={onPull} className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        <ArrowDownToLine size={12} />
      </button>
      <button title="Push" onClick={onPush} className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        <ArrowUpFromLine size={12} />
      </button>
      <button title="Refresh" onClick={onRefresh} className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
        <RefreshCw size={11} />
      </button>
    </div>
  );
}

/**
 * VS Code-style commit graph row (22px).
 */
function GraphRow({
  hash,
  message,
  author,
  time,
  isMerge,
  branchLabel,
  isRemote,
}: {
  hash: string;
  message: string;
  author?: string;
  time?: string;
  isMerge?: boolean;
  branchLabel?: string;
  isRemote?: boolean;
}) {
  return (
    <div className="flex items-center h-[22px] px-2 text-[12px] hover:bg-[color:var(--ide-hover)] cursor-pointer" style={{ minHeight: 22 }}>
      {/* Commit node */}
      <div className="w-4 flex items-center justify-center shrink-0">
        {isMerge ? (
          <div className="w-2.5 h-2.5 rounded-full border-2 border-[color:var(--ide-primary)] bg-[color:var(--ide-bg)]" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-[color:var(--ide-primary)]" />
        )}
      </div>
      {/* Commit message */}
      <span className="flex-1 truncate text-[color:var(--ide-text-strong)] ml-1">
        {message}
      </span>
      {/* Author */}
      {author && (
        <span className="text-[10px] text-[color:var(--ide-muted)] ml-2 shrink-0 max-w-[80px] truncate">{author}</span>
      )}
      {/* Branch label */}
      {branchLabel && (
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded-full ml-1.5 shrink-0 ${
            isRemote
              ? "bg-amber-500/20 text-amber-300 border border-amber-500/30"
              : "bg-sky-500/20 text-sky-300 border border-sky-500/30"
          }`}
        >
          {branchLabel}
        </span>
      )}
      {/* Time */}
      {time && (
        <span className="text-[10px] text-[color:var(--ide-muted)] ml-2 shrink-0">{time}</span>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Main SourceControlViewlet component
// ═══════════════════════════════════════════════════════════════════════

export function SourceControlViewlet({
  workspaceRoot,
  projectName,
  fallback,
  onOpenDiff,
  onOpenFile,
  commits,
}: {
  workspaceRoot: string | null;
  projectName?: string;
  fallback?: React.ReactNode;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onOpenFile: (path: string) => void;
  commits?: Array<{
    hash: string;
    message: string;
    author?: string;
    time?: string;
    isMerge?: boolean;
    branchLabel?: string;
    isRemote?: boolean;
  }>;
}) {
  const { snapshot } = useGitStatusContext();
  const actions = useScmActions(workspaceRoot);
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [stashListOpen, setStashListOpen] = useState(false);
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  const { graphHeight, dragging, containerRef, onPointerDown } = useGraphSplitter();

  const refresh = useCallback(() => {
    void actions.refresh();
  }, [actions]);

  // ── Empty state (no repo) ──
  if (!actions.available || !snapshot || !snapshot.isRepo) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 text-[11px] uppercase tracking-wider text-[color:var(--ide-muted)] font-semibold">
          Source Control
        </div>
        {fallback ?? (
          <div className="flex flex-col flex-1 items-center justify-center gap-2 px-6 text-center text-[color:var(--ide-muted)]">
            <GitBranch size={28} />
            <div className="text-[13px]">No git repository in this workspace.</div>
            <div className="text-[11px]">Open a folder containing a <code>.git</code> directory.</div>
          </div>
        )}
      </div>
    );
  }

  const stagedCount = Object.keys(snapshot.stagedStatus).length;
  const unstagedCount = Object.keys(snapshot.fileStatus).length - snapshot.conflictPaths.length - stagedCount;
  const totalUnstagedPlusStaged = Object.keys(snapshot.fileStatus).length - snapshot.conflictPaths.length;

  return (
    <div className="flex flex-col h-full text-[12px]">
      {/* ── SOURCE CONTROL header (28px) ── */}
      <div className="flex items-center h-[28px] px-3 text-[11px] uppercase tracking-wider text-[color:var(--ide-muted)] font-semibold" style={{ minHeight: 28 }}>
        <span className="flex-1">Source Control</span>
      </div>

      {/* ── Section actions row: View Mode + Refresh ── */}
      <div className="flex items-center h-[28px] px-2 border-b border-[color:var(--ide-border)]" style={{ minHeight: 28 }}>
        <button
          title="View Mode: List"
          className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]"
        >
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.2">
            <line x1="3" y1="4" x2="11" y2="4" /><line x1="3" y1="7" x2="11" y2="7" /><line x1="3" y1="10" x2="11" y2="10" />
          </svg>
        </button>
        <span className="flex-1" />
        <button title="Commit (⌘Enter)" className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <polyline points="3 7 6 10 11 4" />
          </svg>
        </button>
        <button title="Refresh" onClick={refresh} className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]">
          <RefreshCw size={13} />
        </button>
        <button
          title="More Actions..."
          onClick={() => setMenuOpen((v) => !v)}
          className="p-1 rounded text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)]"
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && workspaceRoot && (
          <ScmMenu
            workspaceRoot={workspaceRoot}
            onClose={() => setMenuOpen(false)}
            onAfterAction={refresh}
            onOpenBranchPicker={() => setBranchPickerOpen(true)}
            onOpenStashList={() => setStashListOpen(true)}
          />
        )}
      </div>

      {/* ── Commit input (32px textarea + 36px button) ── */}
      <CommitInput
        stagedCount={stagedCount}
        totalCount={totalUnstagedPlusStaged}
        onCommit={async (message, opts) => {
          const r = await actions.commit(message, opts);
          return { ok: r.ok, error: r.ok ? undefined : r.error };
        }}
        onCommitAll={async (message, opts) => {
          const r = await actions.commitAll(message, opts);
          return { ok: r.ok, error: r.ok ? undefined : r.error };
        }}
        onCommitAndPush={async (message, opts) => {
          const r = await actions.commitAndPush(message, opts);
          return { ok: r.ok, error: r.ok ? undefined : r.error };
        }}
        onCommitAndSync={async (message, opts) => {
          const r = await actions.commitAndSync(message, opts);
          return { ok: r.ok, error: r.ok ? undefined : r.error };
        }}
        onUndoLastCommit={async () => {
          const r = await actions.undoLastCommit();
          return { ok: r.ok, error: r.ok ? undefined : r.error };
        }}
        onGenerateMessage={actions.available ? async () => {
          const r = await actions.generateCommitMessage();
          return { ok: r.ok, message: r.ok ? r.message : undefined, error: r.ok ? undefined : r.error };
        } : undefined}
      />

      {/* ── Repository header (36px) ── */}
      <RepoHeader
        branch={snapshot.branch}
        upstream={snapshot.upstream}
        ahead={snapshot.ahead}
        behind={snapshot.behind}
        detached={snapshot.detached}
        onRefresh={refresh}
        onBranchPicker={() => setBranchPickerOpen(true)}
        onMenuToggle={() => setMenuOpen((v) => !v)}
      />

      {/* ── Resizable split: Changes (top) ←splitter→ Graph (bottom) ── */}
      <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
            {/* ── Top panel: Staged + Changes (scrollable) ── */}
            <div className="flex-1 overflow-auto" style={{ minHeight: CHANGES_MIN_HEIGHT }}>
              {/* Staged Changes section */}
        <SectionHeader
          label="Staged Changes"
          count={stagedCount}
          collapsed={stagedCollapsed}
          onToggle={() => setStagedCollapsed((v) => !v)}
          actions={
            stagedCount > 0 && (
              <>
                <button title="Discard All Staged" className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300">
                  <svg width={11} height={11} viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2.5 8.5L8.5 2.5M2.5 2.5L8.5 8.5" /></svg>
                </button>
              </>
            )
          }
        />
        {!stagedCollapsed && (
          <ChangesList
            snapshot={snapshot}
            section="staged"
            onOpenDiff={onOpenDiff}
            onOpenFile={onOpenFile}
            onStage={(paths) => { void actions.stage(paths); }}
            onUnstage={(paths) => { void actions.unstage(paths); }}
            onDiscard={(paths) => { void actions.discard(paths); }}
          />
        )}

        {/* Changes section */}
        <SectionHeader
          label="Changes"
          count={unstagedCount}
          collapsed={changesCollapsed}
          onToggle={() => setChangesCollapsed((v) => !v)}
          actions={
            unstagedCount > 0 && (
              <>
                <button title="Stage All" className="p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]">
                  <svg width={11} height={11} viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="5.5" y1="2" x2="5.5" y2="9" /><line x1="2" y1="5.5" x2="9" y2="5.5" /></svg>
                </button>
                <button title="Discard All" className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300">
                  <RefreshCw size={11} />
                </button>
              </>
            )
          }
        />
        {!changesCollapsed && (
          <ChangesList
            snapshot={snapshot}
            section="changes"
            onOpenDiff={onOpenDiff}
            onOpenFile={onOpenFile}
            onStage={(paths) => { void actions.stage(paths); }}
            onUnstage={(paths) => { void actions.unstage(paths); }}
            onDiscard={(paths) => { void actions.discard(paths); }}
          />
        )}

            </div>

            {/* ── Splitter handle ── */}
            <div
              onPointerDown={onPointerDown}
              className="group/splitter relative flex items-center justify-center shrink-0"
              style={{ height: 5, cursor: "ns-resize" }}
            >
              {/* Invisible wider hit area */}
              <div className="absolute inset-x-0 -top-1 -bottom-1" />
              {/* Visible line */}
              <div
                className={`w-full h-px transition-colors ${
                  dragging
                    ? "bg-[color:var(--ide-primary)]"
                    : "bg-[color:var(--ide-border)] group-hover/splitter:bg-[color:var(--ide-muted)]"
                }`}
              />
              {/* Center grip dots (visible on hover / drag) */}
              <div
                className={`absolute flex gap-0.5 transition-opacity ${
                  dragging ? "opacity-100" : "opacity-0 group-hover/splitter:opacity-100"
                }`}
              >
                <div className="w-1 h-1 rounded-full bg-[color:var(--ide-muted)]" />
                <div className="w-1 h-1 rounded-full bg-[color:var(--ide-muted)]" />
                <div className="w-1 h-1 rounded-full bg-[color:var(--ide-muted)]" />
              </div>
            </div>

            {/* ── Bottom panel: Graph (fixed height, scrollable) ── */}
            <div style={{ height: graphHeight, minHeight: GRAPH_HEIGHT_MIN }} className="flex flex-col shrink-0 overflow-hidden">
              <GraphToolbar
                onFetch={() => { void actions.refresh(); }}
                onPull={() => { void actions.refresh(); }}
                onPush={() => { void actions.refresh(); }}
                onRefresh={refresh}
              />
              {!graphCollapsed && (
                <div className="flex-1 overflow-auto divide-y divide-[color:var(--ide-border)]/50">
                  {commits && commits.length > 0 ? (
                    commits.map((c) => (
                      <GraphRow
                        key={c.hash}
                        hash={c.hash}
                        message={c.message}
                        author={c.author}
                        time={c.time}
                        isMerge={c.isMerge}
                        branchLabel={c.branchLabel}
                        isRemote={c.isRemote}
                      />
                    ))
                  ) : (
                    <div className="px-4 py-6 text-center text-[11px] text-[color:var(--ide-muted)]">
                      <GitCommitHorizontal size={20} className="mx-auto mb-1 opacity-40" />
                      Loading commit history...
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

      {/* ── Modals ── */}
      {branchPickerOpen && workspaceRoot && (
        <BranchPicker
          workspaceRoot={workspaceRoot}
          currentBranch={snapshot.branch}
          onClose={() => setBranchPickerOpen(false)}
          onChanged={refresh}
        />
      )}
      {stashListOpen && workspaceRoot && (
        <StashList
          workspaceRoot={workspaceRoot}
          onClose={() => setStashListOpen(false)}
          onAfterAction={refresh}
        />
      )}
    </div>
  );
}
