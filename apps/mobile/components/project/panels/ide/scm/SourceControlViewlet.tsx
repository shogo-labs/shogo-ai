// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Circle,
  CloudDownload,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  List,
  ListTree,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";

import { BranchPicker } from "../git/BranchPicker";
import { getDesktopGitBridge, type GitCommitHistoryItem } from "../git/bridge";
import { isCountedGitCode } from "../git/git-counting";
import { useGitStatusContext } from "../git/GitStatusContext";
import { ScmMenu } from "../git/ScmMenu";
import { StashList } from "../git/StashList";
import { ChangesList } from "./ChangesList";
import { CommitInput } from "./CommitInput";
import { useScmActions } from "./useScmActions";


const GRAPH_HEIGHT_KEY = "sourceControl.graphHeight";
const GRAPH_HEIGHT_DEFAULT = 250;
const GRAPH_HEIGHT_MIN = 120;
const GRAPH_HEIGHT_MAX_RATIO = 0.8;
const CHANGES_MIN_HEIGHT = 100;
const HISTORY_TIMEOUT_MS = 12_000;
const SYNC_CONFIRMATION_KEY = "shogo.scm.syncConfirmationDismissed";
const REMOTE_AUTO_FETCH_INTERVAL_MS = 180_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function remoteBranchLabel(upstream: string | null, branch: string | null): string {
  if (upstream) return upstream;
  return branch ? `origin/${branch}` : "origin";
}

function syncCountLabel(behind: number, ahead: number): string {
  const parts: string[] = [];
  if (behind > 0) parts.push(`${behind}↓`);
  if (ahead > 0) parts.push(`${ahead}↑`);
  return parts.join(" ");
}

function readSyncConfirmationDismissed(): boolean {
  try {
    return localStorage.getItem(SYNC_CONFIRMATION_KEY) === "true";
  } catch {
    return false;
  }
}

function dismissSyncConfirmation() {
  try {
    localStorage.setItem(SYNC_CONFIRMATION_KEY, "true");
  } catch {}
}

