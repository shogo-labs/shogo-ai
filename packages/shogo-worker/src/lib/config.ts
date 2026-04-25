// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Reads/writes ~/.shogo/config.json. The worker reads this at start,
 * and the `config` / `login` commands write to it.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { hostname } from 'node:os';
import { CONFIG_FILE, ensureHome } from './paths.ts';

export interface WorkerConfig {
  apiKey?: string;
  cloudUrl?: string;
  name?: string;
  workerDir?: string;
  port?: number;
}

const DEFAULTS: Required<Pick<WorkerConfig, 'cloudUrl' | 'port'>> = {
  cloudUrl: 'https://studio.shogo.ai',
  port: 8002,
};

export function loadConfig(): WorkerConfig {
  if (!existsSync(CONFIG_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch (err) {
    throw new Error(`Corrupt config at ${CONFIG_FILE}: ${(err as Error).message}`);
  }
}

export function saveConfig(cfg: WorkerConfig): void {
  ensureHome();
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  chmodSync(CONFIG_FILE, 0o600);
}

export function mergeConfig(base: WorkerConfig, override: WorkerConfig): WorkerConfig {
  return { ...base, ...Object.fromEntries(Object.entries(override).filter(([, v]) => v !== undefined)) };
}

export function resolveConfig(override: WorkerConfig = {}): Required<WorkerConfig> & { apiKey: string } {
  const fileCfg = loadConfig();
  const env: WorkerConfig = {
    apiKey: process.env.SHOGO_API_KEY,
    cloudUrl: process.env.SHOGO_CLOUD_URL,
    name: process.env.SHOGO_INSTANCE_NAME,
    workerDir: process.env.SHOGO_WORKER_DIR,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
  };
  const merged = mergeConfig(mergeConfig(fileCfg, env), override);
  if (!merged.apiKey) {
    throw new Error('No API key. Run `shogo login` or pass --api-key / set SHOGO_API_KEY.');
  }
  return {
    apiKey: merged.apiKey,
    cloudUrl: merged.cloudUrl ?? DEFAULTS.cloudUrl,
    name: merged.name ?? hostname(),
    workerDir: merged.workerDir ?? process.cwd(),
    port: merged.port ?? DEFAULTS.port,
  };
}
