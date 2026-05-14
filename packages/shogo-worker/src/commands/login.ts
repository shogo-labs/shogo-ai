// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo login` — pair this machine with Shogo Cloud.
 *
 * Two modes, in priority order:
 *
 *   1. `--api-key <key>` flag, or `SHOGO_API_KEY` env var
 *      → CI / headless mode. Validate against cloud, save, done.
 *
 *   2. Interactive (default)
 *      → Poll-based device flow (see lib/cloud-login.ts):
 *          POST /api/cli/login/start  → state + authUrl
 *          open authUrl in browser    → user approves on cloud
 *          GET  /api/cli/login/poll   → key once approved
 *
 * The minted key is written to ~/.shogo/config.json with mode 0600 so
 * other local users can't read it. The same file is what
 * `shogo worker start` reads on boot.
 *
 * The legacy "paste a shogo_sk_ key at the prompt" flow is still
 * supported via `--api-key`; it just isn't the default any more.
 */
import pc from 'picocolors';
import { loadConfig, saveConfig } from '../lib/config.ts';
import { runCloudLogin, CloudLoginError } from '../lib/cloud-login.ts';
import { getOrCreateDeviceId } from '../lib/device-id.ts';

export interface LoginFlags {
  apiKey?: string;
  cloudUrl?: string;
  name?: string;
  workspace?: string;
  noBrowser?: boolean;
}

const DEFAULT_CLOUD_URL = 'https://studio.shogo.ai';

export async function runLogin(flags: LoginFlags): Promise<void> {
  const cfg = loadConfig();
  const cloudUrl = (flags.cloudUrl || cfg.cloudUrl || DEFAULT_CLOUD_URL).replace(/\/$/, '');

  const escapeKey = flags.apiKey || process.env.SHOGO_API_KEY;
  if (escapeKey) {
    await loginWithApiKey({ key: escapeKey, cloudUrl, cfg, name: flags.name });
    return;
  }

  const deviceId = getOrCreateDeviceId();
  let result;
  try {
    result = await runCloudLogin({
      cloudUrl,
      deviceId,
      deviceName: flags.name,
      workspaceId: flags.workspace,
      openBrowser: !flags.noBrowser,
    });
  } catch (err: any) {
    if (err instanceof CloudLoginError) {
      console.error(pc.red(`✗ ${err.message}`));
      if (err.kind === 'transport') {
        console.error(pc.dim(`  If your network blocks browsers, run with --api-key <key> instead.`));
      }
      process.exit(1);
    }
    throw err;
  }

  cfg.apiKey = result.key;
  cfg.cloudUrl = cloudUrl;
  if (flags.name) cfg.name = flags.name;
  saveConfig(cfg);

  console.log('');
  console.log(pc.green('✓ Signed in to Shogo Cloud'));
  if (result.workspace) console.log(pc.dim('  workspace: ') + result.workspace);
  if (result.email) console.log(pc.dim('  email:     ') + result.email);
  console.log(pc.dim('  saved to:  ') + '~/.shogo/config.json');
  console.log('');
  console.log(pc.dim('  next: ') + 'shogo worker start');
}

interface ApiKeyOpts {
  key: string;
  cloudUrl: string;
  cfg: ReturnType<typeof loadConfig>;
  name?: string;
}

async function loginWithApiKey({ key, cloudUrl, cfg, name }: ApiKeyOpts): Promise<void> {
  if (!/^shogo_sk_/.test(key)) {
    console.error(pc.red('✗ API key should start with "shogo_sk_". Copy it verbatim from the API Keys page.'));
    process.exit(1);
  }

  // Mirror apps/api/src/routes/local-auth.ts: re-validate against cloud
  // before persisting so the user gets immediate feedback on a bad key.
  let validation: { valid?: boolean; error?: string; workspace?: { name?: string } | null; user?: { email?: string } | null };
  try {
    const res = await fetch(`${cloudUrl}/api/api-keys/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
      signal: AbortSignal.timeout(10_000),
    });
    validation = await res.json().catch(() => ({} as any)) as typeof validation;
    if (!res.ok || !validation?.valid) {
      console.error(pc.red(`✗ ${validation?.error || `Cloud rejected the key (HTTP ${res.status}).`}`));
      process.exit(1);
    }
  } catch (err: any) {
    console.error(pc.red(`✗ Cannot reach Shogo Cloud at ${cloudUrl}: ${err?.message ?? err}`));
    process.exit(1);
  }

  cfg.apiKey = key;
  cfg.cloudUrl = cloudUrl;
  if (name) cfg.name = name;
  saveConfig(cfg);

  console.log(pc.green('✓ API key saved to ~/.shogo/config.json'));
  if (validation.workspace?.name) console.log(pc.dim('  workspace: ') + validation.workspace.name);
  if (validation.user?.email) console.log(pc.dim('  email:     ') + validation.user.email);
  console.log(pc.dim('  next: ') + 'shogo worker start');
}
