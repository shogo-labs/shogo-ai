// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Remote operations: fetch / pull / push. Long-running so we:
//   - bump the timeout (default 2 min, vs 15 s for local ops);
//   - skip the on-completion refresh debounce so the StatusBar updates
//     instantly when the user pulls;
//   - return the raw stderr on failure because git's remote errors are
//     where the actionable info lives ("Updates were rejected", "Auth
//     failed", "no upstream configured", etc.) and the UI surfaces it.
//
// Credentials are NOT handled by us — we set GIT_TERMINAL_PROMPT=0 in
// runGit() so git falls through to the user's configured credential
// helper (osxkeychain / wincred / libsecret / etc). If the helper isn't
// configured, push/pull fails fast instead of hanging on stdin.

import { runGit } from "./repository";
import { getOrCreateGitWorkspace } from "./service";
import { isSafeRefArg } from "./validate";

type OpResult = { ok: true; stdout: string } | { ok: false; error: string };

const REJECT: OpResult = { ok: false, error: "invalid remote or branch name" };

export async function listRemotes(root: string): Promise<{ ok: true; remotes: string[] } | { ok: false; error: string }> {
  const res = await runGit(["remote"], { cwd: root });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git remote exit ${res.code}` };
  return {
    ok: true,
    remotes: res.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export async function fetchRemote(
  root: string,
  opts?: { remote?: string; prune?: boolean; all?: boolean },
): Promise<OpResult> {
  if (opts?.remote !== undefined && !isSafeRefArg(opts.remote)) return REJECT;
  const args = ["fetch"];
  if (opts?.all) args.push("--all");
  if (opts?.prune) args.push("--prune");
  if (opts?.remote && !opts.all) args.push(opts.remote);
  const res = await runGit(args, { cwd: root, timeoutMs: 120_000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git fetch exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true, stdout: res.stdout + res.stderr };
}

export async function pullRemote(
  root: string,
  opts?: { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean },
): Promise<OpResult> {
  if (opts?.remote !== undefined && !isSafeRefArg(opts.remote)) return REJECT;
  if (opts?.branch !== undefined && !isSafeRefArg(opts.branch)) return REJECT;
  const args = ["pull"];
  if (opts?.rebase) args.push("--rebase");
  if (opts?.ffOnly) args.push("--ff-only");
  if (opts?.remote) args.push(opts.remote);
  if (opts?.branch) args.push(opts.branch);
  const res = await runGit(args, { cwd: root, timeoutMs: 180_000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || `git pull exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true, stdout: res.stdout + res.stderr };
}

export async function pushRemote(
  root: string,
  opts?: { remote?: string; branch?: string; force?: boolean; forceWithLease?: boolean; tags?: boolean; setUpstream?: boolean },
): Promise<OpResult> {
  if (opts?.remote !== undefined && !isSafeRefArg(opts.remote)) return REJECT;
  if (opts?.branch !== undefined && !isSafeRefArg(opts.branch)) return REJECT;
  const args = ["push"];
  if (opts?.force && !opts.forceWithLease) args.push("--force");
  if (opts?.forceWithLease) args.push("--force-with-lease");
  if (opts?.tags) args.push("--tags");
  if (opts?.setUpstream) args.push("-u");
  if (opts?.remote) args.push(opts.remote);
  if (opts?.branch) args.push(opts.branch);
  const res = await runGit(args, { cwd: root, timeoutMs: 180_000 });
  if (!res.ok) return { ok: false, error: res.stderr.trim() || res.stdout.trim() || `git push exit ${res.code}` };
  getOrCreateGitWorkspace(root).requestRefresh();
  return { ok: true, stdout: res.stdout + res.stderr };
}

/**
 * One-shot sync: fetch → pull (ff-only) → push. Mirrors the VS Code
 * "Sync Changes" button. Aborts on the first failure and returns its
 * error verbatim.
 */
export async function syncRemote(
  root: string,
  opts?: { remote?: string; branch?: string; rebase?: boolean },
): Promise<OpResult> {
  const fetched = await fetchRemote(root, { remote: opts?.remote });
  if (!fetched.ok) return fetched;
  const pulled = await pullRemote(root, { remote: opts?.remote, branch: opts?.branch, rebase: opts?.rebase, ffOnly: !opts?.rebase });
  if (!pulled.ok) return pulled;
  const pushed = await pushRemote(root, { remote: opts?.remote, branch: opts?.branch });
  if (!pushed.ok) return pushed;
  return { ok: true, stdout: `${fetched.stdout}\n${pulled.stdout}\n${pushed.stdout}` };
}
