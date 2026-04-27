// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
import pc from 'picocolors';
import { loadConfig, saveConfig } from '../lib/config.ts';
import { CONFIG_FILE } from '../lib/paths.ts';

export async function runConfigShow(): Promise<void> {
  const cfg = loadConfig();
  if (Object.keys(cfg).length === 0) {
    console.log(pc.dim('(no config — run `shogo login` or `shogo config set`)'));
    return;
  }
  const masked = { ...cfg, apiKey: cfg.apiKey ? `***${cfg.apiKey.slice(-4)}` : undefined };
  console.log(pc.dim(`file: ${CONFIG_FILE}`));
  console.log(JSON.stringify(masked, null, 2));
}

export async function runConfigSet(key: string, value: string): Promise<void> {
  const allowed = ['apiKey', 'cloudUrl', 'name', 'workerDir', 'port'] as const;
  if (!allowed.includes(key as any)) {
    console.error(pc.red(`Unknown key: ${key}`));
    console.error(pc.dim(`Allowed: ${allowed.join(', ')}`));
    process.exit(1);
  }
  const cfg = loadConfig();
  (cfg as any)[key] = key === 'port' ? parseInt(value, 10) : value;
  saveConfig(cfg);
  console.log(pc.green(`✓ ${key} set`));
}
