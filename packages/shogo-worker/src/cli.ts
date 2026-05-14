// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Shogo Worker CLI — entry.
 *
 * `shogo login`                       — save an API key to ~/.shogo/config.json
 * `shogo worker start [flags]`        — pair this machine with Shogo Cloud
 * `shogo worker stop`                 — stop the local worker
 * `shogo worker status`               — show running/stopped
 * `shogo worker logs [--follow]`      — tail worker logs
 * `shogo config show | set <k> <v>`   — inspect/modify config
 */
import { Command } from 'commander';
import pc from 'picocolors';
import { runStart } from './commands/start.ts';
import { runStop } from './commands/stop.ts';
import { runStatus } from './commands/status.ts';
import { runLogs } from './commands/logs.ts';
import { runLogin } from './commands/login.ts';
import { runConfigShow, runConfigSet } from './commands/config.ts';
import {
  runRuntimeInstall,
  runRuntimeUpdate,
  runRuntimeVersion,
  runRuntimeWhere,
} from './commands/runtime.ts';

const VERSION = '0.1.0';

const program = new Command();
program
  .name('shogo')
  .description('Shogo Cloud Agent Worker — run Shogo agents on your own machine.')
  .version(VERSION);

program
  .command('login')
  .description('Pair this machine with Shogo Cloud (browser device flow, or --api-key for CI)')
  .option('--api-key <key>', 'CI escape hatch — skip the browser flow and use a key directly')
  .option('--cloud-url <url>', 'Shogo Cloud URL (default: https://studio.shogo.ai)')
  .option('--name <name>', 'Device label shown in the dashboard (default: hostname)')
  .option('--workspace <id>', 'Pre-select a workspace on the bridge picker')
  .option('--no-browser', 'Do not auto-open the browser; print the URL instead')
  .action((flags) => handle(() => runLogin(flags)));

const worker = program.command('worker').description('Manage the local worker process');

worker
  .command('start')
  .description('Start the worker and pair with Shogo Cloud')
  .option('--name <name>', 'Instance name shown in the dashboard (default: hostname)')
  .option('--worker-dir <path>', 'Working directory for the worker (default: $PWD)')
  .option('--api-key <key>', 'API key (overrides config/env)')
  .option('--cloud-url <url>', 'Shogo Cloud URL')
  .option('--port <port>', 'Local HTTP port for the embedded API')
  .option('--proxy <url>', 'HTTPS proxy (overrides HTTPS_PROXY env)')
  .option('--project <id>', 'Pin to a single project (default: multi-project on demand)')
  .option('--runtime-bin <path>', 'Override the agent-runtime binary path')
  .option('--debug', 'Run preflight checks before starting')
  .option('--foreground', 'Run in foreground (don\'t detach)')
  .action((flags) => handle(() => runStart(flags)));

worker
  .command('stop')
  .description('Stop the running worker')
  .action(() => handle(runStop));

worker
  .command('status')
  .description('Show worker status')
  .action(() => handle(runStatus));

worker
  .command('logs')
  .description('Tail worker logs from ~/.shogo/logs/worker.log')
  .option('-f, --follow', 'Follow the log (tail -F)')
  .option('--err', 'Show stderr log instead')
  .action((flags) => handle(() => runLogs(flags)));

const runtime = program
  .command('runtime')
  .description('Install / inspect the local agent-runtime binary');
runtime
  .command('install')
  .description('Download + verify the agent-runtime tarball into ~/.shogo/runtime/')
  .option('--channel <channel>', 'stable | beta | nightly (default: stable)')
  .option('--version <version>', 'install a specific version (e.g. 0.1.0)')
  .option('--base-url <url>', 'override release base URL (default: GitHub Releases)')
  .option('--force', 'reinstall even if the same version is already on disk')
  .action((flags) => handle(() => runRuntimeInstall(flags)));
runtime
  .command('version')
  .description('Print the installed agent-runtime version')
  .action(() => handle(() => runRuntimeVersion()));
runtime
  .command('where')
  .description('Print the resolved agent-runtime binary path')
  .action(() => handle(() => runRuntimeWhere()));
runtime
  .command('update')
  .description('Update agent-runtime to the latest in its channel')
  .option('--channel <channel>', 'override channel (defaults to whatever is installed)')
  .option('--base-url <url>', 'override release base URL')
  .action((flags) => handle(() => runRuntimeUpdate(flags)));

const config = program.command('config').description('Inspect or modify ~/.shogo/config.json');
config
  .command('show')
  .description('Print current config (API key masked)')
  .action(() => handle(runConfigShow));
config
  .command('set <key> <value>')
  .description('Set apiKey / cloudUrl / name / workerDir / port')
  .action((k: string, v: string) => handle(() => runConfigSet(k, v)));

program.showHelpAfterError(pc.dim('\n(use --help for usage)'));
program.parseAsync(process.argv);

async function handle(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err: any) {
    console.error(pc.red(`✗ ${err?.message ?? err}`));
    if (process.env.SHOGO_DEBUG) console.error(err?.stack);
    process.exit(1);
  }
}
