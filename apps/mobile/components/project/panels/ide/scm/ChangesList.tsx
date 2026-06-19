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
import { useCallback, useMemo, useState, type ReactNode } from "react";

import type { GitShortCode, GitSnapshot } from "../git/bridge";
import { buildChangesTree, formatChangeCount, getFilesForSection, type ChangesSection, type SectionFile, type TreeNode } from "./grouping";

type ViewMode = "list" | "tree";

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

  const rowProps = { section, onOpenDiff, onStage, onUnstage, onDiscard, onOpenFile };

  if (viewMode === "tree") {
    return <TreeView files={files} {...rowProps} />;
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

// ── Tree view (VS Code "Tree" mode) ──────────────────────────────
function TreeView({
  files,
  section,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
  onOpenFile,
}: {
  files: SectionFile[];
  section: ChangesSection;
  onOpenDiff: (path: string, group: ChangesSection) => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
  onOpenFile: (path: string) => void;
}) {
  const tree = useMemo(() => buildChangesTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const renderNodes = (nodes: TreeNode[], depth: number): ReactNode[] =>
    nodes.flatMap((node): ReactNode[] => {
      if (node.type === "file") {
        return [
          <FileRow
            key={`f:${node.file.path}`}
            path={node.file.path}
            name={node.name}
            depth={depth}
            code={node.file.code}
            added={node.file.added}
            removed={node.file.removed}
            section={section}
            onOpenDiff={() => onOpenDiff(node.file.path, section)}
            onStage={() => onStage([node.file.path])}
            onUnstage={() => onUnstage([node.file.path])}
            onDiscard={() => onDiscard([node.file.path])}
            onOpenFile={() => onOpenFile(node.file.path)}
          />,
        ];
      }
      const isCollapsed = collapsed.has(node.path);
      const filePaths = collectFilePaths(node);
      const rows: ReactNode[] = [
        <FolderRow
          key={`d:${node.path}`}
          name={node.name}
          depth={depth}
          collapsed={isCollapsed}
          section={section}
          onToggle={() => toggle(node.path)}
          onStage={() => onStage(filePaths)}
          onUnstage={() => onUnstage(filePaths)}
          onDiscard={() => onDiscard(filePaths)}
        />,
      ];
      if (!isCollapsed) rows.push(...renderNodes(node.children, depth + 1));
      return rows;
    });

  return <div>{renderNodes(tree, 0)}</div>;
}

function collectFilePaths(node: TreeNode): string[] {
  if (node.type === "file") return [node.file.path];
  return node.children.flatMap(collectFilePaths);
}

function FolderRow({
  name,
  depth,
  collapsed,
  section,
  onToggle,
  onStage,
  onUnstage,
  onDiscard,
}: {
  name: string;
  depth: number;
  collapsed: boolean;
  section: ChangesSection;
  onToggle: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      className="group/row flex items-center h-[22px] px-2 text-[12px] hover:bg-[color:var(--ide-hover)] cursor-pointer"
      style={{ minHeight: 22, paddingLeft: 8 + depth * 12 }}
      onClick={onToggle}
    >
      {collapsed ? (
        <ChevronRight size={12} className="text-[color:var(--ide-muted)] shrink-0 mr-1" />
      ) : (
        <ChevronDown size={12} className="text-[color:var(--ide-muted)] shrink-0 mr-1" />
      )}
      {collapsed ? (
        <FolderIcon size={12} className="text-[#7aa6ff] shrink-0 mr-1.5" />
      ) : (
        <FolderOpenIcon size={12} className="text-[#7aa6ff] shrink-0 mr-1.5" />
      )}
      <span className="truncate text-[color:var(--ide-text-strong)]">{name}</span>
      <span className="flex-1" />
      <div className="opacity-0 group-hover/row:opacity-100 flex items-center gap-0.5 ml-1.5">
        {section === "changes" && (
          <>
            <button
              title="Discard All in Folder"
              onClick={(e) => { e.stopPropagation(); onDiscard(); }}
              className="p-0.5 rounded hover:bg-rose-500/20 text-[color:var(--ide-muted)] hover:text-rose-300"
            >
              <RotateCcw size={11} />
            </button>
            <button
              title="Stage All in Folder"
              onClick={(e) => { e.stopPropagation(); onStage(); }}
              className="p-0.5 rounded hover:bg-[color:var(--ide-primary)]/20 text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
            >
              <Plus size={11} />
            </button>
          </>
        )}
        {section === "staged" && (
          <button
            title="Unstage All in Folder"
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

// ── VS Code-style file row (22px) ────────────────────────────────
function FileRow({
  path,
  name: nameOverride,
  depth,
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
  /** Display name override (tree mode passes the leaf segment). */
  name?: string;
  /** Indentation depth in tree mode. Omitted/0 for the flat list. */
  depth?: number;
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
  const name = nameOverride ?? path.split("/").pop() ?? path;
  // In tree mode the folder hierarchy already conveys the directory, so only
  // the flat list shows the trailing directory column.
  const isTree = depth !== undefined;
  const dir = !isTree && path.includes("/") ? path.slice(0, -name.length - 1) : "";
  const countStr = formatChangeCount(added, removed);

  const handleDragStart = (e: any) => {
    e.dataTransfer?.setData?.("application/x-git-file-path", path);
    e.dataTransfer?.setData?.("application/x-git-source-group", section);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  };

  return (
    <div
      className="group/row flex items-center h-[22px] px-2 text-[12px] hover:bg-[color:var(--ide-hover)] cursor-pointer"
      style={{ minHeight: 22, paddingLeft: isTree ? 8 + (depth ?? 0) * 12 + 16 : undefined }}
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
