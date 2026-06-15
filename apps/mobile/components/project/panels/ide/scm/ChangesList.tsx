// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// VS Code-style changes list. Each section (staged/changes) is rendered
// separately by the parent SourceControlViewlet. This component filters
// the snapshot based on the `section` prop.
//
// Row layout: [file-icon] [filename] [directory] [count, badge]
// Row height: 22px. Hover actions only.

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

type ViewMode = "list" | "tree";

function formatChangeCount(added?: number, removed?: number): string {
  if (added === undefined && removed === undefined) return "";
  const a = added ?? 0;
  const r = removed ?? 0;
  const parts: string[] = [];
  if (a > 0) parts.push(`+${a > 99 ? "99+" : a}`);
  if (r > 0) parts.push(`-${r > 99 ? "99+" : r}`);
  return parts.join(" ");
}

function statusCodeColor(code: GitShortCode | "·"): string {
  switch (code) {
    case "M": case "T": return "text-[#e2c08d]";
    case "A": case "U": case "?": return "text-[#73c991]";
    case "D": return "text-[#f48771]";
    case "R": case "C": return "text-[#7aa6ff]";
    default: return "text-[color:var(--ide-muted)]";
  }
}

function displayStatusCode(code: GitShortCode | "·"): string {
  return code === "?" ? "U" : code;
}

// ── Extract files for a section from snapshot ──────────────────────
type ChangesSection = "merge" | "staged" | "changes";

function getFilesForSection(snapshot: GitSnapshot, section: ChangesSection): Array<{ path: string; code: GitShortCode; added?: number; removed?: number }> {
  const result: Array<{ path: string; code: GitShortCode; added?: number; removed?: number }> = [];
  const stagedPaths = new Set(Object.keys(snapshot.stagedStatus));

  if (section === "merge") {
    for (const path of snapshot.conflictPaths) {
      const code = snapshot.fileStatus[path] ?? "U";
      result.push({ path, code });
    }
    return result;
  }

  for (const [path, code] of Object.entries(snapshot.fileStatus)) {
    if (snapshot.conflictPaths.includes(path)) continue;
    if (!isCountedGitCode(code)) continue;
    const isStaged = stagedPaths.has(path);
    if (section === "staged" && !isStaged) continue;
    if (section === "changes" && isStaged) continue;
    const changes = snapshot.fileChanges?.[path];
    result.push({ path, code, added: changes?.added, removed: changes?.removed });
  }
  return result;
}

export function ChangesList({
  snapshot,
  section,
  viewMode = "list",
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
}: {
  snapshot: GitSnapshot;
  section: ChangesSection;
  viewMode?: "list" | "tree";
  onOpenDiff: (path: string, group: ChangesSection) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
}) {
  const files = useMemo(() => getFilesForSection(snapshot, section), [snapshot, section]);

  if (files.length === 0) {
    return (
      <div className="px-4 py-1 text-[11px] italic text-[color:var(--ide-muted)]" style={{ minHeight: 22 }}>
        {section === "staged" ? "Nothing staged" : "No changes"}
      </div>
    );
  }

  return (
    <div>
      {files.map((f) => (
        <FileRow
          key={f.path}
          path={f.path}
          code={f.code}
          added={f.added}
          removed={f.removed}
          section={section}
          onOpenDiff={() => onOpenDiff(f.path, section)}
          onStage={() => onStage([f.path])}
          onUnstage={() => onUnstage([f.path])}
          onDiscard={() => onDiscard([f.path])}
          onOpenFile={() => onOpenFile(f.path)}
        />
      ))}
    </div>
  );
}

// ── VS Code-style file row (22px) ────────────────────────────────
function FileRow({
  path,
  code,
  added,
  removed,
  section,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
}: {
  path: string;
  code: GitShortCode;
  added?: number;
  removed?: number;
  section: ChangesSection;
  onOpenDiff: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
  onOpenFile: () => void;
}) {
  const name = path.split("/").pop() ?? path;
  const dir = path.includes("/") ? path.slice(0, -name.length - 1) : "";
  const countStr = formatChangeCount(added, removed);

  const handleDragStart = (e: any) => {
    e.dataTransfer?.setData?.("application/x-git-file-path", path);
    e.dataTransfer?.setData?.("application/x-git-source-group", section);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      className="group/row flex items-center h-[22px] px-2 text-[12px] hover:bg-[color:var(--ide-hover)] cursor-pointer"
      style={{ minHeight: 22 }}
      draggable
      onDragStart={handleDragStart}
      onClick={onOpenDiff}
    >
      {/* File icon */}
      <FileIcon size={12} className="text-[color:var(--ide-muted)] shrink-0 mr-1.5" />

      {/* Filename — bold */}
      <span className="truncate text-[color:var(--ide-text-strong)] font-medium">{name}</span>

      {/* Directory — muted */}
      {dir && (
        <span className="truncate text-[11px] text-[color:var(--ide-muted)] ml-1.5" title={path}>
          {dir}
        </span>
      )}

      <span className="flex-1" />

      {/* Change count */}
      {countStr && (
        <span className="text-[11px] text-[color:var(--ide-muted)] tabular-nums mr-1.5">{countStr}</span>
      )}

      {/* Status badge */}
      <span className={`text-[11px] font-bold tabular-nums ${statusCodeColor(code)}`}>{displayStatusCode(code)}</span>

      {/* Hover actions — VS Code style */}
      <div className="opacity-0 group-hover/row:opacity-100 flex items-center gap-0.5 ml-1.5">
        {section === "merge" && (
          <button
            title="Open Merge Editor"
            onClick={(e) => { e.stopPropagation(); onOpenDiff(); }}
            className="p-0.5 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          >
            <ExternalLink size={11} />
          </button>
        )}
        {section === "changes" && (
          <button
            title="Discard Changes"
            onClick={(e) => { e.stopPropagation(); onDiscard(); }}
            className="p-0.5 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
          >
            <RotateCcw size={11} />
          </button>
        )}
        {section === "changes" && (
          <button
            title="Stage Changes"
            onClick={(e) => { e.stopPropagation(); onStage(); }}
            className="p-0.5 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          >
            <Plus size={11} />
          </button>
        )}
        {section === "staged" && (
          <button
            title="Unstage"
            onClick={(e) => { e.stopPropagation(); onUnstage(); }}
            className="p-0.5 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
          >
            <Minus size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
