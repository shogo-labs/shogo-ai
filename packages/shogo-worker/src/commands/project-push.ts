// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo project push <projectId>` — upload a local workspace directory
 * back to Shogo Cloud. The inverse of `shogo project pull`.
 *
 * With `--delete-remote`, any file present in the cloud manifest but
 * missing locally is also removed from cloud. This makes `push` behave
 * like a one-shot "mirror local to cloud" rather than a strict additive
 * upload — safer to leave off by default.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pc from 'picocolors';
import { CloudFileTransport, type ProgressEvent, type SyncStats } from '@shogo-ai/sdk';
import { resolveConfig } from '../lib/config.ts';
import { projectDirFor } from '../lib/paths.ts';

export interface ProjectPushFlags {
  from?: string;
  deleteRemote?: boolean;
  include?: string;
  apiKey?: string;
  cloudUrl?: string;
}

export async function runProjectPush(projectId: string, flags: ProjectPushFlags): Promise<void> {
  if (!projectId) throw new Error('projectId is required');

  const cfg = resolveConfig({
    apiKey: flags.apiKey,
    cloudUrl: flags.cloudUrl,
  });

  const from = resolve(flags.from ?? projectDirFor(projectId, cfg.projectsDir));
  if (!existsSync(from)) {
    throw new Error(`Source directory does not exist: ${from}`);
  }

  const include = flags.include?.split(',').map((s) => s.trim()).filter(Boolean);

  console.log(pc.bold(`\nshogo project push ${pc.cyan(projectId)}`));
  console.log(pc.dim('  cloud   ') + cfg.cloudUrl);
  console.log(pc.dim('  from    ') + from);
  if (include?.length) console.log(pc.dim('  include ') + include.join(', '));
  if (flags.deleteRemote) console.log(pc.yellow('  --delete-remote: remote files not present locally will be DELETED'));
  console.log('');

  const transport = new CloudFileTransport({
    apiUrl: cfg.cloudUrl,
    apiKey: cfg.apiKey,
    projectId,
    localDir: from,
    include,
    onProgress: (e: ProgressEvent) => {
      const verb = e.kind === 'upload' ? '↑' : e.kind === 'delete' ? '✗' : '·';
      const pct = e.total > 0 ? ` ${e.index + 1}/${e.total}` : '';
      const sz = e.bytes != null ? pc.dim(` (${formatBytes(e.bytes)})`) : '';
      console.log(pc.dim(`  ${verb}${pct} ${e.path}${sz}`));
    },
  });

  const stats = await transport.uploadAll({ deleteRemote: flags.deleteRemote });
  printSummary('Push', stats);
}

function printSummary(label: string, stats: SyncStats): void {
  const ok = stats.errors.length === 0;
  const head = ok ? pc.green(`✓ ${label} complete`) : pc.red(`✗ ${label} completed with errors`);
  console.log(`\n${head}`);
  console.log(pc.dim('  uploaded:   ') + stats.uploaded);
  if (stats.deleted) console.log(pc.dim('  deleted:    ') + stats.deleted);
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
