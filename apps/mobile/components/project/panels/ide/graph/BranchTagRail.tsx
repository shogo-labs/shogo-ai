// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// The BRANCH / TAG column: ref pills aligned to the commit row each ref
// points at, with local / remote / tag iconography (GitKraken-style).

import { Check, GitBranch, Monitor, Rocket, Tag } from "lucide-react-native";

import type { GitRef } from "@shogo/shared-app/hooks";
import { ROW_HEIGHT, type DisplayRow } from "./types";

export function BranchTagRail({
  rows,
  currentBranch,
}: {
  rows: DisplayRow[];
  currentBranch: string | null;
}) {
  return (
    <div className="shrink-0 border-r border-[color:var(--ide-border)]" style={{ width: 200 }}>
      {rows.map((row, i) => (
        <div
          key={row.sha ?? `wip-${i}`}
          className="flex items-center gap-1 px-2 overflow-hidden"
          style={{ height: ROW_HEIGHT }}
        >
          {row.refs.map((ref) => (
            <RefPill key={`${ref.type}:${ref.name}`} refInfo={ref} isCurrent={ref.name === currentBranch} />
          ))}
        </div>
      ))}
    </div>
  );
}

function RefPill({ refInfo, isCurrent }: { refInfo: GitRef; isCurrent: boolean }) {
  if (refInfo.type === "HEAD") return null;

  const isTag = refInfo.type === "tag";
  const isRemote = refInfo.type === "remote";
  // The publish flow writes two kinds of tags (apps/api/src/routes/publish.ts):
  //   `published/<subdomain>`        stable pointer at the CURRENT live commit
  //   `publish/<subdomain>/<unix-ts>` immutable per-deploy history entry
  // Render the live pointer as a prominent green "Live" badge and the history
  // entries as muted "deploy" pills so the current deploy stands out.
  const isLivePointer = isTag && refInfo.name.startsWith("published/");
  const isPublishHistory = isTag && refInfo.name.startsWith("publish/");

  if (isLivePointer) {
    return (
      <span
        className="flex items-center gap-1 rounded px-1.5 h-[18px] max-w-[160px] border text-[11px]"
        style={{
          background: "color-mix(in srgb, var(--ide-success, #10b981) 18%, transparent)",
          borderColor: "var(--ide-success, #10b981)",
          color: "var(--ide-text-strong)",
        }}
        title={refInfo.name}
      >
        <Rocket size={10} className="shrink-0" style={{ color: "var(--ide-success, #10b981)" }} />
        <span className="truncate">Live: {tagSubdomain(refInfo.name)}</span>
      </span>
    );
  }

  if (isPublishHistory) {
    return (
      <span
        className="flex items-center gap-1 rounded px-1.5 h-[18px] max-w-[140px] border text-[11px]"
        style={{
          background: "var(--ide-surface)",
          borderColor: "var(--ide-border-strong)",
          color: "var(--ide-muted)",
        }}
        title={refInfo.name}
      >
        <Rocket size={10} className="shrink-0 text-[color:var(--ide-muted)]" />
        <span className="truncate">deploy</span>
      </span>
    );
  }

  return (
    <span
      className="flex items-center gap-1 rounded px-1.5 h-[18px] max-w-[160px] border text-[11px]"
      style={{
        background: isCurrent ? "var(--ide-active-bg)" : "var(--ide-surface)",
        borderColor: isCurrent ? "var(--ide-active-ring)" : "var(--ide-border-strong)",
        color: "var(--ide-text-strong)",
      }}
      title={refInfo.name}
    >
      {isCurrent && <Check size={10} className="shrink-0 text-emerald-400" />}
      {isTag ? (
        <Tag size={10} className="shrink-0 text-[color:var(--ide-warning)]" />
      ) : isRemote ? (
        <Monitor size={10} className="shrink-0 text-[color:var(--ide-muted)]" />
      ) : (
        <GitBranch size={10} className="shrink-0 text-[color:var(--ide-muted)]" />
      )}
      <span className="truncate">{shortName(refInfo.name)}</span>
    </span>
  );
}

function shortName(name: string): string {
  // origin/feature/foo -> feature/foo for display brevity.
  const slash = name.indexOf("/");
  if (slash !== -1 && /^(origin|upstream)\//.test(name)) {
    return name.slice(slash + 1);
  }
  return name;
}

function tagSubdomain(tagName: string): string {
  // published/<subdomain> or publish/<subdomain>/<unix-ts> -> <subdomain>
  const parts = tagName.split("/");
  return parts[1] ?? tagName;
}
