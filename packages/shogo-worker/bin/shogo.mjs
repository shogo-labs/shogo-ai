#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
// Entry shim for `shogo` CLI. Delegates to the TS entry via tsx/bun when present,
// or to compiled JS when installed as a published package.
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcEntry = join(__dirname, '..', 'src', 'cli.ts');
const distEntry = join(__dirname, '..', 'dist', 'cli.js');

const args = process.argv.slice(2);

if (existsSync(distEntry)) {
  await import(distEntry);
} else if (existsSync(srcEntry)) {
  // Dev / monorepo: run via bun if available, else tsx
  const runner = process.env.BUN_INSTALL || process.versions.bun ? 'bun' : 'tsx';
  const child = spawn(runner, [srcEntry, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.error('shogo: neither dist/ nor src/ entry found — broken install?');
  process.exit(1);
}
