// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo worker start` — pair this machine with Shogo Cloud.
 *
 * Two execution modes:
 *
 *   --foreground   Run the tunnel + runtime-manager in this process,
 *                  log to stdout, exit on SIGINT/SIGTERM. This is the
 *                  shape used inside the spawned detached child below
 *                  (so we never duplicate the wire-up code) and the
 *                  shape `shogo runtime install && shogo worker start --foreground`
 *                  uses for CI / `systemd --user` setups.
 *
 *   (default)      Detach: re-spawn `shogo worker start --foreground`
 *                  as a background process via `spawnWorker`, write
 *                  the pid file, return immediately. The PID file is
 *                  what `shogo worker stop / status / logs` poll.
 *
 * Foreground path responsibilities (in order):
 *   1. Resolve config (api key, cloud url, name, worker dir).
 *   2. Apply HTTPS_PROXY into the process env so outbound fetch picks
 *      it up via Node/Bun's automatic dispatcher.
 *   3. Locate the AGPL agent-runtime binary on disk; abort with a
 *      friendly install hint if missing.
 *   4. Optional --debug preflight (proxy reachability + cloud ping).
 *   5. Construct WorkerRuntimeManager with cloud-routed default spawn
 *      config (every per-project runtime gets cloudUrl + apiKey).
 *   6. Construct WorkerTunnel with the runtime manager as its resolver.
 *   7. Install signal handlers (SIGINT / SIGTERM / SIGHUP) that stop
 *      the tunnel, stop all per-project runtimes, then exit.
 *   8. Wait forever; the cloud drives traffic in via the tunnel WS.
 */
import pc from 'picocolors';
import { existsSync } from 'node:fs';
import { resolveConfig } from '../lib/config.ts';
import { spawnWorker } from '../lib/process-manager.ts';
import { makeChecks, runPreflight } from '../lib/preflight.ts';
import { resolveProxy, applyProxyToEnv } from '../lib/transport.ts';
import { resolveRuntime, formatMissingRuntimeError } from '../lib/runtime-resolver.ts';
import { WorkerRuntimeManager, type ProjectSpawnConfig } from '../lib/runtime-manager.ts';
import { WorkerTunnel } from '../lib/tunnel.ts';

export interface StartFlags {
  name?: string;
  workerDir?: string;
  apiKey?: string;
  cloudUrl?: string;
  port?: string;
  proxy?: string;
  project?: string;
  runtimeBin?: string;
  debug?: boolean;
  foreground?: boolean;
  /** Set to `true` to disable the on-first-request auto-pull of project
   *  workspaces from cloud. Auto-pull is ON by default for `cli_worker`
   *  workers so a freshly-paired VPS can serve pinned projects without
   *  the operator first running `shogo project pull`. */
  noAutoPull?: boolean;
  projectsDir?: string;
  /** Disable the git smart-HTTP sync path even when `git` is on PATH.
   *  When set, auto-pull falls back to the CloudFileTransport file-pump.
   *  Useful when outbound HTTPS to git pack RPC endpoints is firewalled. */
  noGit?: boolean;
}

