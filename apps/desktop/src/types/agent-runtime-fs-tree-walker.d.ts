// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Type shim for `@shogo/agent-runtime/src/fs-tree-walker` consumed by the
 * desktop's Electron main process.
 *
 * Why a shim instead of importing the source file directly: apps/desktop/
 * tsconfig.json sets `rootDir: src`, and TS would otherwise pull
 * `packages/agent-runtime/src/fs-tree-walker.ts` into the desktop's
 * compilation unit — which violates rootDir and trips TS6059. (Commit
 * 914fa17e introduced the cross-rootDir import directly and broke the
 * desktop build for v1.8.0 and v1.8.1 release attempts.)
 *
 * Mirrors the existing pattern in `shogo-worker-cloud-login.d.ts`: an
 * ambient module declaration here gives tsc the types it needs to
 * typecheck `fs-ipc.ts`, while `scripts/bundle-main.mjs` symlinks
 * `node_modules/@shogo/agent-runtime` -> `packages/agent-runtime` so
 * `bun build` resolves and inlines the real implementation into
 * `dist/main.js` at bundle time. apps/desktop is npm-installed (not a
 * bun workspace member), so without that symlink Bun can't resolve the
 * import either.
 *
 * This file MUST stay structurally compatible with the public surface
 * exported by `packages/agent-runtime/src/fs-tree-walker.ts`. The actual
 * runtime implementation comes from there — this file is types-only.
 * If you add or change an export there, mirror the change here.
 */
declare module '@shogo/agent-runtime/src/fs-tree-walker' {
  export interface WorkspaceTreeNode {
    name: string;
    path: string;
    type: 'file' | 'directory';
    /** Last-modified time as a Unix epoch in milliseconds. */
    modified: number;
    /** File size in bytes; only set for files. */
    size?: number;
    /** Walked children; undefined for files and for `lazy: true` directories. */
    children?: WorkspaceTreeNode[];
    /**
     * True on directories whose children intentionally weren't walked
     * (members of `WORKSPACE_TREE_LAZY_DIRS`). Callers should fetch
     * children on demand by re-invoking `walkFilesTree` rooted at the
     * directory's absolute path.
     */
    lazy?: boolean;
  }

  export const WORKSPACE_TREE_HIDDEN_DIRS: ReadonlySet<string>;
  export const WORKSPACE_TREE_LAZY_DIRS: ReadonlySet<string>;
  export const WORKSPACE_TREE_HIDDEN_FILES: ReadonlySet<string>;

  export function walkFilesTree(
    dir: string,
    rootDir: string,
    hiddenDirs?: ReadonlySet<string>,
    lazyDirs?: ReadonlySet<string>,
    hiddenFiles?: ReadonlySet<string>,
  ): WorkspaceTreeNode[];
}
