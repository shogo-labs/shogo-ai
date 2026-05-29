// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Streaming wrappers for fetch / pull / push. Git writes progress to
// stderr in lines like:
//
//   remote: Counting objects:  74% (3/4)
//   Receiving objects:  47% (47/100), 1.23 MiB | 5.43 MiB/s
//   Resolving deltas:  20% (1/5)
//
// We parse percentages + the action label and emit structured
// `GitProgress` events. The IPC layer relays these to the renderer via a
// per-job channel so multiple operations can run concurrently without
// stepping on each other.

import { spawn } from "node:child_process";

import { getOrCreateGitWorkspace } from "./service";

export interface GitProgress {
  /** Best-guess phase, e.g. "Counting objects", "Receiving objects". */
  phase: string;
  /** 0..100 if known, else null (e.g. for "remote: <free text>"). */
  percent: number | null;
  /** Original raw stderr line, for the debug log surface. */
  raw: string;
}

export type StreamingResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface StreamingOptions {
  cwd: string;
  args: string[];
  timeoutMs?: number;
  onProgress: (p: GitProgress) => void;
}

const PROGRESS_RE = /^(?:remote:\s+)?([^:]+?):\s+(\d{1,3})%/;

export function runGitStreaming(opts: StreamingOptions): Promise<StreamingResult> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  return new Promise((resolve) => {
    const child = spawn("git", opts.args, {
      cwd: opts.cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Cap captured output per stream so a runaway remote can't OOM
    // main. 4 MiB is enormous for any normal fetch/pull/push — beyond
    // that we drop further bytes but keep the operation running so the
    // child can still complete successfully (vs. SIGKILLing it).
    const MAX_CAPTURE = 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let stderrBuf = "";
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* noop */ }
    }, timeoutMs);

    child.stdout.on("data", (b: Buffer) => {
      if (stdout.length < MAX_CAPTURE) stdout += b.toString("utf8");
    });
    child.stderr.on("data", (b: Buffer) => {
      const chunk = b.toString("utf8");
      if (stderr.length < MAX_CAPTURE) stderr += chunk;
      // Git uses CR to overwrite the same progress line — we split on
      // both \r and \n so we surface intermediate progress values. The
      // line-split buffer is capped separately so a no-newline remote
      // can't blow memory.
      if (stderrBuf.length > MAX_CAPTURE) stderrBuf = stderrBuf.slice(-1024);
      stderrBuf += chunk;
      let i: number;
      while ((i = Math.min(...nonNeg(stderrBuf.indexOf("\n"), stderrBuf.indexOf("\r")))) !== Infinity) {
        const line = stderrBuf.slice(0, i).trim();
        stderrBuf = stderrBuf.slice(i + 1);
        if (line) emit(line, opts.onProgress);
      }
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (stderrBuf.trim()) emit(stderrBuf.trim(), opts.onProgress);
      if (timedOut) {
        resolve({ ok: false, error: `timed out after ${timeoutMs}ms\n${stderr}` });
        return;
      }
      if (code === 0) resolve({ ok: true, output: stdout || stderr });
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
    });
    child.stdin.end();
  });
}

/**
 * Pure parser, exported for unit tests. Returns the structured progress
 * event for a single stderr line, or `null` for empty input.
 */
export function parseProgressLine(line: string): GitProgress | null {
  if (!line) return null;
  const m = PROGRESS_RE.exec(line);
  if (m) {
    return { phase: m[1].trim(), percent: clampPct(Number.parseInt(m[2], 10)), raw: line };
  }
  // Fall back to "phase only" for lines like `remote: Enumerating objects: 5, done.`
  const colon = line.indexOf(":");
  if (colon > 0) {
    return { phase: line.slice(0, colon).trim(), percent: null, raw: line };
  }
  return { phase: line, percent: null, raw: line };
}

function emit(line: string, onProgress: (p: GitProgress) => void): void {
  const p = parseProgressLine(line);
  if (p) onProgress(p);
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function nonNeg(...ns: number[]): number[] {
  const out = ns.filter((n) => n >= 0);
  return out.length ? out : [Infinity];
}

// --- Convenience wrappers --------------------------------------------

export interface FetchOpts { remote?: string; prune?: boolean; all?: boolean }
export async function fetchStreaming(root: string, opts: FetchOpts, onProgress: (p: GitProgress) => void): Promise<StreamingResult> {
  const args = ["fetch", "--progress"];
  if (opts.all) args.push("--all");
  if (opts.prune) args.push("--prune");
  if (opts.remote && !opts.all) args.push(opts.remote);
  const r = await runGitStreaming({ cwd: root, args, onProgress });
  getOrCreateGitWorkspace(root).requestRefresh();
  return r;
}

export interface PullOpts { remote?: string; branch?: string; rebase?: boolean; ffOnly?: boolean }
export async function pullStreaming(root: string, opts: PullOpts, onProgress: (p: GitProgress) => void): Promise<StreamingResult> {
  const args = ["pull", "--progress"];
  if (opts.rebase) args.push("--rebase");
  if (opts.ffOnly) args.push("--ff-only");
  if (opts.remote) args.push(opts.remote);
  if (opts.remote && opts.branch) args.push(opts.branch);
  const r = await runGitStreaming({ cwd: root, args, onProgress, timeoutMs: 240_000 });
  getOrCreateGitWorkspace(root).requestRefresh();
  return r;
}

export interface PushOpts { remote?: string; branch?: string; forceWithLease?: boolean; force?: boolean; tags?: boolean; setUpstream?: boolean }
export async function pushStreaming(root: string, opts: PushOpts, onProgress: (p: GitProgress) => void): Promise<StreamingResult> {
  const args = ["push", "--progress"];
  if (opts.setUpstream) args.push("-u");
  if (opts.forceWithLease) args.push("--force-with-lease");
  else if (opts.force) args.push("--force");
  if (opts.tags) args.push("--tags");
  if (opts.remote) args.push(opts.remote);
  if (opts.remote && opts.branch) args.push(opts.branch);
  const r = await runGitStreaming({ cwd: root, args, onProgress, timeoutMs: 240_000 });
  getOrCreateGitWorkspace(root).requestRefresh();
  return r;
}