export async function runStart(flags: StartFlags): Promise<void> {
  const cfg = resolveConfig({
    name: flags.name,
    workerDir: flags.workerDir,
    apiKey: flags.apiKey,
    cloudUrl: flags.cloudUrl,
    port: flags.port ? parseInt(flags.port, 10) : undefined,
    projectsDir: flags.projectsDir,
  });

  const proxy = resolveProxy(flags.proxy);

  if (!flags.foreground) {
    // Detached default — re-launch this same CLI with --foreground in
    // a child process so the user gets their shell back. The actual
    // tunnel + runtime-manager work happens in `runStartForeground()`
    // below in the spawned process.
    return runDetached({ cfg, proxy, flags });
  }

  // Foreground path: surface a friendly missing-binary error BEFORE
  // we open the tunnel — the binary is always required and it's a
  // much better failure mode to tell the user up front than to fail
  // on the first inbound /agent/* request.
  const resolved = resolveRuntime({ flag: flags.runtimeBin });
  if (!resolved) {
    console.error(pc.red(formatMissingRuntimeError({ flag: flags.runtimeBin })));
    process.exit(1);
  }

  applyProxyToEnv(process.env, proxy);

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

  const autoPullEnabled = !flags.noAutoPull;
  const useGit = !flags.noGit;

  console.log(pc.bold('\nShogo Worker — Starting'));
  console.log(pc.dim('  name        ') + cfg.name);
  console.log(pc.dim('  worker-dir  ') + cfg.workerDir);
  console.log(pc.dim('  cloud       ') + cfg.cloudUrl);
  console.log(pc.dim('  runtime     ') + `${resolved.path} ${pc.dim(`(via ${resolved.source})`)}`);
  console.log(pc.dim('  auto-pull   ') + (autoPullEnabled ? pc.green('on') + pc.dim(` → ${cfg.projectsDir}`) : pc.yellow('off')));
  console.log(pc.dim('  sync mode   ') + (useGit ? pc.green('git') + pc.dim(' (falls back to file transport if git is missing)') : pc.yellow('files-only')));
  if (flags.project) console.log(pc.dim('  project     ') + flags.project);
  if (proxy) {
    console.log(pc.dim('  proxy       ') + `${proxy.url} ${pc.dim(`(from ${proxy.source})`)}`);
  }
  console.log('');

  // Derive the AI proxy URL from the cloud URL so the agent-runtime
  // routes LLM calls through Shogo Cloud's proxy instead of requiring
  // direct API keys on the machine.  The proxy endpoint lives at
  // <cloudUrl>/api/ai/v1 — the same base the desktop app uses.
  const aiProxyUrl = `${cfg.cloudUrl.replace(/\/+$/, '')}/api/ai/v1`;

  const defaultSpawnConfig: ProjectSpawnConfig = {
    cloudUrl: cfg.cloudUrl,
    apiKey: cfg.apiKey,
    aiProxyUrl,
    aiProxyToken: cfg.apiKey,
    // No projectDir up front — the runtime manager's `maybeAutoPull`
    // sets PROJECT_DIR per-project to <projectsDir>/<projectId>/ once
    // the clone completes. CWD defaults to that same directory.
  };

  const runtimeManager = new WorkerRuntimeManager({
    runtimeBin: flags.runtimeBin,
    defaultSpawnConfig,
    autoPull: {
      enabled: autoPullEnabled,
      projectsDir: cfg.projectsDir,
      watch: true,
      useGit,
    },
  });

  // Eagerly resolve so the cached `resolved` is reused — also exits early
  // if a race deleted the binary between the check above and now.
  if (!runtimeManager.resolveBinary()) {
    console.error(pc.red(formatMissingRuntimeError({ flag: flags.runtimeBin })));
    process.exit(1);
  }

  const tunnel = new WorkerTunnel({
    apiKey: cfg.apiKey,
    cloudUrl: cfg.cloudUrl,
    name: cfg.name,
    kind: 'cli-worker',
    resolver: runtimeManager,
    onAuthRevoked: (reason) => {
      console.error(pc.red(`✗ Cloud auth revoked: ${reason}`));
      console.error(pc.dim(`  Run \`shogo login\` to re-authenticate; this worker will keep polling at the auth-failure backoff until then.`));
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(pc.dim(`\nReceived ${signal} — shutting down...`));
    try { tunnel.stop(); } catch { /* already stopped */ }
    try { await runtimeManager.stopAll(); } catch (err: any) {
      console.warn(pc.yellow(`stopAll: ${err?.message ?? err}`));
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGHUP', () => void shutdown('SIGHUP'));

  tunnel.start();
  console.log(pc.green('✓ Worker running. Ctrl-C to stop.'));

  // Pin the foreground process. The shutdown handler above will
  // process.exit() when the user terminates.
  await new Promise<void>(() => { /* never resolves */ });
}

interface DetachedOpts {
  cfg: { apiKey: string; cloudUrl: string; name: string; workerDir: string; port: number };
  proxy: ReturnType<typeof resolveProxy>;
  flags: StartFlags;
}

/**
 * Detach implementation: figure out the right argv to re-invoke this
 * CLI with `worker start --foreground`, spawn it via `spawnWorker`
 * (which writes the PID file + redirects stdio to ~/.shogo/logs/),
 * then exit. The child becomes the long-running worker.
 */
function runDetached({ cfg, proxy, flags }: DetachedOpts): void {
  const { entry, runner } = resolveSelfEntry();

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

  // We pass `--foreground` to the spawned child so it takes the
  // foreground branch above. Anything else the user passed is also
  // forwarded so e.g. `--project <id>` survives detachment.
  const argv = buildChildArgv(flags);

  const { pid } = spawnWorker({
    entry,
    runner,
    env: { ...env, SHOGO_DETACHED_ARGS: argv.join(' ') },
    cwd: cfg.workerDir,
    detach: true,
    inheritStdio: false,
  });

  console.log(pc.bold('\nShogo Worker — Started'));
  console.log(pc.dim('  pid:  ') + pid);
  console.log(pc.dim('  name: ') + cfg.name);
  console.log(pc.dim('  logs: ') + '~/.shogo/logs/worker.log');
  console.log(pc.dim('  stop: ') + 'shogo worker stop');
}

function buildChildArgv(flags: StartFlags): string[] {
  const out: string[] = ['worker', 'start', '--foreground'];
  if (flags.name) out.push('--name', flags.name);
  if (flags.workerDir) out.push('--worker-dir', flags.workerDir);
  if (flags.apiKey) out.push('--api-key', flags.apiKey);
  if (flags.cloudUrl) out.push('--cloud-url', flags.cloudUrl);
  if (flags.port) out.push('--port', flags.port);
  if (flags.proxy) out.push('--proxy', flags.proxy);
  if (flags.project) out.push('--project', flags.project);
  if (flags.runtimeBin) out.push('--runtime-bin', flags.runtimeBin);
  if (flags.debug) out.push('--debug');
  if (flags.noAutoPull) out.push('--no-auto-pull');
  if (flags.projectsDir) out.push('--projects-dir', flags.projectsDir);
  if (flags.noGit) out.push('--no-git');
  return out;
}

/**
 * Find the entry point + runner the detached child should use.
 *
 * Priority:
 *   1. The currently-executing argv[1] if it's an existing file (eg.
 *      a globally installed `shogo` bin or `bun src/cli.ts` in the
 *      monorepo).
 *   2. The compiled binary at /usr/local/bin/shogo on PATH (best-effort).
 *   3. The bin shim shipped with this package.
 */
function resolveSelfEntry(): { entry: string; runner: 'bun' | 'node' | 'tsx' } {
  // process.execPath is the bun/node binary; argv[1] is the script.
  const execPath = process.execPath;
  const isBun = /\bbun(?:-[^/\\]*)?$/.test(execPath) || typeof (globalThis as any).Bun !== 'undefined';
  const argvScript = process.argv[1];
  if (argvScript && existsSync(argvScript)) {
    // When spawned via tsx (from the bin shim), process.execPath is still
    // `node` because tsx runs on top of Node. Detect a .ts entry and route
    // through tsx so the detached child can handle TypeScript natively.
    const isTs = /\.ts$/.test(argvScript);
    const runner = isBun ? 'bun' : (isTs ? 'tsx' : 'node');
    return { entry: argvScript, runner };
  }
  // Fallback: the compiled bin shim shipped with the package.
  // Resolved relative to this file via import.meta.url so it works
  // both in monorepo and when published.
  const shim = new URL('../../bin/shogo.mjs', import.meta.url).pathname;
  return { entry: shim, runner: isBun ? 'bun' : 'node' };
}
