// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Checkpoint-only list view for managed projects.
// Unlike GraphView (which shows the full git commit graph + checkpoints),
// this component displays only Shogo checkpoints — save points that can be
// created and rolled back. No git branches, no commit history.

import {
  BookmarkPlus,
  Clock,
  GitCommitHorizontal,
  Loader2,
  RotateCcw,
  Tag,
  Undo2,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";

import {
  useCheckpoints,
  type Checkpoint,
} from "@shogo/shared-app/hooks";
import { API_URL } from "../../../../lib/api";
import { authClient } from "../../../../lib/auth-client";
import { CreateCheckpointModal, RollbackConfirmModal } from "../CheckpointModals";

export function CheckpointListView({ projectId }: { projectId: string }) {
  const nativeHeaders = useMemo(() => {
    if (typeof window !== "undefined") return undefined;
    return (): Record<string, string> => {
      const cookie = (authClient as any).getCookie?.();
      return cookie ? { Cookie: cookie } : {};
    };
  }, []);

  const {
    checkpoints,
    rollback,
    createCheckpoint,
    isMutating,
    isLoading,
    error,
  } = useCheckpoints(projectId, {
    baseUrl: API_URL,
    headers: nativeHeaders,
  });

  const [showCreate, setShowCreate] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<Checkpoint | null>(null);

  const handleCreate = useCallback(
    async (opts: { message: string; name?: string; description?: string }) => {
      setShowCreate(false);
      await createCheckpoint(opts);
    },
    [createCheckpoint],
  );

  const handleRollback = useCallback(
    async (checkpointId: string) => {
      setRollbackTarget(null);
      await rollback(checkpointId);
    },
    [rollback],
  );

  const sortedCheckpoints = useMemo(
    () => [...checkpoints].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [checkpoints],
  );

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[color:var(--ide-muted)]">
        <Loader2 size={16} className="animate-spin" /> Loading checkpoints…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[color:var(--ide-error)]">
        {error.message}
      </div>
    );
  }

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-[color:var(--ide-bg)]">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)]">
        <BookmarkPlus size={13} className="text-[color:var(--ide-muted)]" />
        <span className="text-[12px] font-medium text-[color:var(--ide-text-strong)]">
          Checkpoints
        </span>
        <span className="text-[11px] text-[color:var(--ide-muted)]">
          {sortedCheckpoints.length}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1.5 rounded-md border border-[color:var(--ide-border-strong)] px-2.5 py-1 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
        >
          <BookmarkPlus size={11} /> Checkpoint
        </button>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-auto">
        {sortedCheckpoints.length === 0 ? (
          <div className="flex flex-1 items-center justify-center h-full">
            <div className="flex flex-col items-center gap-2 text-[color:var(--ide-muted)]">
              <BookmarkPlus size={24} />
              <span className="text-[13px]">No checkpoints yet</span>
              <span className="text-[11px]">Create a checkpoint to save the current state</span>
            </div>
          </div>
        ) : (
          sortedCheckpoints.map((cp) => (
            <CheckpointRow
              key={cp.id}
              checkpoint={cp}
              onRollback={() => setRollbackTarget(cp)}
            />
          ))
        )}
      </div>

      <CreateCheckpointModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        onCreate={handleCreate}
        isMutating={isMutating}
      />

      <RollbackConfirmModal
        visible={!!rollbackTarget}
        checkpoint={rollbackTarget}
        onClose={() => setRollbackTarget(null)}
        onConfirm={() => {
          if (rollbackTarget) void handleRollback(rollbackTarget.id);
        }}
        isMutating={isMutating}
      />
    </div>
  );
}

function CheckpointRow({
  checkpoint: cp,
  onRollback,
}: {
  checkpoint: Checkpoint;
  onRollback: () => void;
}) {
  const timeStr = new Date(cp.createdAt).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="flex items-start gap-3 px-3 py-2.5 border-b border-[color:var(--ide-border)] hover:bg-[color:var(--ide-hover)] group">
      <div className="mt-0.5 shrink-0">
        <GitCommitHorizontal size={14} className="text-[color:var(--ide-muted)]" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          {cp.name ? (
            <span className="text-[12px] font-medium text-[color:var(--ide-text-strong)] truncate">
              {cp.name}
            </span>
          ) : (
            <span className="text-[12px] font-mono text-[color:var(--ide-muted)]">
              {cp.commitSha.substring(0, 7)}
            </span>
          )}
          <span className="flex-1" />
          <span className="text-[11px] text-[color:var(--ide-muted)] whitespace-nowrap">
            {timeStr}
          </span>
        </div>
        <div className="text-[11px] text-[color:var(--ide-muted)] truncate mt-0.5">
          {cp.commitMessage}
        </div>
        <div className="flex items-center gap-3 mt-1">
          <span className="flex items-center gap-1 text-[10px] text-[color:var(--ide-muted)]">
            <Tag size={9} /> {cp.branch}
          </span>
          <span className="text-[10px] text-[color:var(--ide-muted)]">
            {cp.filesChanged} files · +{cp.additions} −{cp.deletions}
          </span>
        </div>
      </div>
      <button
        onClick={onRollback}
        title="Rollback to this checkpoint"
        className="mt-0.5 shrink-0 opacity-0 group-hover:opacity-100 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[color:var(--ide-warning)] hover:bg-[color:var(--ide-hover)] transition-opacity"
      >
        <RotateCcw size={10} /> Rollback
      </button>
    </div>
  );
}
