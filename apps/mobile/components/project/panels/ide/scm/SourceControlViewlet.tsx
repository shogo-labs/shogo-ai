// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Source Control viewlet. Mounted in the primary side bar when the
// activity bar's "git" entry is selected. On non-desktop platforms the
// snapshot is null and we fall back to the existing CheckpointsPanel.

import { GitBranch, MoreHorizontal, RefreshCw } from "lucide-react-native";
import { useCallback, useState } from "react";

import { BranchPicker } from "../git/BranchPicker";
import { useGitStatusContext } from "../git/GitStatusContext";
import { ScmMenu } from "../git/ScmMenu";
import { StashList } from "../git/StashList";
import { ChangesList } from "./ChangesList";
import { CommitInput } from "./CommitInput";
import { useScmActions } from "./useScmActions";

export function SourceControlViewlet({
  workspaceRoot,
  fallback,
  onOpenDiff,
  onOpenFile,
}: {
  workspaceRoot: string | null;
  /** Rendered when no git context is available (no repo, web/mobile, etc.). */
  fallback?: React.ReactNode;
  /** Wired by Workbench to open a Monaco diff tab. */
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onOpenFile: (path: string) => void;
}) {
  const { snapshot } = useGitStatusContext();
  const actions = useScmActions(workspaceRoot);
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [stashListOpen, setStashListOpen] = useState(false);

  const refresh = useCallback(() => {
    void actions.refresh();
  }, [actions]);

  if (!actions.available || !snapshot || !snapshot.isRepo) {
    return (
      <div className="flex flex-col h-full">
        <div className="px-3 py-2 border-b border-[color:var(--ide-border)] text-[11px] uppercase tracking-wider text-[color:var(--ide-muted)]">
          Source Control
        </div>
        {fallback ?? (
          <div className="flex flex-col h-full items-center justify-center gap-2 px-6 text-center text-[color:var(--ide-muted)]">
            <GitBranch size={28} />
            <div className="text-[13px]">No git repository in this workspace.</div>
            <div className="text-[11px]">Open a folder containing a <code>.git</code> directory to enable Source Control.</div>
          </div>
        )}
      </div>
    );
  }

  const stagedCount = Object.keys(snapshot.stagedStatus).length;

  return (
    <div className="flex flex-col h-full">
      <div className="relative flex items-center gap-2 px-3 py-2 border-b border-[color:var(--ide-border)]">
        <button
          onClick={() => setBranchPickerOpen(true)}
          title="Change branch"
          className="flex items-center gap-1 -mx-1 px-1 py-0.5 rounded text-left hover:bg-[color:var(--ide-hover)]"
        >
          <GitBranch size={13} className="text-[color:var(--ide-muted)]" />
          <span className="text-[12px] text-[color:var(--ide-text-strong)] truncate">
            {snapshot.detached ? "HEAD detached" : snapshot.branch ?? "—"}
          </span>
        </button>
        {snapshot.upstream && (
          <span className="text-[11px] text-[color:var(--ide-muted)] truncate">{snapshot.upstream}</span>
        )}
        {snapshot.ahead > 0 && (
          <span className="text-[11px] text-emerald-400 font-medium" title={`${snapshot.ahead} commit${snapshot.ahead !== 1 ? "s" : ""} to push`}>↑{snapshot.ahead}</span>
        )}
        {snapshot.behind > 0 && (
          <span className="text-[11px] text-amber-400 font-medium" title={`${snapshot.behind} commit${snapshot.behind !== 1 ? "s" : ""} to pull`}>↓{snapshot.behind}</span>
        )}
        <span className="flex-1" />
        <button
          title="Refresh"
          onClick={refresh}
          className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
        >
          <RefreshCw size={12} />
        </button>
        <button
          title="More actions"
          onClick={() => setMenuOpen((v) => !v)}
          className="p-1 rounded hover:bg-[color:var(--ide-hover)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
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
      <CommitInput
        stagedCount={stagedCount}
        totalCount={Object.keys(snapshot.fileStatus).length - snapshot.conflictPaths.length}
        onCommit={async (message, opts) => {
          const r = await actions.commit(message, opts)
          return { ok: r.ok, error: r.ok ? undefined : r.error }
        }}
        onCommitAll={async (message, opts) => {
          const r = await actions.commitAll(message, opts)
          return { ok: r.ok, error: r.ok ? undefined : r.error }
        }}
        onCommitAndPush={async (message, opts) => {
          const r = await actions.commitAndPush(message, opts)
          return { ok: r.ok, error: r.ok ? undefined : r.error }
        }}
        onCommitAndSync={async (message, opts) => {
          const r = await actions.commitAndSync(message, opts)
          return { ok: r.ok, error: r.ok ? undefined : r.error }
        }}
        onUndoLastCommit={async () => {
          const r = await actions.undoLastCommit()
          return { ok: r.ok, error: r.ok ? undefined : r.error }
        }}
        onGenerateMessage={actions.available ? async () => {
          const r = await actions.generateCommitMessage()
          return { ok: r.ok, message: r.ok ? r.message : undefined, error: r.ok ? undefined : r.error }
        } : undefined}
      />
      <div className="flex-1 overflow-auto">
        <ChangesList
          snapshot={snapshot}
          onOpenDiff={onOpenDiff}
          onOpenFile={onOpenFile}
          onStage={(paths) => { void actions.stage(paths); }}
          onUnstage={(paths) => { void actions.unstage(paths); }}
          onDiscard={(paths) => { void actions.discard(paths); }}
        />
      </div>
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
