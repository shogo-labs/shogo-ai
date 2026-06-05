// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The right-hand detail panel for the commit graph. Mirrors GitKraken:
// working-directory summary (for the WIP selection) or a commit's metadata,
// message, author + co-authors, and the file list with Path / Tree views.

import {
  ExternalLink,
  FilePlus,
  FilePen,
  FileMinus,
  FileText,
  Folder,
  GitCommit,
  ListTree,
  Loader2,
  Rocket,
  RotateCcw,
} from "lucide-react-native";
import { useMemo, useState } from "react";

import type {
  GitCommitDetail,
  GitCommitDetailFile,
  GitStatus,
} from "@shogo/shared-app/hooks";
import { avatarColor, formatDateTime, initials, isAiAuthor, relativeTime } from "./gitAvatar";

export function CommitDetailPanel({
  detail,
  loading,
  isWip,
  workingStatus,
  checkpointId,
  isLive = false,
  liveUrl,
  publishedAt,
  onViewLive,
  isRollingBack,
  onRollback,
  onOpenFile,
  onViewChanges,
}: {
  detail: GitCommitDetail | null;
  loading: boolean;
  isWip: boolean;
  workingStatus: GitStatus | null;
  checkpointId: string | null;
  isLive?: boolean;
  liveUrl?: string | null;
  publishedAt?: number | null;
  onViewLive?: () => void;
  isRollingBack: boolean;
  onRollback: (checkpointId: string) => void;
  onOpenFile: (path: string) => void;
  onViewChanges: () => void;
}) {
  if (isWip) {
    return <WorkingDirView workingStatus={workingStatus} onViewChanges={onViewChanges} onOpenFile={onOpenFile} />;
  }

  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-[color:var(--ide-muted)]">
        <Loader2 size={14} className="animate-spin mr-2" /> Loading commit…
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[color:var(--ide-muted)]">
        <GitCommit size={26} />
        <div className="text-[13px]">Select a commit to see its details.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--ide-border)]">
        <span className="text-[12px] text-[color:var(--ide-muted)]">
          commit <span className="font-mono text-[color:var(--ide-text-strong)]">{detail.shortSha}</span>
        </span>
        {isLive && (
          <span
            className="flex items-center gap-1 rounded px-1.5 h-[18px] border text-[11px]"
            style={{
              background: "color-mix(in srgb, var(--ide-success, #10b981) 18%, transparent)",
              borderColor: "var(--ide-success, #10b981)",
              color: "var(--ide-text-strong)",
            }}
          >
            <Rocket size={10} style={{ color: "var(--ide-success, #10b981)" }} /> Live
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-4 py-3">
          <div className="text-[15px] font-semibold text-[color:var(--ide-text-strong)] whitespace-pre-wrap">
            {detail.subject}
          </div>
          {detail.body && (
            <div className="mt-2 text-[12px] leading-relaxed text-[color:var(--ide-text)] whitespace-pre-wrap">
              {stripTrailers(detail.body)}
            </div>
          )}
        </div>

        {isLive && liveUrl && (
          <div className="px-4 pb-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[12px] text-[color:var(--ide-text-strong)] truncate">
                Live at {liveUrl.replace(/^https?:\/\//, "")}
              </div>
              {typeof publishedAt === "number" && (
                <div className="text-[11px] text-[color:var(--ide-muted)]">
                  published {relativeTime(new Date(publishedAt).toISOString())}
                </div>
              )}
            </div>
            <button
              onClick={() => onViewLive?.()}
              title="Open the live site"
              className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium text-white shrink-0"
              style={{ background: "var(--ide-success, #10b981)" }}
            >
              <ExternalLink size={12} /> View live
            </button>
          </div>
        )}

        <div className="px-4 py-3 border-t border-[color:var(--ide-border)]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Avatar name={detail.author} email={detail.authorEmail} />
              <div className="min-w-0">
                <div className="text-[12px] text-[color:var(--ide-text-strong)] truncate">{detail.author}</div>
                <div className="text-[11px] text-[color:var(--ide-muted)]">
                  authored {formatDateTime(detail.date)}
                </div>
              </div>
            </div>
            {detail.parents[0] && (
              <span className="text-[11px] text-[color:var(--ide-muted)] whitespace-nowrap">
                parent: <span className="font-mono">{detail.parents[0].slice(0, 6)}</span>
              </span>
            )}
          </div>
          {detail.coAuthors.length > 0 && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[11px] text-[color:var(--ide-muted)]">Co-authors:</span>
              <div className="flex -space-x-1">
                {detail.coAuthors.map((ca) => (
                  <div key={ca.email} title={`${ca.name} <${ca.email}>`}>
                    <Avatar name={ca.name} email={ca.email} small />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <FileList files={detail.files} onOpenFile={onOpenFile} />
      </div>

      {checkpointId && (
        <div className="px-4 py-2 border-t border-[color:var(--ide-border)]">
          <button
            onClick={() => onRollback(checkpointId)}
            disabled={isRollingBack}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-50"
            style={{ background: "var(--ide-btn-secondary-bg)", color: "var(--ide-warning)" }}
          >
            {isRollingBack ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
            Roll back to this checkpoint
          </button>
        </div>
      )}
    </div>
  );
}

function WorkingDirView({
  workingStatus,
  onViewChanges,
  onOpenFile,
}: {
  workingStatus: GitStatus | null;
  onViewChanges: () => void;
  onOpenFile: (path: string) => void;
}) {
  const changed = useMemo(() => {
    if (!workingStatus) return [] as { path: string; status: GitCommitDetailFile["status"] }[];
    const ws = workingStatus as GitStatus & { modified?: string[] };
    const out: { path: string; status: GitCommitDetailFile["status"] }[] = [];
    for (const p of ws.staged ?? []) out.push({ path: p, status: "modified" });
    for (const p of ws.unstaged ?? []) out.push({ path: p, status: "modified" });
    for (const p of ws.modified ?? []) out.push({ path: p, status: "modified" });
    for (const p of ws.untracked ?? []) out.push({ path: p, status: "added" });
    // De-dupe by path (staged + unstaged overlap).
    const seen = new Set<string>();
    return out.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true)));
  }, [workingStatus]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-[color:var(--ide-border)]">
        <span className="text-[12px] text-[color:var(--ide-text-strong)]">
          {changed.length} file change{changed.length === 1 ? "" : "s"} in working directory
        </span>
        <button
          onClick={onViewChanges}
          className="rounded-md border border-[color:var(--ide-border-strong)] px-2.5 py-1 text-[12px] text-[color:var(--ide-text)] hover:bg-[color:var(--ide-hover)]"
        >
          View Changes
        </button>
      </div>
      <div className="flex-1 overflow-auto">
        <FileList
          files={changed.map((c) => ({ path: c.path, status: c.status, additions: 0, deletions: 0 }))}
          onOpenFile={onOpenFile}
          hideStats
        />
      </div>
    </div>
  );
}

type FileView = "path" | "tree";

function FileList({
  files,
  onOpenFile,
  hideStats,
}: {
  files: GitCommitDetailFile[];
  onOpenFile: (path: string) => void;
  hideStats?: boolean;
}) {
  const [view, setView] = useState<FileView>("path");
  const modified = files.filter((f) => f.status === "modified" || f.status === "renamed").length;
  const added = files.filter((f) => f.status === "added").length;
  const deleted = files.filter((f) => f.status === "deleted").length;

  return (
    <div className="border-t border-[color:var(--ide-border)]">
      <div className="flex items-center justify-between gap-2 px-4 py-2">
        <div className="flex items-center gap-3 text-[11px]">
          {modified > 0 && <span className="text-[color:var(--ide-warning)]">✎ {modified} modified</span>}
          {added > 0 && <span className="text-emerald-400">+ {added} added</span>}
          {deleted > 0 && <span className="text-[color:var(--ide-error)]">− {deleted} deleted</span>}
        </div>
        <div className="flex items-center rounded-md border border-[color:var(--ide-border-strong)] overflow-hidden">
          <button
            onClick={() => setView("path")}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] ${view === "path" ? "bg-[color:var(--ide-active-bg)] text-[color:var(--ide-text-strong)]" : "text-[color:var(--ide-muted)]"}`}
          >
            <FileText size={11} /> Path
          </button>
          <button
            onClick={() => setView("tree")}
            className={`flex items-center gap-1 px-2 py-0.5 text-[11px] ${view === "tree" ? "bg-[color:var(--ide-active-bg)] text-[color:var(--ide-text-strong)]" : "text-[color:var(--ide-muted)]"}`}
          >
            <ListTree size={11} /> Tree
          </button>
        </div>
      </div>

      {files.length === 0 ? (
        <div className="px-4 py-3 text-[12px] italic text-[color:var(--ide-muted)]">No file changes.</div>
      ) : view === "path" ? (
        <div className="pb-3">
          {files.map((f) => (
            <FileRow key={f.path} file={f} onOpenFile={onOpenFile} hideStats={hideStats} />
          ))}
        </div>
      ) : (
        <TreeView files={files} onOpenFile={onOpenFile} hideStats={hideStats} />
      )}
    </div>
  );
}

function FileRow({
  file,
  onOpenFile,
  hideStats,
  indent = 0,
}: {
  file: GitCommitDetailFile;
  onOpenFile: (path: string) => void;
  hideStats?: boolean;
  indent?: number;
}) {
  const name = file.path.split("/").pop() ?? file.path;
  const dir = file.path.slice(0, file.path.length - name.length);
  return (
    <button
      onClick={() => onOpenFile(file.path)}
      className="group flex w-full items-center gap-2 px-4 py-1 text-left hover:bg-[color:var(--ide-hover)]"
      style={{ paddingLeft: 16 + indent * 14 }}
      title={file.path}
    >
      <StatusIcon status={file.status} />
      <span className="text-[12px] text-[color:var(--ide-muted)] truncate">{dir}</span>
      <span className="text-[12px] text-[color:var(--ide-text-strong)] truncate">{name}</span>
      <span className="flex-1" />
      {!hideStats && file.additions > 0 && (
        <span className="text-[10px] text-emerald-400 tabular-nums">+{file.additions}</span>
      )}
      {!hideStats && file.deletions > 0 && (
        <span className="text-[10px] text-[color:var(--ide-error)] tabular-nums">−{file.deletions}</span>
      )}
    </button>
  );
}

function TreeView({
  files,
  onOpenFile,
  hideStats,
}: {
  files: GitCommitDetailFile[];
  onOpenFile: (path: string) => void;
  hideStats?: boolean;
}) {
  // Group by directory; render dir headers + files. One level of grouping is
  // enough to feel "tree-like" without a full collapsible tree.
  const groups = useMemo(() => {
    const map = new Map<string, GitCommitDetailFile[]>();
    for (const f of files) {
      const idx = f.path.lastIndexOf("/");
      const dir = idx === -1 ? "" : f.path.slice(0, idx);
      const arr = map.get(dir) ?? [];
      arr.push(f);
      map.set(dir, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [files]);

  return (
    <div className="pb-3">
      {groups.map(([dir, dirFiles]) => (
        <div key={dir || "(root)"}>
          {dir !== "" && (
            <div className="flex items-center gap-1.5 px-4 py-1 text-[11px] text-[color:var(--ide-muted)]">
              <Folder size={11} className="text-[color:var(--ide-accent-folder)]" />
              <span className="truncate">{dir}</span>
            </div>
          )}
          {dirFiles.map((f) => (
            <FileRow
              key={f.path}
              file={{ ...f, path: f.path }}
              onOpenFile={onOpenFile}
              hideStats={hideStats}
              indent={dir === "" ? 0 : 1}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function StatusIcon({ status }: { status: GitCommitDetailFile["status"] }) {
  if (status === "added") return <FilePlus size={13} className="shrink-0 text-emerald-400" />;
  if (status === "deleted") return <FileMinus size={13} className="shrink-0 text-[color:var(--ide-error)]" />;
  return <FilePen size={13} className="shrink-0 text-[color:var(--ide-warning)]" />;
}

function Avatar({ name, email, small }: { name: string; email: string; small?: boolean }) {
  const ai = isAiAuthor(name, email);
  const bg = ai ? "#e0457b" : avatarColor(email || name);
  const size = small ? 18 : 28;
  return (
    <span
      className="flex items-center justify-center rounded-full shrink-0 text-white font-semibold"
      style={{ width: size, height: size, background: bg, fontSize: small ? 8 : 11, border: "1px solid var(--ide-bg)" }}
    >
      {ai ? "S" : initials(name)}
    </span>
  );
}

/** Drop `Co-authored-by:` / `Signed-off-by:` trailer lines from a body for display. */
function stripTrailers(body: string): string {
  return body
    .split("\n")
    .filter((l) => !/^\s*(Co-authored-by|Signed-off-by):/i.test(l))
    .join("\n")
    .trim();
}
