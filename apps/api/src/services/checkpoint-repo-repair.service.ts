// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Boot-time sweep that reclaims the history already on disk from checkpoint
 * repos that committed Shogo's own runtime state (SHO-105 / #1597).
 *
 * `checkpoint-repo-repair.ts` in shared-runtime owns the rewrite; this file owns
 * the desktop/server plumbing around it: which directories to visit, the
 * `ProjectCheckpoint.commitSha` remap after a history rewrite, and the
 * environment kill switches.
 *
 * Runs once per boot, in the background, sequentially. Every repo it skips is
 * retried on the next boot (busy, low disk, or a git failure), and a repo it
 * finishes carries a marker so it is never rewritten twice.
 *
 *   SHOGO_SKIP_CHECKPOINT_REPAIR=1   no-op
 *   SHOGO_CHECKPOINT_REPAIR=dry      measure and log, change nothing
 */

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  readRepairMarker,
  repairCheckpointRepo,
  type RepairResult,
} from '@shogo/shared-runtime/checkpoint-repo-repair';
import { directorySizeBytes, resolveGitDir } from '@shogo/shared-runtime/shogo-state-paths';
import { prisma } from '../lib/prisma';

export interface SweepOptions {
  /** `workspaces/` root: `.workspace-roots/*` and `<projectId>` live under it. */
  workspacesDir: string;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** Number of checkpoints remapped per `IN (...)` chunk. */
  remapChunkSize?: number;
}

export interface SweepSummary {
  scanned: number;
  repaired: number;
  skipped: number;
  bytesBefore: number;
  bytesAfter: number;
  results: RepairResult[];
}

/** Project id for a repo directory: `.workspace-roots/proj-<id>` or `<id>`. */
export function projectIdForRepoDir(repoDir: string): string | null {
  const base = repoDir.split(/[\\/]/).pop() ?? '';
  const id = base.startsWith('proj-') ? base.slice('proj-'.length) : base;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

/** Default floor: a repo whose `.git` is under this is not worth rewriting. */
export const DEFAULT_REPAIR_MIN_MB = 200;

/** `.git` size (MB) below which a repo is left to the per-turn index pass. */
export function repairMinBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = parseFloat(env.SHOGO_CHECKPOINT_REPAIR_MIN_MB || '');
  const mb = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_REPAIR_MIN_MB;
  return mb * 1024 * 1024;
}

/**
 * Every checkpoint repo under `<workspacesDir>` worth rewriting: the merged
 * workspace roots in `.workspace-roots/` (the repos that actually grow — one per
 * workspace and one per attached project) plus any per-project checkout directly
 * under it.
 *
 * Two cheap gates keep this to a handful of repos: an already-repaired repo is
 * skipped on its marker (one file read), and a repo is only a candidate once its
 * `.git` passes {@link repairMinBytes}. Repos below the floor are still covered —
 * `prepareCheckpointRepo` untracks them on every turn — they just do not justify
 * a rewrite of their history.
 */
export function listCheckpointRepos(
  workspacesDir: string,
  opts: { minBytes?: number } = {},
): string[] {
  const minBytes = opts.minBytes ?? repairMinBytes();
  const out: string[] = [];
  const add = (dir: string) => {
    if (!resolveGitDir(dir)) return;
    if (readRepairMarker(dir)) return;
    if (directorySizeBytes(join(dir, '.git')) < minBytes) return;
    out.push(dir);
  };

  const rootsDir = join(workspacesDir, '.workspace-roots');
  for (const base of [rootsDir, workspacesDir]) {
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.workspace-roots') continue;
      add(join(base, entry.name));
    }
  }
  return out;
}

/**
 * Rewrite `ProjectCheckpoint.commitSha` for the commits a repair changed. The
 * ref-mode rows keep their `refName` — `fast-import` recreates refs under the
 * names `fast-export` emitted, so the pin is still there, just pointing at the
 * rewritten commit.
 */
