// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import pc from 'picocolors';
import { readPid, isRunning } from '../lib/process-manager.ts';
import { loadConfig } from '../lib/config.ts';

export async function runStatus(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    console.log(pc.yellow('● stopped') + pc.dim(' (no pid file)'));
    return;
  }
  if (!isRunning(pid)) {
    console.log(pc.red('● dead') + pc.dim(` (stale pid ${pid})`));
    return;
  }
  const cfg = loadConfig();
  console.log(pc.green('● running') + pc.dim(` (pid ${pid})`));
  if (cfg.name) console.log(pc.dim(`  name:  `) + cfg.name);
  if (cfg.cloudUrl) console.log(pc.dim(`  cloud: `) + cfg.cloudUrl);
  if (cfg.workerDir) console.log(pc.dim(`  dir:   `) + cfg.workerDir);
}
