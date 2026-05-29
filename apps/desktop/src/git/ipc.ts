// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// IPC surface for the git service. Mirrors `apps/desktop/src/fs-ipc.ts`
// conventions: single `registerGitIpcHandlers()` export, channels
// namespaced `git:*`, every workspaceRoot validated to live under $HOME
// before reaching git's spawn wrapper. Per-WebContents subscription
// bookkeeping prevents renderer reloads from leaking subscribers.

import { type IpcMainInvokeEvent, ipcMain, type WebContents } from "electron";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";

import {
  checkoutBranch,
  createBranch,
  deleteBranch,
  listBranches,
  publishBranch,
  renameBranch,
} from "./branches";
import {
  gitCommit,
  gitDiscard,
  gitFileContent,
  gitStage,
  gitUnstage,
} from "./operations";
import {
  fetchRemote,
  listRemotes,
  pullRemote,
  pushRemote,
  syncRemote,
} from "./remotes";
import { blameFile } from "./blame";
import { diffMarkers } from "./diffMarkers";
import { getMergeStages } from "./mergeStages";
import { revertHunk } from "./hunkRevert";
import { fetchStreaming, pullStreaming, pushStreaming, type GitProgress } from "./streaming";
import {
  listStashes,
  stashApply,
  stashDrop,
  stashPop,
  stashPush,
} from "./stash";
import {
  getProjectRoot,
  setProjectRoot,
  unsetProjectRoot,
} from "./projectRoots";
import { probeGit } from "./repository";
import {
  disposeAllGitWorkspaces,
  getOrCreateGitWorkspace,
  type GitSnapshot,
} from "./service";

const HOME = resolvePath(homedir());

interface SubInfo {
  workspaceRoot: string;
  webContents: WebContents;
  dispose: () => void;
}

const SUBSCRIPTIONS = new Map<string, SubInfo>(); // subId → info
let nextSubId = 1;

function isUnderHome(absPath: string): boolean {
  const resolved = resolvePath(absPath);
  return resolved === HOME || resolved.startsWith(HOME + "/");
}

function guard(workspaceRoot: unknown):
  | { ok: true; root: string }
  | { ok: false; reason: "invalid-input" | "outside-home" } {
  if (typeof workspaceRoot !== "string" || !workspaceRoot) {
    return { ok: false, reason: "invalid-input" };
  }
  const resolved = resolvePath(workspaceRoot);
  if (!isUnderHome(resolved)) return { ok: false, reason: "outside-home" };
  return { ok: true, root: resolved };
}

