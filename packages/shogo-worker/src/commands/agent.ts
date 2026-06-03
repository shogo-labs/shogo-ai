// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo` / `shogo chat` — launch the interactive coding agent.
 *
 * License boundary: this file (MIT) does NOT import `@shogo/agent-runtime`.
 * It resolves the AGPL agent-runtime binary on disk and spawns it in
 * interactive mode as a separate OS process (stdio inherited), passing the
 * working directory and proxy-billing credentials via env. The agent loop
 * runs in-process inside that AGPL binary — there is no HTTP runtime hop.
 *
 * Billing: the spawned runtime is pointed at the Shogo AI proxy
 * (`AI_PROXY_URL` = `<cloud>/api/ai/v1`) authenticated with the logged-in
 * workspace key (`AI_PROXY_TOKEN` = `shogo_sk_…`). The proxy accepts the key
 * directly, so all LLM usage bills to the account with no token minting.
 */
import { spawn } from 'node:child_process';
import { resolve as resolvePath } from 'node:path';
import pc from 'picocolors';
import { resolveConfig } from '../lib/config.ts';
import { resolveRuntime, formatMissingRuntimeError, type ResolvedRuntime } from '../lib/runtime-resolver.ts';

export interface AgentFlags {
  /** Headless one-shot prompt (`-p` / `--print`). `''` = read, but no value. */
  print?: string;
  /** Model id for new turns (`--model`). */
  model?: string;
  /** Working directory to operate in (`--cwd`). Defaults to $PWD. */
  cwd?: string;
  /** Override the agent-runtime binary path (`--runtime-bin`). */
  runtimeBin?: string;
  /** Disable the Ink TUI, use the plain readline renderer (`--no-tui`). */
  noTui?: boolean;
  /** API key override (else config/env). */
  apiKey?: string;
  /** Cloud URL override (else config/env). */
  cloudUrl?: string;
}

export interface AgentSpawnPlan {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/**
 * Build the spawn argv + env for the interactive runtime. Pure — no IO — so
 * it is unit-testable.
 */
export function buildAgentSpawn(input: {
  flags: AgentFlags;
  config: { apiKey: string; cloudUrl: string };
  runtime: ResolvedRuntime;
  baseEnv?: NodeJS.ProcessEnv;
}): AgentSpawnPlan {
  const { flags, config, runtime } = input;
  const cwd = flags.cwd ? resolvePath(flags.cwd) : process.cwd();

  const args: string[] = ['interactive'];
  if (flags.print !== undefined) args.push('-p', flags.print);
  if (flags.noTui) args.push('--no-tui');

  const cloudUrl = config.cloudUrl.replace(/\/$/, '');

  const env: NodeJS.ProcessEnv = {
    ...(input.baseEnv ?? process.env),
    SHOGO_INTERACTIVE: '1',
    SHOGO_INTERACTIVE_CWD: cwd,
    // The runtime derives WORKSPACE_DIR from these — point them at the CWD so
    // the agent reads/writes the user's actual directory.
    PROJECT_DIR: cwd,
    WORKSPACE_DIR: cwd,
    SHOGO_API_URL: cloudUrl,
    SHOGO_CLOUD_URL: cloudUrl,
    SHOGO_API_KEY: config.apiKey,
    // Proxy billing: route all LLM traffic through the Shogo proxy using the
    // workspace key (accepted directly by the proxy).
    AI_PROXY_URL: `${cloudUrl}/api/ai/v1`,
    AI_PROXY_TOKEN: config.apiKey,
    NODE_ENV: 'production',
  };
  if (flags.model) env.SHOGO_MODEL = flags.model;
  if (flags.print !== undefined) env.SHOGO_PRINT_PROMPT = flags.print;

  return { bin: runtime.path, args, env, cwd };
}

/**
 * Resolve config + runtime binary and exec the interactive agent. Resolves
 * with the child's exit code.
 */
export async function runAgent(flags: AgentFlags = {}): Promise<void> {
  // Gate on login — resolveConfig throws a `shogo login` hint when no key.
  const cfg = resolveConfig({ apiKey: flags.apiKey, cloudUrl: flags.cloudUrl });

  const runtime = resolveRuntime({ flag: flags.runtimeBin });
  if (!runtime) {
    console.error(pc.red(formatMissingRuntimeError({ flag: flags.runtimeBin })));
    process.exit(1);
  }

  const plan = buildAgentSpawn({
    flags,
    config: { apiKey: cfg.apiKey, cloudUrl: cfg.cloudUrl },
    runtime,
  });

  const code = await new Promise<number>((resolveExit) => {
    const child = spawn(plan.bin, plan.args, {
      cwd: plan.cwd,
      env: plan.env,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(pc.red(`✗ Failed to launch agent-runtime: ${err.message}`));
      resolveExit(1);
    });
    child.on('exit', (exitCode) => resolveExit(exitCode ?? 0));
  });

  process.exit(code);
}
