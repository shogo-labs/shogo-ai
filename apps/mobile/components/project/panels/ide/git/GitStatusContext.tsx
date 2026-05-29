// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// React context that publishes the current git snapshot down the
// Workbench tree so leaf views (FileTree decorations, StatusBar branch
// segment) can read it without prop-drilling.
//
// The provider is mounted by Workbench.tsx once the absolute workspace
// root is known. On non-desktop platforms (web / native) the root will be
// null, `useGitStatus` returns null, and `value` stays null — consumers
// render nothing.

import { createContext, type ReactNode, useContext, useMemo } from "react";

import type { GitShortCode, GitSnapshot } from "./bridge";

interface GitStatusContextValue {
  snapshot: GitSnapshot | null;
  getStatus(relPath: string): GitShortCode | null;
  /** True if any descendant of `relPath/` has a non-clean status. */
  folderDirty(relPath: string): boolean;
}

const noopValue: GitStatusContextValue = {
  snapshot: null,
  getStatus: () => null,
  folderDirty: () => false,
};

const GitStatusContext = createContext<GitStatusContextValue>(noopValue);

export function GitStatusProvider({
  snapshot,
  children,
}: {
  snapshot: GitSnapshot | null;
  children: ReactNode;
}) {
  const value = useMemo<GitStatusContextValue>(() => {
    if (!snapshot || !snapshot.isRepo) return noopValue;
    const map = snapshot.fileStatus;
    return {
      snapshot,
      getStatus: (relPath: string): GitShortCode | null => map[relPath] ?? null,
      folderDirty: (relPath: string): boolean => {
        const prefix = relPath.endsWith("/") ? relPath : relPath + "/";
        for (const k in map) {
          if (k === relPath) return true;
          if (k.startsWith(prefix)) return true;
        }
        return false;
      },
    };
  }, [snapshot]);
  return (
    <GitStatusContext.Provider value={value}>
      {children}
    </GitStatusContext.Provider>
  );
}

export function useGitStatusContext(): GitStatusContextValue {
  return useContext(GitStatusContext);
}