export function registerGitIpcHandlers(): void {
  const channels = [
    "git:probe",
    "git:subscribe",
    "git:unsubscribe",
    "git:refresh",
    "git:current",
    "git:setProjectRoot",
    "git:resolveProjectRoot",
    "git:unsetProjectRoot",
    "git:stage",
    "git:unstage",
    "git:discard",
    "git:commit",
    "git:fileContent",
    "git:branches.list",
    "git:branches.checkout",
    "git:branches.create",
    "git:branches.delete",
    "git:branches.rename",
    "git:branches.publish",
    "git:remotes.list",
    "git:remotes.fetch",
    "git:remotes.pull",
    "git:remotes.push",
    "git:remotes.sync",
    "git:stash.list",
    "git:stash.push",
    "git:stash.apply",
    "git:stash.pop",
    "git:stash.drop",
    "git:diffMarkers",
    "git:blame",
    "git:mergeStages",
    "git:revertHunk",
    "git:remotes.fetchStreaming",
    "git:remotes.pullStreaming",
    "git:remotes.pushStreaming",
  ];
  for (const ch of channels) {
    if (ipcMain.eventNames().includes(ch)) ipcMain.removeHandler(ch);
  }

  // --- Probe ---------------------------------------------------------
  ipcMain.handle("git:probe", async () => {
    const probe = await probeGit();
    return { ok: true, ...probe };
  });

  // --- Subscribe / unsubscribe / refresh / current -------------------
  ipcMain.handle(
    "git:subscribe",
    async (event: IpcMainInvokeEvent, args: { workspaceRoot: string }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const ws = getOrCreateGitWorkspace(g.root);
      const subId = `sub-${nextSubId++}`;
      const webContents = event.sender;
      const channel = `git:status:${subId}`;
      const dispose = ws.subscribe((snap: GitSnapshot) => {
        if (webContents.isDestroyed()) return;
        try {
          webContents.send(channel, snap);
        } catch (err) {
          console.warn("[shogo-git] send error", err);
        }
      });
      const cleanup = (): void => {
        dispose();
        SUBSCRIPTIONS.delete(subId);
      };
      webContents.once("destroyed", cleanup);
      SUBSCRIPTIONS.set(subId, { workspaceRoot: g.root, webContents, dispose: cleanup });
      return { ok: true as const, subId, channel };
    },
  );

  ipcMain.handle("git:unsubscribe", async (_event, args: { subId: string }) => {
    const info = SUBSCRIPTIONS.get(args?.subId);
    if (!info) return { ok: false as const, reason: "unknown-sub" as const };
    info.dispose();
    return { ok: true as const };
  });

  ipcMain.handle("git:refresh", async (_event, args: { workspaceRoot: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    getOrCreateGitWorkspace(g.root).requestRefresh();
    return { ok: true as const };
  });

  ipcMain.handle("git:current", async (_event, args: { workspaceRoot: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    return { ok: true as const, snapshot: getOrCreateGitWorkspace(g.root).current() };
  });

  // --- Project-root registry -----------------------------------------
  // Lets the renderer hand the main process the absolute path of a
  // folder-bound project right after `POST /from-folders` returns. This
  // closes the G1 gap where `fs.resolveWorkspace` returned `not-managed`
  // for externally-opened folders.
  ipcMain.handle(
    "git:setProjectRoot",
    async (_event, args: { projectId: string; root: string }) => {
      const g = guard(args?.root);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      if (typeof args.projectId !== "string" || !args.projectId) {
        return { ok: false as const, reason: "invalid-input" as const };
      }
      setProjectRoot(args.projectId, g.root);
      return { ok: true as const };
    },
  );

  ipcMain.handle("git:unsetProjectRoot", async (_event, args: { projectId: string }) => {
    if (typeof args?.projectId !== "string" || !args.projectId) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    unsetProjectRoot(args.projectId);
    return { ok: true as const };
  });

  ipcMain.handle("git:resolveProjectRoot", async (_event, args: { projectId: string }) => {
    if (typeof args?.projectId !== "string" || !args.projectId) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const root = getProjectRoot(args.projectId);
    if (!root) return { ok: false as const, reason: "unknown-project" as const };
    return { ok: true as const, root };
  });

  // --- Write operations ----------------------------------------------
  ipcMain.handle(
    "git:stage",
    async (_event, args: { workspaceRoot: string; paths: string[] }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const res = await gitStage(g.root, args.paths ?? []);
      return res.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: res.error };
    },
  );

  ipcMain.handle(
    "git:unstage",
    async (_event, args: { workspaceRoot: string; paths: string[] }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const res = await gitUnstage(g.root, args.paths ?? []);
      return res.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: res.error };
    },
  );

  ipcMain.handle(
    "git:discard",
    async (_event, args: { workspaceRoot: string; paths: string[] }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const res = await gitDiscard(g.root, args.paths ?? []);
      return res.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: res.error };
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_event, args: { workspaceRoot: string; message: string; amend?: boolean; signoff?: boolean }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const res = await gitCommit(g.root, {
        message: typeof args.message === "string" ? args.message : "",
        amend: !!args.amend,
        signoff: !!args.signoff,
      });
      return res.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: res.error };
    },
  );

  // --- Diff / file content -------------------------------------------
  ipcMain.handle(
    "git:fileContent",
    async (_event, args: { workspaceRoot: string; path: string; ref: string }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      if (typeof args.path !== "string" || !args.path) {
        return { ok: false as const, reason: "invalid-input" as const };
      }
      const ref = typeof args.ref === "string" && args.ref ? args.ref : "HEAD";
      const res = await gitFileContent(g.root, args.path, ref);
      return res.ok
        ? { ok: true as const, content: res.content }
        : { ok: false as const, reason: "git-error" as const, error: res.error };
    },
  );

  // --- Branches (G3) -------------------------------------------------
  ipcMain.handle("git:branches.list", async (_event, args: { workspaceRoot: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    return listBranches(g.root);
  });
  ipcMain.handle("git:branches.checkout", async (_event, args: { workspaceRoot: string; name: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.name !== "string" || !args.name) return { ok: false as const, reason: "invalid-input" as const };
    const r = await checkoutBranch(g.root, args.name);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:branches.create", async (_event, args: { workspaceRoot: string; name: string; base?: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.name !== "string" || !args.name) return { ok: false as const, reason: "invalid-input" as const };
    const r = await createBranch(g.root, args.name, args.base);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:branches.delete", async (_event, args: { workspaceRoot: string; name: string; force?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.name !== "string" || !args.name) return { ok: false as const, reason: "invalid-input" as const };
    const r = await deleteBranch(g.root, args.name, { force: !!args.force });
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:branches.rename", async (_event, args: { workspaceRoot: string; oldName: string; newName: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (!args.oldName || !args.newName) return { ok: false as const, reason: "invalid-input" as const };
    const r = await renameBranch(g.root, args.oldName, args.newName);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:branches.publish", async (_event, args: { workspaceRoot: string; branch: string; remote?: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (!args.branch) return { ok: false as const, reason: "invalid-input" as const };
    const r = await publishBranch(g.root, args.branch, args.remote);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });

  // --- Remotes (G3) --------------------------------------------------
  ipcMain.handle("git:remotes.list", async (_event, args: { workspaceRoot: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    return listRemotes(g.root);
  });
  ipcMain.handle("git:remotes.fetch", async (_event, args: { workspaceRoot: string; remote?: string; prune?: boolean; all?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    const r = await fetchRemote(g.root, { remote: args.remote, prune: !!args.prune, all: !!args.all });
    return r.ok ? { ok: true as const, output: r.stdout } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:remotes.pull", async (_event, args: { workspaceRoot: string; remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    const r = await pullRemote(g.root, { remote: args.remote, branch: args.branch, rebase: !!args.rebase, ffOnly: !!args.ffOnly });
    return r.ok ? { ok: true as const, output: r.stdout } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:remotes.push", async (_event, args: { workspaceRoot: string; remote?: string; branch?: string; force?: boolean; forceWithLease?: boolean; tags?: boolean; setUpstream?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    const r = await pushRemote(g.root, args);
    return r.ok ? { ok: true as const, output: r.stdout } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:remotes.sync", async (_event, args: { workspaceRoot: string; remote?: string; branch?: string; rebase?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    const r = await syncRemote(g.root, { remote: args.remote, branch: args.branch, rebase: !!args.rebase });
    return r.ok ? { ok: true as const, output: r.stdout } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });

  // --- Stash (G3) ----------------------------------------------------
  ipcMain.handle("git:stash.list", async (_event, args: { workspaceRoot: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    return listStashes(g.root);
  });
  ipcMain.handle("git:stash.push", async (_event, args: { workspaceRoot: string; message?: string; keepIndex?: boolean; includeUntracked?: boolean }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    const r = await stashPush(g.root, { message: args.message, keepIndex: !!args.keepIndex, includeUntracked: !!args.includeUntracked });
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:stash.apply", async (_event, args: { workspaceRoot: string; ref: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (!args.ref) return { ok: false as const, reason: "invalid-input" as const };
    const r = await stashApply(g.root, args.ref);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:stash.pop", async (_event, args: { workspaceRoot: string; ref: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (!args.ref) return { ok: false as const, reason: "invalid-input" as const };
    const r = await stashPop(g.root, args.ref);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:stash.drop", async (_event, args: { workspaceRoot: string; ref: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (!args.ref) return { ok: false as const, reason: "invalid-input" as const };
    const r = await stashDrop(g.root, args.ref);
    return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  // --- G4: per-file diff markers + blame ----------------------------
  ipcMain.handle("git:diffMarkers", async (_event, args: { workspaceRoot: string; path: string; base?: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.path !== "string" || !args.path) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const r = await diffMarkers(g.root, args.path, args.base ?? "HEAD");
    return r.ok
      ? { ok: true as const, markers: r.markers }
      : { ok: false as const, reason: "git-error" as const, error: r.error };
  });
  ipcMain.handle("git:blame", async (_event, args: { workspaceRoot: string; path: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.path !== "string" || !args.path) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const r = await blameFile(g.root, args.path);
    return r.ok
      ? { ok: true as const, lines: r.lines }
      : { ok: false as const, reason: "git-error" as const, error: r.error };
  });

  // --- G4.5: 3-way merge stages -------------------------------------
  ipcMain.handle("git:mergeStages", async (_event, args: { workspaceRoot: string; path: string }) => {
    const g = guard(args?.workspaceRoot);
    if (!g.ok) return { ok: false as const, reason: g.reason };
    if (typeof args.path !== "string" || !args.path) {
      return { ok: false as const, reason: "invalid-input" as const };
    }
    const r = await getMergeStages(g.root, args.path);
    return r.ok
      ? { ok: true as const, stages: r.stages }
      : { ok: false as const, reason: "git-error" as const, error: r.error };
  });

  // --- G4.5: per-hunk revert ----------------------------------------
  ipcMain.handle(
    "git:revertHunk",
    async (_event, args: {
      workspaceRoot: string;
      path: string;
      workingStart: number;
      workingEnd: number;
      headStart: number | null;
      headEnd: number | null;
    }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      if (typeof args.path !== "string" || !args.path) {
        return { ok: false as const, reason: "invalid-input" as const };
      }
      const r = await revertHunk(g.root, args.path, {
        workingStart: args.workingStart,
        workingEnd: args.workingEnd,
        headStart: args.headStart,
        headEnd: args.headEnd,
      });
      return r.ok ? { ok: true as const } : { ok: false as const, reason: "git-error" as const, error: r.error };
    },
  );

  // --- G3.5: streaming fetch / pull / push --------------------------
  // The renderer passes a jobId; we send `git:progress:<jobId>` events
  // until completion. Caller subscribes to that channel before invoking.
  let nextJobId = 1;
  function withProgress(
    event: IpcMainInvokeEvent,
    jobId: string,
  ): (p: GitProgress) => void {
    const webContents = event.sender;
    const channel = `git:progress:${jobId}`;
    return (p: GitProgress) => {
      if (webContents.isDestroyed()) return;
      try { webContents.send(channel, p); } catch { /* renderer gone */ }
    };
  }
  ipcMain.handle(
    "git:remotes.fetchStreaming",
    async (event, args: { workspaceRoot: string; remote?: string; prune?: boolean; all?: boolean; jobId?: string }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const jobId = args.jobId || `job-${nextJobId++}`;
      const r = await fetchStreaming(g.root, { remote: args.remote, prune: !!args.prune, all: !!args.all }, withProgress(event, jobId));
      return r.ok ? { ok: true as const, jobId, output: r.output } : { ok: false as const, reason: "git-error" as const, error: r.error };
    },
  );
  ipcMain.handle(
    "git:remotes.pullStreaming",
    async (event, args: { workspaceRoot: string; remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean; jobId?: string }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const jobId = args.jobId || `job-${nextJobId++}`;
      const r = await pullStreaming(g.root, { remote: args.remote, branch: args.branch, rebase: !!args.rebase, ffOnly: !!args.ffOnly }, withProgress(event, jobId));
      return r.ok ? { ok: true as const, jobId, output: r.output } : { ok: false as const, reason: "git-error" as const, error: r.error };
    },
  );
  ipcMain.handle(
    "git:remotes.pushStreaming",
    async (event, args: { workspaceRoot: string; remote?: string; branch?: string; forceWithLease?: boolean; force?: boolean; tags?: boolean; setUpstream?: boolean; jobId?: string }) => {
      const g = guard(args?.workspaceRoot);
      if (!g.ok) return { ok: false as const, reason: g.reason };
      const jobId = args.jobId || `job-${nextJobId++}`;
      const r = await pushStreaming(g.root, args, withProgress(event, jobId));
      return r.ok ? { ok: true as const, jobId, output: r.output } : { ok: false as const, reason: "git-error" as const, error: r.error };
    },
  );
}

export function disposeGitIpc(): void {
  for (const info of SUBSCRIPTIONS.values()) info.dispose();
  SUBSCRIPTIONS.clear();
  disposeAllGitWorkspaces();
}
