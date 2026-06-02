// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Grouped list of changes: Merge / Staged / Changes. Each row shows the
// path + a status letter + hover-revealed inline actions (open diff,
// stage/unstage, discard). Mirrors VS Code's SCM viewlet layout.

import { ChevronDown, ChevronRight, FileIcon, Minus, Plus, RotateCcw } from "lucide-react-native";
import { useMemo, useState } from "react";

import type { GitShortCode, GitSnapshot } from "../git/bridge";
import { isCountedGitCode } from "../git/git-counting";

interface Group {
  id: "merge" | "staged" | "changes";
  label: string;
  files: { path: string; code: GitShortCode | "·" }[];
  emptyHint?: string;
}

export function ChangesList({
  snapshot,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  snapshot: GitSnapshot;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
}) {
  const groups = useMemo(() => buildGroups(snapshot), [snapshot]);

  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <Group
          key={g.id}
          group={g}
          onOpenDiff={onOpenDiff}
          onStage={onStage}
          onUnstage={onUnstage}
          onDiscard={onDiscard}
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
  // The porcelain encodes BOTH index and working columns; we collapse to
  // one short letter for display. To split into staged vs working groups
  // we'd ideally re-parse the snapshot here, but for G2 v1 we use a
  // pragmatic heuristic: anything in fileStatus that ISN'T conflict and
  // has a working-side change goes to "Changes"; anything staged also
  // shows in "Staged Changes" (overlap = file changed in both columns).
  // The viewer can still stage/unstage; refresh re-renders accurately.
  for (const [path, code] of Object.entries(snapshot.fileStatus)) {
    if (snapshot.conflictPaths.includes(path)) continue;
    // BUG-007: route through the shared isCountedGitCode source-of-truth
    // so the "ignored ('!') excluded" rule cannot drift between the SCM
    // badge count and the Source Control viewlet's Changes group.
    if (!isCountedGitCode(code)) continue;
    working.push({ path, code });
  }
  const groups: Group[] = [
    { id: "merge", label: "Merge Changes", files: merge, emptyHint: undefined },
    { id: "staged", label: "Staged Changes", files: staged, emptyHint: "Nothing staged" },
    { id: "changes", label: "Changes", files: working, emptyHint: "Working tree clean" },
  ];
  return groups.filter((g) => g.files.length > 0 || g.id === "changes" || g.id === "staged");
}

function Group({
  group,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  group: Group;
  onOpenDiff: (path: string, group: "staged" | "changes" | "merge") => void;
  onStage: (paths: string[]) => void;
  onUnstage: (paths: string[]) => void;
  onDiscard: (paths: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(true);
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
              <button
                title="Stage all"
                onClick={() => onStage(group.files.map((f) => f.path))}
                className="p-1 rounded hover:bg-[color:var(--ide-surface)] text-[color:var(--ide-muted)] hover:text-[color:var(--ide-text-strong)]"
              >
                <Plus size={11} />
              </button>
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
          ) : (
            group.files.map((f) => (
              <Row
                key={`${group.id}:${f.path}`}
                path={f.path}
                code={f.code}
                groupId={group.id}
                onOpenDiff={() => onOpenDiff(f.path, group.id)}
                onStage={() => onStage([f.path])}
                onUnstage={() => onUnstage([f.path])}
                onDiscard={() => onDiscard([f.path])}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

function Row({
  path,
  code,
  groupId,
  onOpenDiff,
  onStage,
  onUnstage,
  onDiscard,
}: {
  path: string;
  code: GitShortCode | "·";
  groupId: "merge" | "staged" | "changes";
  onOpenDiff: () => void;
  onStage: () => void;
  onUnstage: () => void;
  onDiscard: () => void;
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
  return (
    <div className="group/row flex items-center gap-1 px-3 py-0.5 text-[13px] hover:bg-[color:var(--ide-surface)] cursor-pointer" onClick={onOpenDiff}>
      <FileIcon size={12} className="text-[color:var(--ide-muted)] shrink-0" />
      <span className="truncate text-[color:var(--ide-text-strong)]">{name}</span>
      {dir && <span className="truncate text-[11px] text-[color:var(--ide-muted)]" title={path}>{dir}</span>}
      <span className="flex-1" />
      <div className="opacity-0 group-hover/row:opacity-100 flex items-center gap-0.5">
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
      <span className={`ml-1 text-[11px] font-semibold tabular-nums ${codeColor}`}>{code}</span>
    </div>
  );
}
