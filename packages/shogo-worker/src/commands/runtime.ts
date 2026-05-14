// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo runtime` subcommands — manage the locally-installed
 * agent-runtime binary that the worker spawns per-project.
 *
 *   shogo runtime install [--channel <stable|beta|nightly>] [--version <x>] [--force] [--base-url <url>]
 *   shogo runtime version
 *   shogo runtime where
 *   shogo runtime update [--channel <...>]
 *
 * The runtime is AGPL-3.0-or-later (see packages/agent-runtime). The
 * worker (MIT) installs it as a separate on-disk binary and spawns it
 * as a child process — no library link.
 */
import pc from 'picocolors';
import {
  type Channel,
  detectTarget,
  getRuntimePaths,
  installRuntime,
  readInstalledVersion,
} from '../lib/runtime-install.ts';
import { resolveRuntime, formatMissingRuntimeError } from '../lib/runtime-resolver.ts';

interface InstallFlags {
  channel?: Channel;
  version?: string;
  baseUrl?: string;
  force?: boolean;
}

export async function runRuntimeInstall(flags: InstallFlags = {}): Promise<void> {
  const result = await installRuntime({
    channel: flags.channel,
    version: flags.version,
    baseUrl: flags.baseUrl,
    force: flags.force,
  });
  console.log();
  console.log(pc.green('✓'), `agent-runtime ${pc.bold(result.version)} installed (${result.target})`);
  console.log(`  ${pc.dim('path:    ')} ${result.binPath}`);
  console.log(`  ${pc.dim('source:  ')} ${result.source}`);
  console.log(`  ${pc.dim('sha256:  ')} ${result.sha256}`);
  console.log(`  ${pc.dim('channel: ')} ${result.channel}`);
}

export function runRuntimeVersion(): void {
  const installed = readInstalledVersion();
  if (!installed) {
    console.log(pc.yellow('No agent-runtime installed.'));
    console.log(`Run ${pc.cyan('shogo runtime install')} to download the latest.`);
    process.exitCode = 1;
    return;
  }
  console.log(`${pc.bold('agent-runtime')} ${installed.version}`);
  console.log(`  ${pc.dim('target:      ')} ${installed.target}`);
  console.log(`  ${pc.dim('channel:     ')} ${installed.channel}`);
  console.log(`  ${pc.dim('installed at:')} ${installed.installedAt}`);
  console.log(`  ${pc.dim('source:      ')} ${installed.source}`);
}

export function runRuntimeWhere(): void {
  const resolved = resolveRuntime();
  const paths = getRuntimePaths();
  if (!resolved) {
    console.log(pc.yellow('agent-runtime binary not found on this machine.'));
    console.log();
    console.log(pc.dim('Default install path:'), paths.runtimeBin);
    console.log();
    console.log(formatMissingRuntimeError());
    process.exitCode = 1;
    return;
  }
  console.log(resolved.path);
  if (process.env.SHOGO_DEBUG || process.env.VERBOSE) {
    console.log(pc.dim(`  (resolved via: ${resolved.source})`));
  }
}

interface UpdateFlags {
  channel?: Channel;
  baseUrl?: string;
}

export async function runRuntimeUpdate(flags: UpdateFlags = {}): Promise<void> {
  const installed = readInstalledVersion();
  const targetChannel = flags.channel ?? installed?.channel ?? 'stable';
  if (installed) {
    console.log(
      `${pc.dim('current:')} ${installed.version} (${installed.target}, ${installed.channel})`,
    );
  } else {
    console.log(pc.dim('No existing install — installing fresh...'));
  }
  // installRuntime resolves the latest in-channel version on its own;
  // pass force:true so we always reinstall when the user explicitly
  // ran `update` (matches `npm update` / `brew upgrade` muscle memory).
  await runRuntimeInstall({ channel: targetChannel, baseUrl: flags.baseUrl, force: true });
}

export function getDetectedTarget(): string {
  return detectTarget();
}
