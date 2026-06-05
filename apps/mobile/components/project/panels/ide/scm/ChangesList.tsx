// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Grouped list of changes: Merge / Staged / Changes. Each row shows the
// path + a status letter + hover-revealed inline actions (open diff,
// stage/unstage, discard). Supports flat list and tree (directory-grouped)
// views. Rows support drag-drop for staging/unstaging.

import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileIcon,
  FolderIcon,
  FolderOpenIcon,
  GripVertical,
  Minus,
  Plus,
  RotateCcw,
  TreePine,
  List,
} from "lucide-react-native";
import { useCallback, useMemo, useState } from "react";

import type { GitShortCode, GitSnapshot } from "../git/bridge";
import { isCountedGitCode } from "../git/git-counting";

interface Group {
  id: "merge" | "staged" | "changes";
  label: string;
  files: { path: string; code: GitShortCode | "·"; added?: number; removed?: number }[];
  emptyHint?: string;
}

type ViewMode = "list" | "tree";

export function ChangesList({
  snapshot,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  onDiscardAll,
  onConfirmDiscard,
}: {
  snapshot: GitSnapshot;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
  onDiscardAll?: (paths: string[]) => void;
  onConfirmDiscard?: (paths: string[], cb: () => void) => void;
}) {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const groups = useMemo(() => buildGroups(snapshot), [snapshot]);

  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-end gap-0.5 px-2 py-0.5 border-b border-[color:var(--ide-border)]">
        <button
          title="Flat list"
          onClick={() => setViewMode("list")}
          className={`p-1 rounded ${viewMode === "list" ? "text-[color:var(--ide-primary)] bg-[color:var(--ide-surface)]" : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"}`}
        >
          <List size={12} />
        </button>
        <button
          title="Tree view"
          onClick={() => setViewMode("tree")}
          className={`p-1 rounded ${viewMode === "tree" ? "text-[color:var(--ide-primary)] bg-[color:var(--ide-surface)]" : "text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"}`}
        >
          <TreePine size={12} />
        </button>
      </div>
      {groups.map((g) => (
        <GroupComponent
          key={g.id}
          group={g}
          viewMode={viewMode}
          onOpenDiff={onOpenDiff}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
          onOpenFile={onOpenFile}
          onDiscardAll={onDiscardAll}
          onConfirmDiscard={onConfirmDiscard}
        />
      ))}
    </div>
  );
}

function buildGroups(snapshot: GitSnapshot): Group[] {
  const merge: Group["files"] = [];
  const staged: Group["files"] = [];
  const working: Group["files"] = [];
  for (const path of snapshot.conflictPaths) {
    merge.push({ path, code: snapshot.fileStatus[path] ?? "U" });
  }
  const stagedPaths = new Set(Object.keys(snapshot.stagedStatus));
  for (const [path, code] of Object.entries(snapshot.fileStatus)) {
    if (snapshot.conflictPaths.includes(path)) continue;
    if (!isCountedGitCode(code)) continue;
    if (stagedPaths.has(path)) {
      const changes = snapshot.fileChanges?.[path];
      staged.push({ path, code, added: changes?.added, removed: changes?.removed });
    } else {
      const changes = snapshot.fileChanges?.[path];
      working.push({ path, code, added: changes?.added, removed: changes?.removed });
    }
  }
  const groups: Group[] = [
    { id: "merge", label: "Merge Changes", files: merge, emptyHint: undefined },
    { id: "staged", label: "Staged Changes", files: staged, emptyHint: "Nothing staged" },
    { id: "changes", label: "Changes", files: working, emptyHint: "Working tree clean" },
  ];
  return groups.filter((g) => g.files.length > 0 || g.id === "changes" || g.id === "staged");
}

