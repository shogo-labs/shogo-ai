#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
//
// `shogo` CLI entry shim. Picks an execution mode in this order:
//
//   1. Compiled per-platform binary at $PREFIX/dist/shogo   (in the
//      tarball release — Bun bundled, no runtime deps).
//   2. Bundled JS at ../dist/cli.mjs                        (npm install
//      with no Bun on PATH — Node ESM-loadable).
//   3. Source TS at ../src/cli.ts                            (monorepo
//      / `bun link`ed dev, requires Bun or tsx).
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const compiledBin = join(__dirname, '..', 'dist', process.platform === 'win32' ? 'shogo.exe' : 'shogo');
const distEntry = join(__dirname, '..', 'dist', 'cli.mjs');
const srcEntry = join(__dirname, '..', 'src', 'cli.ts');

if (existsSync(compiledBin)) {
  const child = spawn(compiledBin, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else if (existsSync(distEntry)) {
  await import(distEntry);
} else if (existsSync(srcEntry)) {
  const runner = process.versions.bun ? 'bun' : 'tsx';
  const child = spawn(runner, [srcEntry, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  console.error('shogo: no executable entry found (looked for dist/shogo, dist/cli.mjs, src/cli.ts)');
  console.error('       Reinstall with `npm i -g @shogo-ai/worker` or rebuild via `bun run build`.');
  process.exit(1);
}
