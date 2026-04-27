// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import pc from 'picocolors';
import { resolveConfig } from '../lib/config.ts';
import { findApiEntry } from '../lib/api-discovery.ts';
import { spawnWorker, installShutdownHooks } from '../lib/process-manager.ts';
import { makeChecks, runPreflight } from '../lib/preflight.ts';
import { resolveProxy, applyProxyToEnv } from '../lib/transport.ts';

export interface StartFlags {
  name?: string;
  workerDir?: string;
  apiKey?: string;
  cloudUrl?: string;
  port?: string;
  proxy?: string;
  debug?: boolean;
  foreground?: boolean;
}

export async function runStart(flags: StartFlags): Promise<void> {
  const cfg = resolveConfig({
    name: flags.name,
    workerDir: flags.workerDir,
    apiKey: flags.apiKey,
    cloudUrl: flags.cloudUrl,
    port: flags.port ? parseInt(flags.port, 10) : undefined,
  });

  const proxy = resolveProxy(flags.proxy);

  if (flags.debug) {
    const ok = await runPreflight(
      makeChecks({
        cloudUrl: cfg.cloudUrl,
        apiKey: cfg.apiKey,
        workerDir: cfg.workerDir,
        proxy,
      }),
    );
    if (!ok) process.exit(1);
  }

  const api = findApiEntry();
  console.log(pc.bold('\nShogo Worker — Starting'));
  console.log(pc.dim(`  mode       `) + api.mode);
  console.log(pc.dim(`  runner     `) + api.runner);
  console.log(pc.dim(`  name       `) + cfg.name);
  console.log(pc.dim(`  worker-dir `) + cfg.workerDir);
  console.log(pc.dim(`  cloud      `) + cfg.cloudUrl);
  console.log(pc.dim(`  port       `) + cfg.port);
  if (proxy) {
    console.log(pc.dim(`  proxy      `) + `${proxy.url} ${pc.dim(`(from ${proxy.source})`)}`);
  }
  console.log('');

  const env: NodeJS.ProcessEnv = applyProxyToEnv(
    {
      ...process.env,
      SHOGO_API_KEY: cfg.apiKey,
      SHOGO_CLOUD_URL: cfg.cloudUrl,
      SHOGO_INSTANCE_NAME: cfg.name,
      SHOGO_WORKER_DIR: cfg.workerDir,
      SHOGO_LOCAL_MODE: 'true',
      PORT: String(cfg.port),
    },
    proxy,
  );

  const { pid, child } = spawnWorker({
    entry: api.entry,
    runner: api.runner,
    env,
    cwd: cfg.workerDir,
    detach: !flags.foreground,
    inheritStdio: !!flags.foreground,
  });

  if (flags.foreground) {
    console.log(pc.green(`✓ Worker running in foreground (pid=${pid}). Ctrl-C to stop.`));
    installShutdownHooks(child);
    // Keep the CLI alive until the child exits; the exit handler propagates
    // the child's exit code. Without this await the bun/node CLI process
    // would return to its caller and the detached child would keep running.
    await new Promise<void>(() => { /* listeners in installShutdownHooks handle termination */ });
  } else {
    console.log(pc.green(`✓ Worker started (pid=${pid}).`));
    console.log(pc.dim(`  logs: ~/.shogo/logs/worker.log`));
    console.log(pc.dim(`  stop: shogo worker stop`));
  }
}