function useGraphSplitter() {
  const [graphHeight, setGraphHeight] = useState<number>(() => {
    try {
      const stored = localStorage.getItem(GRAPH_HEIGHT_KEY);
      if (stored) {
        const n = Number(stored);
        if (Number.isFinite(n) && n >= GRAPH_HEIGHT_MIN) return n;
      }
    } catch {}
    return GRAPH_HEIGHT_DEFAULT;
  });
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);

  useEffect(() => {
    try { localStorage.setItem(GRAPH_HEIGHT_KEY, String(graphHeight)); } catch {}
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
      const dy = startYRef.current - ev.clientY;
      const newH = Math.max(GRAPH_HEIGHT_MIN, Math.min(maxGraph, startHeightRef.current + dy));
      if (container) {
        const changesAvailable = container.clientHeight - newH - 4;
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
            <path d="M3 4.5L6 8L9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className="flex-1">{label}</span>
      <div className="opacity-0 group-hover/section:opacity-100 flex items-center gap-0.5">
        {actions}
      </div>
      {count !== undefined && (
        <span className={`ml-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums ${count > 0 ? "bg-[#2aa7df] text-white" : "text-[color:var(--ide-muted)]"}`}>{count}</span>
      )}
    </div>
  );
}

function GraphToolbar({
  onFetch,
  onPull,
  onPush,
  onRefresh,
  autoRefresh = true,
  onToggleAutoRefresh,
  focusBranch = false,
  onToggleFocusBranch,
}: {
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
  autoRefresh?: boolean;
  onToggleAutoRefresh?: () => void;
  focusBranch?: boolean;
  onToggleFocusBranch?: () => void;
}) {
  return (
    <div className="flex items-center h-[28px] px-2 border-t border-[color:var(--ide-border)] gap-0.5" style={{ minHeight: 28 }}>
      <SectionHeader label="GRAPH" />
      <span className="flex-1" />
      <button
        title={autoRefresh ? "Auto Refresh: On (click to disable)" : "Auto Refresh: Off (click to enable)"}
        onClick={onToggleAutoRefresh}
        className={`p-1 rounded text-[10px] hover:bg-[color:var(--ide-hover)] ${autoRefresh ? "text-[color:var(--ide-text-strong)]" : "text-[color:var(--ide-muted)]"}`}
      >
        Auto
      </button>
      <button
        title={focusBranch ? "Show All Branches" : "Focus Current Branch"}
        onClick={onToggleFocusBranch}
        className={`p-1 rounded hover:bg-[color:var(--ide-hover)] ${focusBranch ? "text-[color:var(--ide-primary)]" : "text-[color:var(--ide-muted)]"}`}
      >
        <Circle size={11} fill={focusBranch ? "currentColor" : "none"} />
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
      <div className="w-4 flex items-center justify-center shrink-0">
        {isMerge ? (
          <div className="w-2.5 h-2.5 rounded-full border-2 border-[color:var(--ide-primary)] bg-[color:var(--ide-bg)]" />
        ) : (
          <div className="w-2 h-2 rounded-full bg-[color:var(--ide-primary)]" />
        )}
      </div>
      <span className="flex-1 truncate text-[color:var(--ide-text-strong)] ml-1">
        {message}
      </span>
      {author && (
        <span className="text-[10px] text-[color:var(--ide-muted)] ml-2 shrink-0 max-w-[80px] truncate">{author}</span>
      )}
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
      {time && (
        <span className="text-[10px] text-[color:var(--ide-muted)] ml-2 shrink-0">{time}</span>
      )}
    </div>
  );
}

function SyncChangesButton({
  ahead,
  behind,
  disabled,
  busy,
  onClick,
}: {
  ahead: number;
  behind: number;
  disabled?: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  const countLabel = syncCountLabel(behind, ahead);
  if (!countLabel) return null;
  return (
    <div className="px-2 pb-2">
      <button
        onClick={onClick}
        disabled={disabled || busy}
        className="flex h-[34px] w-full items-center justify-center gap-2 rounded-[4px] bg-[#0078d4] text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-[#1a8ae8] disabled:cursor-not-allowed disabled:bg-[#254563] disabled:text-[color:var(--ide-muted)]"
      >
        <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        Sync Changes {countLabel}
      </button>
    </div>
  );
}

function SyncConfirmationModal({
  target,
  onConfirm,
  onConfirmDontShowAgain,
  onCancel,
}: {
  target: string;
  onConfirm: () => void;
  onConfirmDontShowAgain: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
      <div className="w-[280px] rounded-[28px] border border-white/20 bg-[#1f1f1f]/95 px-7 py-6 text-center shadow-2xl">
        <div className="mx-auto mb-5 flex h-[58px] w-[58px] items-center justify-center rounded-[18px] text-amber-300">
          <AlertTriangle size={54} strokeWidth={1.8} />
        </div>
        <div className="mb-6 text-[15px] font-semibold leading-snug text-white">
          This action will pull and push commits from and to "{target}".
        </div>
        <div className="space-y-2">
          <button
            onClick={onConfirm}
            className="h-[38px] w-full rounded-full bg-[#0a84ff] text-[14px] font-semibold text-white hover:bg-[#2492ff]"
          >
            OK
          </button>
          <button
            onClick={onConfirmDontShowAgain}
            className="h-[38px] w-full rounded-full bg-white/10 text-[13px] font-semibold text-white hover:bg-white/15"
          >
            OK, Don&apos;t Show Again
          </button>
          <button
            onClick={onCancel}
            className="h-[38px] w-full rounded-full bg-white/10 text-[13px] font-semibold text-white hover:bg-white/15"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}


export function SourceControlViewlet({
  workspaceRoot,
  projectName,
  fallback,
  onOpenDiff,
  onOpenFile,
  commits: providedCommits,
}: {
  workspaceRoot: string | null;
  projectName?: string;
  fallback?: React.ReactNode;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onOpenFile: (path: string) => void;
  commits?: GitCommitHistoryItem[];
}) {
  const { snapshot } = useGitStatusContext();
  const actions = useScmActions(workspaceRoot);
  const [remoteMenuOpen, setRemoteMenuOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [stashListOpen, setStashListOpen] = useState(false);
  const [changesGroupCollapsed, setChangesGroupCollapsed] = useState(false);
  const [mergeCollapsed, setMergeCollapsed] = useState(false);
  const [stagedCollapsed, setStagedCollapsed] = useState(false);
  const [changesCollapsed, setChangesCollapsed] = useState(false);
  const [graphCollapsed, setGraphCollapsed] = useState(false);
  const [viewMode, setViewMode] = useState<"list" | "tree">("list");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [focusBranch, setFocusBranch] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<GitCommitHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [syncConfirmOpen, setSyncConfirmOpen] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const { graphHeight, dragging, containerRef, onPointerDown } = useGraphSplitter();
  const commitInputRef = useRef<HTMLTextAreaElement>(null);
  const historyRequestIdRef = useRef(0);

  const refresh = useCallback(() => {
    void actions.refresh();
  }, [actions.refresh]);

  const loadHistory = useCallback(async () => {
    const requestId = historyRequestIdRef.current + 1;
    historyRequestIdRef.current = requestId;

    if (!workspaceRoot) {
      setHistoryCommits([]);
      setHistoryLoaded(false);
      setHistoryLoading(false);
      setHistoryError(null);
      return;
    }
    const git = getDesktopGitBridge();
    if (!git) {
      setHistoryCommits([]);
      setHistoryLoaded(true);
      setHistoryLoading(false);
      setHistoryError("Git history is only available in the desktop app.");
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await withTimeout(
        git.history(workspaceRoot, { limit: 100, allBranches: !focusBranch }),
        HISTORY_TIMEOUT_MS,
        "Git history",
      );
      if (historyRequestIdRef.current !== requestId) return;
      if (!res.ok) {
        setHistoryCommits([]);
        setHistoryError(res.error ?? res.reason ?? "Failed to load commit history");
        return;
      }
      setHistoryCommits(res.commits ?? []);
    } catch (err) {
      if (historyRequestIdRef.current !== requestId) return;
      setHistoryCommits([]);
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      if (historyRequestIdRef.current === requestId) {
        setHistoryLoaded(true);
        setHistoryLoading(false);
      }
    }
  }, [workspaceRoot, focusBranch]);

  const refreshGraph = useCallback(() => {
    refresh();
    void loadHistory();
  }, [refresh, loadHistory]);

  const performSync = useCallback(async () => {
    setSyncConfirmOpen(false);
    setSyncError(null);
    setSyncBusy(true);
    try {
      const res = await actions.syncRemote();
      if (!res.ok) {
        setSyncError(res.error ?? "Sync failed");
        return;
      }
      await actions.refresh();
      await loadHistory();
    } finally {
      setSyncBusy(false);
    }
  }, [actions.refresh, actions.syncRemote, loadHistory]);

  const requestSync = useCallback(() => {
    if (readSyncConfirmationDismissed()) {
      void performSync();
      return;
    }
    setSyncConfirmOpen(true);
  }, [performSync]);

  const confirmSyncAndDismiss = useCallback(() => {
    dismissSyncConfirmation();
    void performSync();
  }, [performSync]);

  useEffect(() => {
    if (!autoRefresh || !workspaceRoot) return;
    const id = setInterval(refreshGraph, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, workspaceRoot, refreshGraph]);

  useEffect(() => {
    if (!autoRefresh || !workspaceRoot || !snapshot?.isRepo || !snapshot.upstream) return;
    let cancelled = false;
    const fetchCounts = async () => {
      const res = await actions.fetchRemote();
      if (cancelled || !res.ok) return;
      await actions.refresh();
      await loadHistory();
    };
    void fetchCounts();
    const id = setInterval(() => { void fetchCounts(); }, REMOTE_AUTO_FETCH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [actions.fetchRemote, actions.refresh, autoRefresh, loadHistory, snapshot?.isRepo, snapshot?.upstream, workspaceRoot]);

  useEffect(() => {
    if (!workspaceRoot || !snapshot?.isRepo) {
      setHistoryCommits([]);
      setHistoryLoaded(false);
      setHistoryLoading(false);
      setHistoryError(null);
      return;
    }
    void loadHistory();
  }, [workspaceRoot, snapshot?.isRepo, loadHistory]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        const input = document.querySelector<HTMLInputElement>(".shogo-commit-input");
        if (input) { e.preventDefault(); input.focus(); input.select(); }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

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

  const conflictPathSet = new Set(snapshot.conflictPaths);
  const stagedPaths = Object.keys(snapshot.stagedStatus).filter((path) => !conflictPathSet.has(path));
  const stagedPathSet = new Set(stagedPaths);
  const unstagedPaths = Object.entries(snapshot.fileStatus)
    .filter(([path, code]) => !conflictPathSet.has(path) && !stagedPathSet.has(path) && isCountedGitCode(code))
    .map(([path]) => path);
  const conflictCount = snapshot.conflictPaths.length;
  const stagedCount = stagedPaths.length;
  const unstagedCount = unstagedPaths.length;
  const totalUnstagedPlusStaged = stagedCount + unstagedCount;
  const graphCommits = providedCommits ?? historyCommits;
  const graphLoading = providedCommits ? false : historyLoading || !historyLoaded;
  const graphError = providedCommits ? null : historyError;
  const syncTarget = remoteBranchLabel(snapshot.upstream, snapshot.branch);
  const hasSyncChanges = snapshot.ahead > 0 || snapshot.behind > 0;
  const syncDisabled = !hasSyncChanges || syncBusy || conflictCount > 0 || snapshot.detached;

  return (
    <div className="flex flex-col h-full text-[12px]">
      <div className="flex items-center h-[30px] px-3 text-[11px] uppercase tracking-[0.12em] text-[color:var(--ide-muted)] font-semibold" style={{ minHeight: 30 }}>
        <span className="flex-1">SOURCE CONTROL</span>
      </div>

      <SectionHeader
        label="CHANGES"
        collapsed={changesGroupCollapsed}
        onToggle={() => setChangesGroupCollapsed((v) => !v)}
        actions={
          <>
            <button
              title="Stage All Changes"
              onClick={() => {
                const paths = unstagedPaths;
                if (paths.length > 0) {
                  void (async () => {
                    await actions.stage(paths);
                    await actions.refresh();
                  })();
                }
              }}
              disabled={unstagedCount === 0}
              className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)] disabled:opacity-35 disabled:hover:bg-transparent"
            >
              <ArrowDownToLine size={14} />
            </button>
            <button
              title="Unstage All Changes"
              onClick={() => {
                const paths = stagedPaths;
                if (paths.length > 0) {
                  void (async () => {
                    await actions.unstage(paths);
                    await actions.refresh();
                  })();
                }
              }}
              disabled={stagedCount === 0}
              className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)] disabled:opacity-35 disabled:hover:bg-transparent"
            >
              <ArrowUpFromLine size={14} />
            </button>
            <button
              title={viewMode === "list" ? "Tree View" : "List View"}
              onClick={() => setViewMode((v) => v === "list" ? "tree" : "list")}
              className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
            >
              {viewMode === "list" ? <ListTree size={14} /> : <List size={14} />}
            </button>
            <button
              title="Commit"
              onClick={() => {
                const commitButton = document.querySelector<HTMLButtonElement>(".shogo-primary-commit-button");
                if (commitButton && !commitButton.disabled) {
                  commitButton.click();
                  return;
                }
                const input = document.querySelector<HTMLInputElement>(".shogo-commit-input");
                if (input) { input.focus(); input.select(); }
              }}
              className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
            >
              <Check size={15} />
            </button>
            <button title="Refresh" onClick={refresh} className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]">
              <RefreshCw size={14} />
            </button>
            <button
              title="More Actions..."
              onClick={() => setRemoteMenuOpen((v) => !v)}
              className="p-1 rounded-[3px] text-[color:var(--ide-muted)] hover:bg-[color:var(--ide-hover)] hover:text-[color:var(--ide-text-strong)]"
            >
              <MoreHorizontal size={14} />
            </button>
          </>
        }
      />

      {!changesGroupCollapsed && (
        <CommitInput
        stagedCount={stagedCount}
        committableCount={totalUnstagedPlusStaged}
        branch={snapshot.detached ? "HEAD" : snapshot.branch}
        disabled={conflictCount > 0}
        disabledReason={conflictCount > 0 ? `Resolve ${conflictCount} merge conflict${conflictCount === 1 ? "" : "s"} before committing.` : undefined}
        onCommit={async (message, opts) => {
          const r = await actions.commitAll(message, opts);
          if (!r.ok) return { ok: false, error: r.error };
          await actions.refresh();
          await loadHistory();
          return { ok: true };
        }}
        onCommitAndPush={async (message, opts) => {
          const committed = await actions.commitAll(message, opts);
          if (!committed.ok) return { ok: false, error: committed.error };
          const pushed = await actions.pushRemote();
          await actions.refresh();
          await loadHistory();
          return { ok: pushed.ok, error: pushed.ok ? undefined : pushed.error };
        }}
        onCommitAndSync={async (message, opts) => {
          const committed = await actions.commitAll(message, opts);
          if (!committed.ok) return { ok: false, error: committed.error };
          const synced = await actions.syncRemote();
          await actions.refresh();
          await loadHistory();
          return { ok: synced.ok, error: synced.ok ? undefined : synced.error };
        }}
        />
      )}

      {!changesGroupCollapsed && hasSyncChanges && (
        <>
          <SyncChangesButton
            ahead={snapshot.ahead}
            behind={snapshot.behind}
            busy={syncBusy}
            disabled={syncDisabled}
            onClick={requestSync}
          />
          {syncError && (
            <div className="mx-2 mb-2 rounded bg-rose-500/10 border border-rose-500/30 px-2 py-1 text-[10px] text-rose-300 whitespace-pre-wrap">
              {syncError}
            </div>
          )}
        </>
      )}

      {remoteMenuOpen && workspaceRoot && (
        <ScmMenu
          workspaceRoot={workspaceRoot}
          onClose={() => setRemoteMenuOpen(false)}
          onAfterAction={refresh}
          onOpenBranchPicker={() => { setRemoteMenuOpen(false); setBranchPickerOpen(true); }}
          onOpenStashList={() => { setRemoteMenuOpen(false); setStashListOpen(true); }}
        />
      )}


      {!changesGroupCollapsed && (
      <div ref={containerRef} className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 overflow-auto" style={{ minHeight: CHANGES_MIN_HEIGHT }}>
        {conflictCount > 0 && (
          <>
            <SectionHeader
              label="Merge Changes"
              count={conflictCount}
              collapsed={mergeCollapsed}
              onToggle={() => setMergeCollapsed((v) => !v)}
              actions={
                <button
                  title="Refresh"
                  onClick={refresh}
                  className="p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
                >
                  <RefreshCw size={11} />
                </button>
              }
            />
            {!mergeCollapsed && (
              <ChangesList
                snapshot={snapshot}
                section="merge"
                viewMode={viewMode}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                onStage={(paths) => { void actions.stage(paths); }}
                onUnstage={(paths) => { void actions.unstage(paths); }}
                onDiscard={(paths) => { void actions.discard(paths); }}
              />
            )}
          </>
        )}

        {stagedCount > 0 && (
          <>
            <SectionHeader
              label="Staged Changes"
              count={stagedCount}
              collapsed={stagedCollapsed}
              onToggle={() => setStagedCollapsed((v) => !v)}
              actions={
                <button
                  title="Discard All Staged"
                  onClick={() => {
                    const paths = stagedPaths;
                    if (paths.length > 0) {
                      if (window.confirm(`Discard ${paths.length} staged change(s)? This cannot be undone.`)) {
                        void actions.discard(paths);
                      }
                    }
                  }}
                  className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
                >
                  <svg width={11} height={11} viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M2.5 8.5L8.5 2.5M2.5 2.5L8.5 8.5" /></svg>
                </button>
              }
            />
            {!stagedCollapsed && (
              <ChangesList
                snapshot={snapshot}
                section="staged"
                viewMode={viewMode}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                onStage={(paths) => { void actions.stage(paths); }}
                onUnstage={(paths) => { void actions.unstage(paths); }}
                onDiscard={(paths) => { void actions.discard(paths); }}
              />
            )}
          </>
        )}

        {unstagedCount > 0 && (
          <>
            <SectionHeader
              label="Changes"
              count={unstagedCount}
              collapsed={changesCollapsed}
              onToggle={() => setChangesCollapsed((v) => !v)}
              actions={
                <>
                  <button
                    title="Stage All"
                    onClick={() => {
                      const paths = unstagedPaths;
                      if (paths.length > 0) void actions.stage(paths);
                    }}
                    className="p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
                  >
                    <svg width={11} height={11} viewBox="0 0 11 11" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="5.5" y1="2" x2="5.5" y2="9" /><line x1="2" y1="5.5" x2="9" y2="5.5" /></svg>
                  </button>
                  <button
                    title="Discard All"
                    onClick={() => {
                      const paths = unstagedPaths;
                      if (paths.length > 0) {
                        if (window.confirm(`Discard ${paths.length} unstaged change(s)? This cannot be undone.`)) {
                          void actions.discard(paths);
                        }
                      }
                    }}
                    className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
                  >
                    <RefreshCw size={11} />
                  </button>
                </>
              }
            />
            {!changesCollapsed && (
              <ChangesList
                snapshot={snapshot}
                section="changes"
                viewMode={viewMode}
                onOpenDiff={onOpenDiff}
                onOpenFile={onOpenFile}
                onStage={(paths) => { void actions.stage(paths); }}
                onUnstage={(paths) => { void actions.unstage(paths); }}
                onDiscard={(paths) => { void actions.discard(paths); }}
              />
            )}
          </>
        )}

            </div>

            <div
              onPointerDown={onPointerDown}
              className="group/splitter relative flex items-center justify-center shrink-0"
              style={{ height: 5, cursor: "ns-resize" }}
            >
              <div className="absolute inset-x-0 -top-1 -bottom-1" />
              <div
                className={`w-full h-px transition-colors ${
                  dragging
                    ? "bg-[color:var(--ide-primary)]"
                    : "bg-[color:var(--ide-border)] group-hover/splitter:bg-[color:var(--ide-muted)]"
                }`}
              />
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

            <div style={{ height: graphHeight, minHeight: GRAPH_HEIGHT_MIN }} className="flex flex-col shrink-0 overflow-hidden">
              <GraphToolbar
                onFetch={async () => { await actions.fetchRemote(); await actions.refresh(); await loadHistory(); }}
                onPull={async () => { await actions.pullRemote(); await actions.refresh(); await loadHistory(); }}
                onPush={async () => { await actions.pushRemote(); await actions.refresh(); await loadHistory(); }}
                onRefresh={refreshGraph}
                autoRefresh={autoRefresh}
                onToggleAutoRefresh={() => setAutoRefresh((v) => !v)}
                focusBranch={focusBranch}
                onToggleFocusBranch={() => setFocusBranch((v) => !v)}
              />
              {!graphCollapsed && (
                <div className="flex-1 overflow-auto divide-y divide-[color:var(--ide-border)]/50">
                  {graphCommits.length > 0 ? (
                    graphCommits.map((c) => (
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
                      {graphError ? graphError : graphLoading ? "Loading commit history..." : "No commits yet."}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
      )}

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
      {syncConfirmOpen && (
        <SyncConfirmationModal
          target={syncTarget}
          onConfirm={() => { void performSync(); }}
          onConfirmDontShowAgain={confirmSyncAndDismiss}
          onCancel={() => setSyncConfirmOpen(false)}
        />
      )}
    </div>
  );
}
