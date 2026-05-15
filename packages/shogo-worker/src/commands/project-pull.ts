// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo project pull <projectId>` — clone a project's workspace from
 * Shogo Cloud to a local directory. Optionally `--watch` starts a
 * bidirectional sync: pull initially, then push any local edits back via
 * the {@link CloudSyncWatcher}.
 *
 * This is the easy-button companion to pinning a project to a paired
 * machine:
 *
 *   shogo login                      # one-time pairing
 *   shogo project pull <projectId>   # clones the staging snapshot locally
 *   shogo worker start               # auto-routes pinned traffic here
 */

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { CloudFileTransport, type ProgressEvent, type SyncStats } from '@shogo-ai/sdk';
import { resolveConfig } from '../lib/config.ts';
import { ensureProjectsDir, projectDirFor } from '../lib/paths.ts';
import { CloudSyncWatcher } from '../lib/cloud-sync-watcher.ts';

export interface ProjectPullFlags {
  into?: string;
  watch?: boolean;
  include?: string;
  apiKey?: string;
  cloudUrl?: string;
}

export async function runProjectPull(projectId: string, flags: ProjectPullFlags): Promise<void> {
  if (!projectId) throw new Error('projectId is required');

  const cfg = resolveConfig({
    apiKey: flags.apiKey,
    cloudUrl: flags.cloudUrl,
  });

  ensureProjectsDir(cfg.projectsDir);
  const into = resolve(flags.into ?? projectDirFor(projectId, cfg.projectsDir));
  if (!existsSync(into)) {
    mkdirSync(into, { recursive: true });
  }

  const include = flags.include?.split(',').map((s) => s.trim()).filter(Boolean);

  console.log(pc.bold(`\nshogo project pull ${pc.cyan(projectId)}`));
  console.log(pc.dim('  cloud   ') + cfg.cloudUrl);
  console.log(pc.dim('  into    ') + into);
  if (include?.length) console.log(pc.dim('  include ') + include.join(', '));
  console.log('');

  const transport = new CloudFileTransport({
    apiUrl: cfg.cloudUrl,
    apiKey: cfg.apiKey,
    projectId,
    localDir: into,
    include,
    onProgress: makeProgressReporter(),
  });

  const stats = await transport.downloadAll();
  printSummary('Pull', stats);

  if (flags.watch) {
    console.log(pc.bold('\nWatching for local changes...'));
    const watcher = new CloudSyncWatcher({
      rootDir: into,
      transport,
      onFlush: ({ uploaded, errors }) => {
        const list = uploaded.length === 1 ? uploaded[0] : `${uploaded.length} files`;
        const errSuffix = errors > 0 ? pc.red(` (${errors} errors)`) : '';
        console.log(pc.dim(`  ↑ ${list}${errSuffix}`));
      },
    });
    watcher.start();

    let shuttingDown = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      console.log(pc.dim(`\nReceived ${signal} — flushing pending uploads...`));
      try {
        await watcher.stop();
      } catch (err: any) {
        console.warn(pc.yellow(`watcher.stop: ${err?.message ?? err}`));
      }
      process.exit(0);
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
    process.once('SIGHUP', () => void shutdown('SIGHUP'));

    // Park the foreground process. Shutdown handler exits when the user terminates.
    await new Promise<void>(() => { /* never resolves */ });
  }
}

function makeProgressReporter(): (e: ProgressEvent) => void {
  return (e) => {
    const verb = e.kind === 'download' ? '↓' : e.kind === 'upload' ? '↑' : e.kind === 'delete' ? '✗' : '·';
    const pct = e.total > 0 ? ` ${e.index + 1}/${e.total}` : '';
    const sizeNote = e.bytes != null ? pc.dim(` (${formatBytes(e.bytes)})`) : '';
    console.log(pc.dim(`  ${verb}${pct} ${e.path}${sizeNote}`));
  };
}

function printSummary(label: string, stats: SyncStats): void {
  const ok = stats.errors.length === 0;
  const head = ok ? pc.green(`✓ ${label} complete`) : pc.red(`✗ ${label} completed with errors`);
  console.log(`\n${head}`);
  console.log(pc.dim('  downloaded: ') + stats.downloaded);
  if (stats.uploaded) console.log(pc.dim('  uploaded:   ') + stats.uploaded);
  if (stats.deleted) console.log(pc.dim('  deleted:    ') + stats.deleted);
  if (stats.skipped) console.log(pc.dim('  skipped:    ') + stats.skipped);
  if (!ok) {
    console.log(pc.dim('  errors:     ') + stats.errors.length);
    for (const err of stats.errors.slice(0, 5)) {
      console.log(pc.dim('    ') + pc.red(`${err.path}: ${err.message}`));
    }
    if (stats.errors.length > 5) {
      console.log(pc.dim(`    ... and ${stats.errors.length - 5} more`));
    }
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