function buildTree(files: Group["files"]): DirNode[] {
  const root: DirNode = { name: "", path: "", children: [], files: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirName = parts[i];
      let child = node.children.find((c) => c.name === dirName);
      if (!child) {
        child = { name: dirName, path: parts.slice(0, i + 1).join("/"), children: [], files: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.files.push(f);
  }
  return root.children;
}

interface DirNode {
  name: string;
  path: string;
  children: DirNode[];
  files: { path: string; code: GitShortCode | "·"; added?: number; removed?: number }[];
}

function GroupComponent({
  group,
  viewMode,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  onDiscardAll,
  onConfirmDiscard,
}: {
  group: Group;
  viewMode: ViewMode;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
  onDiscardAll?: (paths: string[]) => void;
  onConfirmDiscard?: (paths: string[], cb: () => void) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const tree = useMemo(() => (viewMode === "tree" ? buildTree(group.files) : []), [viewMode, group.files]);

  return (
    <div className="border-b border-[color:var(--ide-border)] last:border-b-0">
      <div className="flex items-center gap-1 px-2 py-1.5 text-[11px] uppercase tracking-wider text-[color:var(--ide-muted)] group/header">
        <button onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 flex-1 hover:text-[color:var(--ide-text-strong)]">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          <span>{group.label}</span>
        </button>
        <span className="rounded-full bg-[color:var(--ide-surface)] px-1.5 text-[10px] tabular-nums">{group.files.length}</span>
        {group.files.length > 0 && (
          <div className="opacity-0 group-hover/header:opacity-100 flex items-center gap-0.5">
            {group.id === "changes" && (
              <>
                <button
                  title="Stage all"
                  onClick={() => onStage(group.files.map((f) => f.path))}
                  className="p-1 rounded hover:bg-[color:var(--ide-surface)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
                >
                  <Plus size={11} />
                </button>
                {onDiscardAll && (
                  <button
                    title="Discard all changes"
                    onClick={() => onDiscardAll(group.files.map((f) => f.path))}
                    className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
                  >
                    <RotateCcw size={11} />
                  </button>
                )}
              </>
            )}
            {group.id === "staged" && (
              <button
                title="Unstage all"
                onClick={() => onUnstage(group.files.map((f) => f.path))}
                className="p-1 rounded hover:bg-[color:var(--ide-surface)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
              >
                <Minus size={11} />
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && (
        <>
          {group.files.length === 0 ? (
            <div className="px-4 py-2 text-[11px] italic text-[color:var(--ide-muted)]">{group.emptyHint}</div>
          ) : viewMode === "tree" ? (
            tree.map((node) => (
              <DirNodeComponent
                key={node.path}
                node={node}
                depth={0}
                groupId={group.id}
                onOpenDiff={onOpenDiff}
                onStage={onStage}
                onUnstage={onUnstage}
                onDiscard={onDiscard}
                onOpenFile={onOpenFile}
                onConfirmDiscard={onConfirmDiscard}
              />
            ))
          ) : (
            group.files.map((f) => (
              <Row
                key={`${group.id}:${f.path}`}
                path={f.path}
                code={f.code}
                groupId={group.id}
                added={f.added}
                removed={f.removed}
                onOpenDiff={() => onOpenDiff(f.path, group.id)}
                onStage={() => onStage([f.path])}
                onUnstage={() => onUnstage([f.path])}
                onDiscard={() => {
                  if (onConfirmDiscard) {
                    onConfirmDiscard([f.path], () => onDiscard([f.path]));
                  } else {
                    onDiscard([f.path]);
                  }
                }}
                onOpenFile={() => onOpenFile(f.path)}
                stageAll={onStage}
                unstageAll={onUnstage}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function DirNodeComponent({
  node,
  depth,
  groupId,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  onConfirmDiscard,
  stageAll,
  unstageAll,
}: {
  node: DirNode;
  depth: number;
  groupId: "merge" | "staged" | "changes";
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
  onConfirmDiscard?: (paths: string[], cb: () => void) => void;
  stageAll?: (paths: string[]) => void;
  unstageAll?: (paths: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasSubdirs = node.children.length > 0;
  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 text-[12px] hover:bg-[color:var(--ide-surface)] cursor-pointer"
        style={{ paddingLeft: `${depth * 12 + 12}px` }}
        onClick={() => setExpanded((v) => !v)}
      >
        {hasSubdirs ? (
          expanded ? <ChevronDown size={11} className="text-[color:var(--ide-muted)] shrink-0" /> : <ChevronRight size={11} className="text-[color:var(--ide-muted)] shrink-0" />
        ) : (
          <span className="w-[11px] shrink-0" />
        )}
        {expanded ? <FolderOpenIcon size={12} className="text-[#dcb67a] shrink-0" /> : <FolderIcon size={12} className="text-[#dcb67a] shrink-0" />}
        <span className="text-[color:var(--ide-text-strong)] font-medium">{node.name}</span>
      </div>
      {expanded && (
        <>
          {node.children.map((child) => (
            <DirNodeComponent
              key={child.path}
              node={child}
              depth={depth + 1}
              groupId={groupId}
              onOpenDiff={onOpenDiff}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
              onOpenFile={onOpenFile}
              onConfirmDiscard={onConfirmDiscard}
              stageAll={stageAll}
              unstageAll={unstageAll}
            />
          ))}
          {node.files.map((f) => (
            <Row
              key={`${groupId}:${f.path}`}
              path={f.path}
              code={f.code}
              groupId={groupId}
              added={f.added}
              removed={f.removed}
              depth={depth + 1}
              onOpenDiff={() => onOpenDiff(f.path, groupId)}
              onStage={() => onStage([f.path])}
              onUnstage={() => onUnstage([f.path])}
              onDiscard={() => {
                if (onConfirmDiscard) {
                  onConfirmDiscard([f.path], () => onDiscard([f.path]));
                } else {
                  onDiscard([f.path]);
                }
              }}
              onOpenFile={() => onOpenFile(f.path)}
              stageAll={onStage}
              unstageAll={onUnstage}
            />
          ))}
        </>
      )}
    </div>
  );
}

function formatChangeCount(added?: number, removed?: number): string {
  if (added === undefined && removed === undefined) return "";
  const a = added ?? 0;
  const r = removed ?? 0;
  const parts: string[] = [];
  if (a > 0) parts.push(`+${a > 99 ? "99+" : a}`);
  if (r > 0) parts.push(`-${r > 99 ? "99+" : r}`);
  return parts.join(" ");
}

function Row({
  path,
  code,
  groupId,
  added,
  removed,
  depth = 0,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
  stageAll,
  unstageAll,
}: {
  path: string;
  code: GitShortCode | "·";
  groupId: "merge" | "staged" | "changes";
  added?: number;
  removed?: number;
  depth?: number;
  onOpenDiff: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onOpenFile: () => void;
  stageAll?: (paths: string[]) => void;
  unstageAll?: (paths: string[]) => void;
}) {
  const name = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.slice(0, -name.length - 1) : "";
  const codeColor =
    code === "M" || code === "T"
      ? "text-[#e2c08d]"
      : code === "A" || code === "?"
      ? "text-[#73c991]"
      : code === "D" || code === "U"
      ? "text-[#f48771]"
      : code === "R" || code === "C"
      ? "text-[#7aa6ff]"
      : "text-[color:var(--ide-muted)]";
  const pl = `${depth * 12 + 12}px`;

  const handleDragStart = (e: any) => {
    e.dataTransfer?.setData?.("application/x-git-file-path", path);
    e.dataTransfer?.setData?.("application/x-git-source-group", groupId);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e: any) => {
    e.preventDefault?.();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  };

  // Drag-drop is visual-only at the Row level. The parent Group
  // handles drop zones via onStageAll/onUnstageAll if needed.


  return (
    <div
      className="group/row flex items-center gap-1 py-0.5 text-[13px] hover:bg-[color:var(--ide-surface)] cursor-pointer"
      style={{ paddingLeft: pl }}
      draggable
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDrop={(e: any) => { e.preventDefault?.(); const fp = e.dataTransfer?.getData?.("application/x-git-file-path") ?? ""; const sg = e.dataTransfer?.getData?.("application/x-git-source-group") ?? ""; if (fp && sg === "changes" && groupId === "staged" && stageAll) stageAll([fp]); else if (fp && sg === "staged" && groupId === "changes" && unstageAll) unstageAll([fp]); }}
      onClick={onOpenDiff}
    >
      <GripVertical size={10} className="text-[color:var(--ide-muted)]/30 shrink-0 opacity-0 group-hover/row:opacity-100 cursor-grab" />
      <FileIcon size={12} className="text-[color:var(--ide-muted)] shrink-0" />
      <span className="truncate text-[color:var(--ide-text-strong)]">{name}</span>
      {dir && <span className="truncate text-[11px] text-[color:var(--ide-muted)]" title={path}>{dir}</span>}
      <span className="flex-1" />
      <div className="opacity-0 group-hover/row:opacity-100 flex items-center gap-0.5">
        <button
          title="Open File"
          onClick={(e) => { e.stopPropagation(); onOpenFile(); }}
          className="p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
        >
          <ExternalLink size={11} />
        </button>
        {groupId === "changes" && (
          <>
            <button
              title="Discard changes"
              onClick={(e) => { e.stopPropagation(); onDiscard(); }}
              className="p-1 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
            >
              <RotateCcw size={11} />
            </button>
            <button
              title="Stage changes"
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="p-1 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
            >
              <Plus size={11} />
            </button>
          </>
        )}
        {groupId === "staged" && (
          <button
            title="Unstage"
            onClick={(e) => { e.stopPropagation(); onUnstage(); }}
            className="p-1 rounded hover:bg-[color:var(--ide-surface)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          >
            <Minus size={11} />
          </button>
        )}
      </div>
      <span className={`ml-1 text-[11px] font-semibold tabular-nums ${codeColor}`}>{formatChangeCount(added, removed)}{code !== "·" ? ", " : ""}{code}</span>
    </div>
  );
}