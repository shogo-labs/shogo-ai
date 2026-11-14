// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Shown when a root listing stayed truncated after the automatic retries. */
export function ExplorerIncompleteNotice({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div
      role="status"
      className="flex items-center justify-between gap-2 px-4 py-1.5 text-[12px] text-[color:var(--ide-muted)]"
    >
      <span>Some folders are still loading</span>
      <button
        type="button"
        onClick={onRefresh}
        className="rounded px-1 text-[color:var(--ide-text)] underline hover:text-[color:var(--ide-text-strong)]"
      >
        Refresh
      </button>
    </div>
  );
}
