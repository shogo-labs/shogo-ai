// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// GitKraken-style commit graph, rendered as a full main-area view. Three
// aligned columns (BRANCH/TAG rail, GRAPH, COMMIT MESSAGE) plus a right-hand
// commit detail panel. Data is the project workspace's real git history via
// the API; checkpoint metadata is overlaid so checkpoint commits offer
// rollback.

import {
  AlertTriangle,
  BookmarkPlus,
  GitBranch,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react-native";
import { Platform } from "react-native";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  useCheckpoints,
  useGitGraph,
  type GitCommitDetail,
} from "@shogo/shared-app/hooks";
import { API_URL } from "../../../../../lib/api";
import { authClient } from "../../../../../lib/auth-client";
import { CreateCheckpointModal } from "../../CheckpointModals";
import { buildDisplayRows } from "./displayRows";
import { BranchTagRail } from "./BranchTagRail";
import { CommitGraphCanvas } from "./CommitGraphCanvas";
import { CommitDetailPanel } from "./CommitDetailPanel";
import { relativeTime } from "./gitAvatar";
import { ROW_HEIGHT, type DisplayRow } from "./types";

type Selection = { kind: "wip" } | { kind: "commit"; sha: string } | null;

export function GraphView({
  projectId,
  onOpenFile,
}: {
  projectId: string;
  onOpenFile?: (path: string) => void;
}) {
  const credentials = Platform.OS === "web" ? "include" : undefined;
  const nativeHeaders = useMemo(() => {
    if (Platform.OS === "web") return undefined;
    return (): Record<string, string> => {
      const cookie = (authClient as any).getCookie?.();
      return cookie ? { Cookie: cookie } : {};
    };
  }, []);

  const graph = useGitGraph(projectId, { baseUrl: API_URL, credentials, headers: nativeHeaders });
  const {
    checkpoints,
    rollback,
    createCheckpoint,
    isMutating,
    disabledForExternalMode: checkpointsDisabled,
    refetch: refetchCheckpoints,
  } = useCheckpoints(projectId, {
    baseUrl: API_URL,
    credentials,
    headers: nativeHeaders,
  });

  const [selection, setSelection] = useState<Selection>(null);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<GitCommitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showCreate, setShowCreate] = useState(false);

  const checkpointBySha = useMemo(() => {
    const m = new Map<string, string>();
    for (const cp of checkpoints) m.set(cp.commitSha, cp.id);
    return m;
  }, [checkpoints]);

  // Build aligned display rows (+ a WIP row when the working tree is dirty).
  const { rows, maxLanes } = useMemo(() => {
    const checkpointShas = new Set(checkpointBySha.keys());
    return buildDisplayRows(graph.commits, graph.workingStatus, checkpointShas);
  }, [graph.commits, graph.workingStatus, checkpointBySha]);

  // Default selection: WIP if present, else the head commit.
  useEffect(() => {
    if (selection || rows.length === 0) return;
    const first = rows[0];
    setSelection(first.kind === "wip" ? { kind: "wip" } : { kind: "commit", sha: first.sha! });
  }, [rows, selection]);

  // Fetch detail for the selected commit.
  useEffect(() => {
    if (!selection || selection.kind !== "commit") {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    graph.getCommitDetail(selection.sha).then((d) => {
      if (cancelled) return;
      setDetail(d);
      setDetailLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [selection, graph.getCommitDetail]);

  const handleSelect = useCallback((sha: string | null) => {
    setSelection(sha == null ? { kind: "wip" } : { kind: "commit", sha });
  }, []);

  const handleRollback = useCallback(
    async (checkpointId: string) => {
      const ok = await rollback(checkpointId);
      if (ok) {
        graph.refetch();
        refetchCheckpoints();
      }
    },
    [rollback, graph, refetchCheckpoints],
  );

  const handleCreate = useCallback(
    async (opts: { message: string; name?: string; description?: string }) => {
      setShowCreate(false);
      const created = await createCheckpoint(opts);
      if (created) {
        graph.refetch();
        refetchCheckpoints();
      }
    },
    [createCheckpoint, graph, refetchCheckpoints],
  );

  const canCreate = !graph.disabledForExternalMode && !checkpointsDisabled;

  const lowerQuery = query.trim().toLowerCase();
  const matches = useCallback(
    (row: DisplayRow): boolean => {
      if (!lowerQuery) return true;
      if (row.kind === "wip") return false;
      const c = row.commit!;
      return (
        c.subject.toLowerCase().includes(lowerQuery) ||
        c.author.toLowerCase().includes(lowerQuery) ||
        c.shortSha.toLowerCase().includes(lowerQuery)
      );
    },
    [lowerQuery],
  );

  const selectedSha = selection?.kind === "commit" ? selection.sha : null;
  const selectedCheckpointId = selectedSha ? checkpointBySha.get(selectedSha) ?? null : null;

  return (
    <div className="flex h-full w-full min-h-0 bg-[color:var(--ide-bg)]">
      {/* Left: header + 3 aligned columns */}
      <div className="flex flex-1 min-w-0 flex-col border-r border-[color:var(--ide-border)]">
        <Header
          currentBranch={graph.currentBranch}
          commitCount={graph.commits.length}
          query={query}
          onQuery={setQuery}
          onRefresh={() => graph.refetch()}
          loading={graph.isLoading}
          canCreate={canCreate}
          onCreate={() => setShowCreate(true)}
        />

        {graph.disabledForExternalMode ? (
          <ExternalModeState />
        ) : graph.isLoading && graph.commits.length === 0 ? (
          <Centered>
            <Loader2 size={18} className="animate-spin" /> Loading commit graph…
          </Centered>
        ) : graph.error ? (
          <Centered>
            <AlertTriangle size={18} className="text-[color:var(--ide-error)]" /> {graph.error.message}
          </Centered>
        ) : graph.commits.length === 0 ? (
          <Centered>
            <GitBranch size={22} /> No commits yet.
          </Centered>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto">
            <div className="flex min-w-max">
              <BranchTagRail rows={rows} currentBranch={graph.currentBranch} />
              <CommitGraphCanvas
                rows={rows}
                maxLanes={maxLanes}
                selectedSha={selection?.kind === "wip" ? null : selectedSha}
                onSelect={handleSelect}
              />
              <MessageColumn
                rows={rows}
                selection={selection}
                matches={matches}
                hasQuery={!!lowerQuery}
                onSelect={(row) =>
                  setSelection(row.kind === "wip" ? { kind: "wip" } : { kind: "commit", sha: row.sha! })
                }
              />
            </div>
            {graph.hasMore && (
              <div className="px-4 py-3">
                <button
                  onClick={() => graph.loadMore()}
                  disabled={graph.isLoadingMore}
                  className="flex items-center gap-1.5 rounded-md border border-[color:var(--ide-border-strong)] px-3 py-1 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)] disabled:opacity-50"
                >
                  {graph.isLoadingMore && <Loader2 size={12} className="animate-spin" />}
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <CreateCheckpointModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        isMutating={isMutating}
      />

      {/* Right: detail panel */}
      <div className="shrink-0 w-[400px] min-w-[320px] bg-[color:var(--ide-surface)]">
        <CommitDetailPanel
          detail={detail}
          loading={detailLoading}
          isWip={selection?.kind === "wip"}
          workingStatus={graph.workingStatus}
          checkpointId={selectedCheckpointId}
          isRollingBack={isMutating}
          onRollback={handleRollback}
          onOpenFile={(p) => onOpenFile?.(p)}
          onViewChanges={() => {
            const ws = graph.workingStatus as
              | (typeof graph.workingStatus & { modified?: string[] })
              | null;
            const first =
              ws?.staged?.[0] ??
              ws?.unstaged?.[0] ??
              ws?.modified?.[0] ??
              ws?.untracked?.[0];
            if (first) onOpenFile?.(first);
          }}
        />
      </div>
    </div>
  );
}

function Header({
  currentBranch,
  commitCount,
  query,
  onQuery,
  onRefresh,
  loading,
  canCreate,
  onCreate,
}: {
  currentBranch: string | null;
  commitCount: number;
  query: string;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  loading: boolean;
  canCreate: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)]">
      <GitBranch size={13} className="text-[color:var(--ide-muted)]" />
      <span className="text-[12px] font-medium text-[color:var(--ide-text-strong)]">
        {currentBranch ?? "—"}
      </span>
      <span className="text-[11px] text-[color:var(--ide-muted)]">{commitCount} commits</span>
      <span className="flex-1" />
      <div className="flex items-center gap-1 rounded-md border border-[color:var(--ide-border-strong)] px-2 py-0.5">
        <Search size={12} className="text-[color:var(--ide-muted)]" />
        <input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Filter commits…"
          className="w-40 bg-transparent text-[12px] focus:outline-none placeholder-[color:var(--ide-muted)] text-[color:var(--ide-text-strong)]"
        />
      </div>
      {canCreate && (
        <button
          onClick={onCreate}
          title="Create checkpoint"
          className="flex items-center gap-1 rounded-md border border-[color:var(--ide-border-strong)] px-2 py-0.5 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
        >
          <BookmarkPlus size={12} className="text-[color:var(--ide-muted)]" />
          Checkpoint
        </button>
      )}
      <button
        onClick={onRefresh}
        title="Refresh"
        className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      </button>
    </div>
  );
}

function MessageColumn({
  rows,
  selection,
  matches,
  hasQuery,
  onSelect,
}: {
  rows: DisplayRow[];
  selection: Selection;
  matches: (row: DisplayRow) => boolean;
  hasQuery: boolean;
  onSelect: (row: DisplayRow) => void;
}) {
  return (
    <div className="flex-1 min-w-[280px]">
      {rows.map((row, i) => {
        const isSelected =
          (row.kind === "wip" && selection?.kind === "wip") ||
          (row.kind === "commit" && selection?.kind === "commit" && selection.sha === row.sha);
        const dim = hasQuery && !matches(row);
        return (
          <div
            key={row.sha ?? `wip-${i}`}
            onClick={() => onSelect(row)}
            className="flex items-center gap-2 px-3 cursor-pointer"
            style={{
              height: ROW_HEIGHT,
              background: isSelected ? "var(--ide-active-bg)" : undefined,
              opacity: dim ? 0.4 : 1,
            }}
          >
            {row.kind === "wip" ? (
              <>
                <span className="text-[12px] font-mono text-[color:var(--ide-muted)]">// WIP</span>
                {row.wipCount ? (
                  <span className="text-[10px] text-emerald-400">+{row.wipCount}</span>
                ) : null}
              </>
            ) : (
              <>
                <span className="text-[13px] text-[color:var(--ide-text-strong)] truncate">
                  {row.commit!.subject}
                </span>
                <span className="flex-1" />
                <span className="text-[11px] text-[color:var(--ide-muted)] whitespace-nowrap">
                  {relativeTime(row.commit!.date)}
                </span>
                <span className="text-[11px] font-mono text-[color:var(--ide-muted)] whitespace-nowrap">
                  {row.commit!.shortSha}
                </span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[color:var(--ide-muted)]">
      {children}
    </div>
  );
}

function ExternalModeState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center text-[color:var(--ide-muted)]">
      <GitBranch size={24} />
      <div className="text-[14px] font-semibold text-[color:var(--ide-text-strong)]">
        Graph is off in folder mode
      </div>
      <div className="text-[12px]">
        This project is linked to a folder on your machine. Use your own git client for history on
        local folders.
      </div>
    </div>
  );
}
