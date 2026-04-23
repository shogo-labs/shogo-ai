// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import pc from 'picocolors';
import { stopWorker } from '../lib/process-manager.ts';

export async function runStop(): Promise<void> {
  const { killedPid } = stopWorker('SIGTERM');
  if (killedPid === null) {
    console.log(pc.dim('No worker running.'));
    return;
  }
  console.log(pc.green(`✓ Worker stopped (pid=${killedPid}).`));
}
