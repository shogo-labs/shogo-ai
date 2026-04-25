// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `shogo login` — saves an API key to ~/.shogo/config.json.
 *
 * Three ways to supply the key, highest precedence first:
 *   1. `--api-key <key>`  — flag
 *   2. `SHOGO_API_KEY`    — env var (useful in CI)
 *   3. interactive prompt — stdin read; echo suppressed
 *
 * Users create the key in studio.shogo.ai → Settings → API Keys
 * (the page already backed by apps/api/src/routes/api-keys.ts), then
 * paste it here. The key is written with mode 0600 so other local
 * users can't read it.
 */
import pc from 'picocolors';
import { createInterface } from 'node:readline';
import { loadConfig, saveConfig } from '../lib/config.ts';

export interface LoginFlags {
  apiKey?: string;
  cloudUrl?: string;
  name?: string;
}

const DEFAULT_CLOUD_URL = 'https://studio.shogo.ai';

export async function runLogin(flags: LoginFlags): Promise<void> {
  const cfg = loadConfig();
  const cloudUrl = (flags.cloudUrl || cfg.cloudUrl || DEFAULT_CLOUD_URL).replace(/\/$/, '');

  const key = flags.apiKey || process.env.SHOGO_API_KEY || (await promptForKey(cloudUrl));
  if (!key) {
    throw new Error('No API key provided. Aborting.');
  }
  if (!/^shogo_sk_/.test(key)) {
    throw new Error('API key should start with "shogo_sk_". Copy it verbatim from the API Keys page.');
  }

  cfg.apiKey = key;
  cfg.cloudUrl = cloudUrl;
  if (flags.name) cfg.name = flags.name;
  saveConfig(cfg);

  console.log(pc.green('\n✓ API key saved to ~/.shogo/config.json'));
  console.log(pc.dim('  next: shogo worker start'));
}

async function promptForKey(cloudUrl: string): Promise<string> {
  console.log(pc.bold('\nShogo Worker — Login'));
  console.log(pc.dim(`Create a key at ${cloudUrl}/api-keys, then paste it below.\n`));

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    // Hide echo while the user pastes/types the secret.
    const stdin = process.stdin as NodeJS.ReadStream & { isTTY?: boolean };
    const wasRaw = stdin.isTTY ? stdin.isRaw : undefined;
    if (stdin.isTTY) stdin.setRawMode?.(true);
    process.stdout.write('API key: ');

    const answer = await new Promise<string>((resolve) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        const str = chunk.toString('utf8');
        for (const ch of str) {
          if (ch === '\r' || ch === '\n') {
            process.stdin.removeListener('data', onData);
            process.stdout.write('\n');
            resolve(buf);
            return;
          }
          if (ch === '\u0003') { // Ctrl-C
            process.stdout.write('\n');
            process.exit(130);
          }
          if (ch === '\u007f' || ch === '\b') {
            buf = buf.slice(0, -1);
            continue;
          }
          buf += ch;
        }
      };
      process.stdin.on('data', onData);
    });

    if (stdin.isTTY) stdin.setRawMode?.(wasRaw ?? false);
    return answer.trim();
  } finally {
    rl.close();
  }
}
