// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo project checkout <projectId> [--at <sha|name>] [--unshallow]`
 *
 * Rolls the worker's local copy of a project back (or forward) to a
 * specific git checkpoint. By default this targets the project's
 * current cloud HEAD — i.e. it's the worker-side equivalent of
 * `git pull --rebase`.
 *
 * `--at` accepts:
 *   - A full or short SHA (anything `git rev-parse` can resolve).
 *   - A checkpoint name (resolved against
 *     `GET /api/projects/:projectId/checkpoints?limit=…`).
 *
 * `--unshallow` first converts the local repo from a shallow clone to
 * a full clone — necessary when checking out a historical SHA that
 * lives beyond the original `--depth=1` window.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { resolveConfig } from '../lib/config.ts';
import { projectDirFor } from '../lib/paths.ts';
import {
  gitFetchAndReset,
  gitFetchUnshallow,
  isGitRepo,
  runGit,
} from '../lib/git-cloner.ts';

export interface ProjectCheckoutFlags {
  /** SHA or checkpoint name. Defaults to remote HEAD. */
  at?: string;
  /** Convert a shallow clone to a full one before checking out. */
  unshallow?: boolean;
  /** Local dir override. */
  into?: string;
  /** API key override. */
  apiKey?: string;
  /** Cloud URL override. */
  cloudUrl?: string;
}

export async function runProjectCheckout(projectId: string, flags: ProjectCheckoutFlags): Promise<void> {
  if (!projectId) throw new Error('projectId is required');

  const cfg = resolveConfig({
    apiKey: flags.apiKey,
    cloudUrl: flags.cloudUrl,
  });

  const localDir = resolve(flags.into ?? projectDirFor(projectId, cfg.projectsDir));
  if (!existsSync(localDir)) {
    throw new Error(`Local project dir does not exist: ${localDir} — run \`shogo project pull\` first`);
  }
  if (!isGitRepo(localDir)) {
    throw new Error(
      `${localDir} is not a git repo. \`shogo project checkout\` requires the git sync path; ` +
        `run \`shogo project pull\` after installing git, or use \`shogo project pull --include\` for file-only restore.`,
    );
  }

  console.log(pc.bold(`\nshogo project checkout ${pc.cyan(projectId)}`));
  console.log(pc.dim('  cloud  ') + cfg.cloudUrl);
  console.log(pc.dim('  local  ') + localDir);
  if (flags.at) console.log(pc.dim('  at     ') + flags.at);
  console.log('');

  if (flags.unshallow) {
    console.log(pc.dim('Unshallowing repo (this may take a moment)...'));
    await gitFetchUnshallow({
      apiUrl: cfg.cloudUrl,
      apiKey: cfg.apiKey,
      projectId,
      localDir,
    });
  }

  if (!flags.at) {
    // Default: fast-forward to remote HEAD.
    const res = await gitFetchAndReset({
      apiUrl: cfg.cloudUrl,
      apiKey: cfg.apiKey,
      projectId,
      localDir,
    });
    console.log(pc.green(`✓ Reset to ${res.commitSha.slice(0, 8)} (remote HEAD)`));
    return;
  }

  // Resolve --at: try as SHA first (cheapest), fall back to checkpoint
  // name lookup against the cloud listing.
  let targetSha: string;
  try {
    const head = await runGit(['rev-parse', '--verify', `${flags.at}^{commit}`], { cwd: localDir });
    targetSha = head.stdout.trim();
  } catch {
    targetSha = await resolveCheckpointByName(cfg.cloudUrl, cfg.apiKey, projectId, flags.at);
    console.log(pc.dim(`  resolved checkpoint "${flags.at}" → ${targetSha.slice(0, 8)}`));
  }

  // Fetch up to that SHA (covers the shallow-window case for users who
  // didn't pass --unshallow but are reaching for a slightly older sha).
  try {
    await gitFetchAndReset({
      apiUrl: cfg.cloudUrl,
      apiKey: cfg.apiKey,
      projectId,
      localDir,
      branch: targetSha,
    });
  } catch {
    // If we can't fetch directly to that sha (it's outside the shallow
    // window), do a full unshallow and retry.
    if (!flags.unshallow) {
      console.log(pc.yellow('  fetch failed; unshallowing and retrying...'));
      await gitFetchUnshallow({
        apiUrl: cfg.cloudUrl,
        apiKey: cfg.apiKey,
        projectId,
        localDir,
      });
      await gitFetchAndReset({
        apiUrl: cfg.cloudUrl,
        apiKey: cfg.apiKey,
        projectId,
        localDir,
        branch: targetSha,
      });
    } else {
      throw new Error(`Cannot reach commit ${targetSha} in local clone`);
    }
  }

  // Final reset to the requested sha (FETCH_HEAD may differ if we
  // fetched a branch and the user asked for a specific commit).
  await runGit(['reset', '--hard', targetSha], { cwd: localDir });
  console.log(pc.green(`✓ Checked out ${targetSha.slice(0, 8)}`));
}

interface CheckpointListResponse {
  ok: true;
  checkpoints: Array<{ id: string; commitSha: string; name: string | null; commitMessage: string | null; createdAt: string }>;
  hasMore: boolean;
}

/**
 * Resolve a checkpoint by user-facing name (case-insensitive).
 * Strategy: ask the cloud for the most recent N checkpoints, pick the
 * one whose `name` or first 8 chars of `commitMessage` matches.
 */
async function resolveCheckpointByName(
  cloudUrl: string,
  apiKey: string,
  projectId: string,
  needle: string,
): Promise<string> {
  const url = `${cloudUrl.replace(/\/+$/, '')}/api/projects/${encodeURIComponent(projectId)}/checkpoints?limit=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to list checkpoints: HTTP ${res.status}`);
  }
  const body = (await res.json()) as CheckpointListResponse;
  const norm = needle.toLowerCase();
  const match = body.checkpoints.find((cp) => {
    if (cp.name && cp.name.toLowerCase() === norm) return true;
    if (cp.commitSha.startsWith(needle)) return true;
    if (cp.commitMessage && cp.commitMessage.toLowerCase().includes(norm)) return true;
    return false;
  });
  if (!match) {
    throw new Error(`No checkpoint matches "${needle}" (searched ${body.checkpoints.length} most recent)`);
  }
  return match.commitSha;
}
