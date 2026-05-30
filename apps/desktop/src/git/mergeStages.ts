// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// Read the three index stages of a conflicted file so the renderer can
// build a VS Code–style 3-way merge editor.
//
//   stage 1 — common ancestor (BASE)
//   stage 2 — our side          (OURS / current branch)
//   stage 3 — their side        (THEIRS / branch being merged in)
//
// Any stage may be missing (e.g. add/add conflicts have no BASE). We
// surface that as `null` rather than throwing — the UI shows an empty
// pane for missing stages, matching VS Code behavior.

import { runGit } from "./repository";

export interface MergeStages {
  base: string | null;
  ours: string | null;
  theirs: string | null;
  working: string;
}

/** Cheap binary heuristic — a NUL byte in the first 8 KiB. */
export function looksBinary(s: string): boolean {
  const head = s.length > 8192 ? s.slice(0, 8192) : s;
  return head.indexOf("\u0000") !== -1;
}

async function readStage(root: string, stage: 1 | 2 | 3, relPath: string): Promise<string | null> {
  const res = await runGit(["show", `:${stage}:${relPath}`], { cwd: root });
  if (!res.ok) return null;
  if (looksBinary(res.stdout)) return null;
  return res.stdout;
}

export async function getMergeStages(
  root: string,
  relPath: string,
): Promise<{ ok: true; stages: MergeStages } | { ok: false; error: string }> {
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  let working = "";
  try {
    const buf = await readFile(join(root, relPath));
    working = buf.toString("utf8");
    if (looksBinary(working)) {
      return { ok: false, error: "binary file — merge editor only supports text" };
    }
  } catch (err: unknown) {
    // Working file deleted on disk is a legitimate state in
    // modify/delete conflicts — surface an empty working buffer rather
    // than failing the whole modal.
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") working = "";
    else return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const [base, ours, theirs] = await Promise.all([
    readStage(root, 1, relPath),
    readStage(root, 2, relPath),
    readStage(root, 3, relPath),
  ]);
  return { ok: true, stages: { base, ours, theirs, working } };
}
