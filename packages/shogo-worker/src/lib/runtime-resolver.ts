// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Locates the agent-runtime binary on disk.
 *
 * License boundary: this file does NOT import `@shogo/agent-runtime` —
 * the worker (MIT) discovers and spawns the AGPL runtime binary as a
 * separate OS process. No library link, no dynamic-import, no embed.
 *
 * Resolution priority (first hit wins):
 *
 *   1. `--runtime-bin <path>` CLI flag (explicit override; dev/monorepo).
 *   2. `SHOGO_AGENT_RUNTIME_BIN` env var (CI / deterministic deploys).
 *   3. `~/.shogo/runtime/agent-runtime` (default; installed by
 *      `shogo runtime install`).
 *   4. `which shogo-agent-runtime` on PATH (system-wide install via OS
 *      package manager — future).
 *
 * Each candidate is checked for existence + executability. The resolver
 * returns a structured result that includes which strategy hit so the
 * CLI can surface it in `shogo runtime where`.
 */
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { RUNTIME_BIN } from './paths.ts';

export type RuntimeSource = 'flag' | 'env' | 'home' | 'path' | 'none';

export interface ResolvedRuntime {
  /** Absolute path to the agent-runtime binary. */
  path: string;
  /** Which resolution strategy succeeded. */
  source: RuntimeSource;
}

export interface RuntimeResolveOptions {
  /** Value of the `--runtime-bin` CLI flag, if any. */
  flag?: string;
  /** Override the env (for tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Override platform-derived bin name (for tests). */
  systemBinName?: string;
}

/**
 * Resolve the runtime binary path. Returns null if no candidate exists.
 *
 * The caller (typically `shogo worker start` / `shogo runtime where`) is
 * responsible for surfacing a friendly error when null — see
 * `formatMissingRuntimeError()` below.
 */
export function resolveRuntime(opts: RuntimeResolveOptions = {}): ResolvedRuntime | null {
  const env = opts.env ?? process.env;
  const candidates = enumerateCandidates(opts);
  for (const c of candidates) {
    if (isExecutableFile(c.path)) return c;
  }

  const systemBinName = opts.systemBinName ?? defaultSystemBinName();
  const onPath = findOnPath(systemBinName, env.PATH);
  if (onPath) return { path: onPath, source: 'path' };

  return null;
}

/**
 * Build the ordered list of explicit-path candidates (sources 1-3).
 * Source 4 (PATH search) is handled separately because it requires
 * scanning the PATH env.
 */
function enumerateCandidates(opts: RuntimeResolveOptions): ResolvedRuntime[] {
  const env = opts.env ?? process.env;
  const out: ResolvedRuntime[] = [];

  if (opts.flag && opts.flag.trim()) {
    out.push({ path: opts.flag.trim(), source: 'flag' });
  }
  const envPath = env.SHOGO_AGENT_RUNTIME_BIN?.trim();
  if (envPath) {
    out.push({ path: envPath, source: 'env' });
  }
  out.push({ path: RUNTIME_BIN, source: 'home' });
  return out;
}

function defaultSystemBinName(): string {
  return process.platform === 'win32' ? 'shogo-agent-runtime.exe' : 'shogo-agent-runtime';
}

function isExecutableFile(p: string): boolean {
  if (!existsSync(p)) return false;
  try {
    if (process.platform === 'win32') {
      // Windows: existence is sufficient — the OS resolves PATHEXT for us.
      return true;
    }
    accessSync(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findOnPath(binName: string, pathEnv: string | undefined): string | null {
  if (!pathEnv) return null;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binName);
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Format the friendly missing-binary message used by `shogo worker start`
 * and `shogo runtime where` when no candidate resolves.
 *
 * Surfaces the full priority chain so the user can see exactly which
 * paths were checked and pick the right next step.
 */
export function formatMissingRuntimeError(opts: RuntimeResolveOptions = {}): string {
  const env = opts.env ?? process.env;
  const lines: string[] = [];
  lines.push('Error: agent-runtime binary not found.');
  lines.push('');
  lines.push('Looked in (priority order):');
  if (opts.flag) lines.push(`  --runtime-bin ${opts.flag}`);
  if (env.SHOGO_AGENT_RUNTIME_BIN) lines.push(`  $SHOGO_AGENT_RUNTIME_BIN = ${env.SHOGO_AGENT_RUNTIME_BIN}`);
  lines.push(`  ${RUNTIME_BIN} (default install location)`);
  lines.push(`  ${defaultSystemBinName()} on \$PATH`);
  lines.push('');
  lines.push('Fix:');
  lines.push('  - Run `shogo runtime install` to download the latest binary, or');
  lines.push('  - Pass `--runtime-bin <path>` to point at an existing build.');
  return lines.join('\n');
}
