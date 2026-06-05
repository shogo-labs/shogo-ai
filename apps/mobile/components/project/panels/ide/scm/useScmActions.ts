// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Thin hook that wraps the desktop git bridge for the SCM viewlet. The
// bridge is the only place we talk to git; everything here is glue +
// optimistic refresh.

import { useCallback } from "react";

import { getDesktopGitBridge } from "../git/bridge";

export interface ScmActions {
  available: boolean;
  stage(paths: string[]): Promise<{ ok: boolean; error?: string }>;
  unstage(paths: string[]): Promise<{ ok: boolean; error?: string }>;
  discard(paths: string[]): Promise<{ ok: boolean; error?: string }>;
  commit(message: string, opts?: { amend?: boolean; signoff?: boolean }): Promise<{ ok: boolean; error?: string }>;
  commitAll(message: string, opts?: { amend?: boolean; signoff?: boolean }): Promise<{ ok: boolean; error?: string }>;
  commitAndPush(message: string, opts?: { amend?: boolean; signoff?: boolean }): Promise<{ ok: boolean; error?: string }>;
  commitAndSync(message: string, opts?: { amend?: boolean; signoff?: boolean }): Promise<{ ok: boolean; error?: string }>;
  undoLastCommit(): Promise<{ ok: boolean; error?: string }>;
  generateCommitMessage(): Promise<{ ok: boolean; message?: string; error?: string }>;
  fileContent(path: string, ref: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  refresh(): Promise<void>;
}

export function useScmActions(workspaceRoot: string | null): ScmActions {
  const bridge = getDesktopGitBridge();
  const available = bridge !== null && workspaceRoot !== null;

  const stage = useCallback(
    async (paths: string[]) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.stage(workspaceRoot, paths);
    },
    [bridge, workspaceRoot],
  );
  const unstage = useCallback(
    async (paths: string[]) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.unstage(workspaceRoot, paths);
    },
    [bridge, workspaceRoot],
  );
  const discard = useCallback(
    async (paths: string[]) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.discard(workspaceRoot, paths);
    },
    [bridge, workspaceRoot],
  );
  const commit = useCallback(
    async (message: string, opts?: { amend?: boolean; signoff?: boolean }) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.commit(workspaceRoot, message, opts);
    },
    [bridge, workspaceRoot],
  );
  const commitAll = useCallback(
    async (message: string, opts?: { amend?: boolean; signoff?: boolean }) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.commitAll(workspaceRoot, message, opts);
    },
    [bridge, workspaceRoot],
  );
  const commitAndPush = useCallback(
    async (message: string, opts?: { amend?: boolean; signoff?: boolean }) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.commitAndPush(workspaceRoot, message, opts);
    },
    [bridge, workspaceRoot],
  );
  const commitAndSync = useCallback(
    async (message: string, opts?: { amend?: boolean; signoff?: boolean }) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.commitAndSync(workspaceRoot, message, opts);
    },
    [bridge, workspaceRoot],
  );
  const undoLastCommit = useCallback(
    async () => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.undoLastCommit(workspaceRoot);
    },
    [bridge, workspaceRoot],
  );
  const fileContent = useCallback(
    async (path: string, ref: string) => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" };
      return bridge.fileContent(workspaceRoot, path, ref);
    },
    [bridge, workspaceRoot],
  );
  const generateCommitMessage = useCallback(
    async () => {
      if (!bridge || !workspaceRoot) return { ok: false, error: "unavailable" as const };
      const apiUrl = window.location.origin.includes("localhost") ? "http://localhost:37120" : window.location.origin;
      return bridge.generateCommitMessage(workspaceRoot, apiUrl);
    },
    [bridge, workspaceRoot],
  );
  const refresh = useCallback(async () => {
    if (!bridge || !workspaceRoot) return;
    await bridge.refresh(workspaceRoot);
  }, [bridge, workspaceRoot]);

  return { available, stage, unstage, discard, commit, commitAll, commitAndPush, commitAndSync, undoLastCommit, generateCommitMessage, fileContent, refresh };
}
