// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import pc from 'picocolors';
import { WORKER_LOG, WORKER_ERR } from '../lib/paths.ts';

export interface LogsFlags { follow?: boolean; err?: boolean }

export async function runLogs(flags: LogsFlags): Promise<void> {
  const file = flags.err ? WORKER_ERR : WORKER_LOG;
  if (!existsSync(file)) {
    console.log(pc.dim('No logs yet.'));
    return;
  }
  const args = flags.follow ? ['-F', '-n', '200', file] : ['-n', '200', file];
  const child = spawn('tail', args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));

  if (!flags.follow) {
    const size = statSync(file).size;
    if (size === 0) console.log(pc.dim('(log file is empty)'));
  }
}