export async function remapCheckpointCommitShas(
  projectId: string,
  remap: Map<string, string>,
  chunkSize = 400,
): Promise<number> {
  if (remap.size === 0) return 0;
  const olds = [...remap.keys()];
  let updated = 0;
  for (let i = 0; i < olds.length; i += chunkSize) {
    const chunk = olds.slice(i, i + chunkSize);
    const rows = await prisma.projectCheckpoint.findMany({
      where: { projectId, commitSha: { in: chunk } },
      select: { id: true, commitSha: true },
    });
    for (const row of rows) {
      const next = remap.get(row.commitSha);
      if (!next || next === row.commitSha) continue;
      await prisma.projectCheckpoint.update({
        where: { id: row.id },
        data: { commitSha: next },
      });
      updated += 1;
    }
  }
  return updated;
}

/**
 * Repair every bloated checkpoint repo under `workspacesDir`, one at a time so
 * a sweep never competes with itself for disk. Never throws.
 */
export async function sweepCheckpointRepos(opts: SweepOptions): Promise<SweepSummary> {
  const log = opts.logger ?? console;
  const summary: SweepSummary = {
    scanned: 0, repaired: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, results: [],
  };
  if (process.env.SHOGO_SKIP_CHECKPOINT_REPAIR === '1') {
    log.log('[checkpoint-repair] disabled by SHOGO_SKIP_CHECKPOINT_REPAIR');
    return summary;
  }
  if (!existsSync(opts.workspacesDir)) return summary;

  const repos = listCheckpointRepos(opts.workspacesDir);
  summary.scanned = repos.length;
  if (repos.length === 0) return summary;

  for (const repoDir of repos) {
    const projectId = projectIdForRepoDir(repoDir);
    const result = await repairCheckpointRepo(repoDir, {
      logger: log,
      onRemap: projectId
        ? async (remap) => {
            const updated = await remapCheckpointCommitShas(projectId, remap, opts.remapChunkSize);
            if (updated > 0) {
              log.log(`[checkpoint-repair] ${projectId}: remapped ${updated} checkpoint row(s)`);
            }
          }
        : undefined,
    });
    summary.results.push(result);
    if (result.skipped) summary.skipped += 1;
    else summary.repaired += 1;
    summary.bytesBefore += result.bytesBefore;
    summary.bytesAfter += result.bytesAfter;
  }

  const reclaimed = summary.bytesBefore - summary.bytesAfter;
  log.log(
    `[checkpoint-repair] sweep done: ${summary.repaired} repaired, ${summary.skipped} left alone, ` +
      `.git/lfs ${(summary.bytesBefore / 1e9).toFixed(2)}GB -> ${(summary.bytesAfter / 1e9).toFixed(2)}GB ` +
      `(${(reclaimed / 1e9).toFixed(2)}GB reclaimed)`,
  );
  return summary;
}

/**
 * Kick the sweep off in the background. Called once from the API bootstrap; a
 * second call in the same process is a no-op, so a route that re-uses it cannot
 * start two rewrites of the same repo.
 *
 * `initialDelayMs` keeps the boot responsive: the sweep walks every repo's
 * `.git` and rewrites several gigabytes, neither of which belongs in front of
 * the first request.
 */
let running: Promise<SweepSummary> | null = null;
export function startCheckpointRepoRepair(
  workspacesDir: string,
  opts: { initialDelayMs?: number } = {},
): Promise<SweepSummary> {
  if (running) return running;
  const delay = opts.initialDelayMs ?? 60_000;
  running = new Promise<void>((resolve) => {
    if (delay > 0) setTimeout(resolve, delay).unref?.();
    else resolve();
  })
    .then(() => sweepCheckpointRepos({ workspacesDir }))
    .catch((err: any) => {
      console.warn(`[checkpoint-repair] sweep failed: ${err?.message ?? err}`);
      return {
        scanned: 0, repaired: 0, skipped: 0, bytesBefore: 0, bytesAfter: 0, results: [],
      } as SweepSummary;
    });
  return running;
}

/** Test hook: forget the in-flight sweep so a test can start a fresh one. */
export function __resetCheckpointRepairForTests(): void {
  running = null;
}
