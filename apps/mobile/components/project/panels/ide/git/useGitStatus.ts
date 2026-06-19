// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// React hook that subscribes a single workspace root to the desktop git
// service and re-renders consumers whenever a new porcelain snapshot
// arrives. Returns `null` on non-desktop platforms so callers can render
// a no-op without conditional rendering — this is the seam that keeps git
// strictly desktop-only.

import { useEffect, useState } from "react";

import { getDesktopGitBridge, type GitSnapshot } from "./bridge";

const EMPTY_SNAPSHOT: GitSnapshot = {
  workspaceRoot: "",
  isRepo: false,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  fileStatus: {},
  stagedStatus: {},
  fileChanges: {},
  conflictPaths: [],
  refreshedAt: 0,
  error: null,
};

/**
 * Subscribe to git status updates for `workspaceRoot`. Pass `null` to
 * opt-out (returns null without subscribing). On non-desktop platforms
 * the bridge is absent and the hook short-circuits to null.
 */
export function useGitStatus(workspaceRoot: string | null): GitSnapshot | null {
  const [snapshot, setSnapshot] = useState<GitSnapshot | null>(null);

  useEffect(() => {
    if (!workspaceRoot) {
      setSnapshot(null);
      return;
    }
    const bridge = getDesktopGitBridge();
    if (!bridge) {
      setSnapshot(null);
      return;
    }

    let disposed = false;
    let subId: string | null = null;
    let channel: string | null = null;

    void bridge
      .subscribe(workspaceRoot, (snap) => {
        if (disposed) return;
        setSnapshot(snap);
      })
      .then((result) => {
        if (disposed) return;
        if (result.ok && result.subId && result.channel) {
          subId = result.subId;
          channel = result.channel;
        } else {
          // Surface the failure as an empty-but-stamped snapshot so the
          // status bar can show "git: <reason>" if it wants.
          setSnapshot({
            ...EMPTY_SNAPSHOT,
            workspaceRoot,
            error: result.reason ?? "subscribe-failed",
            refreshedAt: Date.now(),
          });
        }
      });

    return () => {
      disposed = true;
      if (subId && channel) {
        void bridge.unsubscribe(subId, channel);
      }
    };
  }, [workspaceRoot]);

  return snapshot;
}

/**
 * Convenience selector: returns the status code for a single relative
 * path within the snapshot, or null if no entry exists (= clean / not
 * tracked by git for our purposes).
 */
export function getFileStatusFrom(
  snapshot: GitSnapshot | null,
  relPath: string,
): import("./bridge").GitShortCode | null {
  if (!snapshot) return null;
  return snapshot.fileStatus[relPath] ?? null;
}
