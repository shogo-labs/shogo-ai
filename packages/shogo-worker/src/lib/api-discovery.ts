// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Finds the apps/api entry to spawn as the tunnel host.
 *
 * In the monorepo (dev), we resolve the workspace sibling.
 * When published, the worker ships a bundled apps/api copy at ./dist/api/entry.js.
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface Resolved {
  entry: string;
  runner: 'bun' | 'node';
  mode: 'monorepo' | 'bundled';
}

export function findApiEntry(): Resolved {
  const packageRoot = resolve(__dirname, '..', '..');
  const monorepoRoot = resolve(packageRoot, '..', '..');
  const monorepoEntry = join(monorepoRoot, 'apps', 'api', 'src', 'entry.ts');
  const bundledEntry = join(packageRoot, 'dist', 'api', 'entry.js');

  if (existsSync(bundledEntry)) {
    return { entry: bundledEntry, runner: 'node', mode: 'bundled' };
  }
  if (existsSync(monorepoEntry)) {
    return { entry: monorepoEntry, runner: 'bun', mode: 'monorepo' };
  }
  throw new Error(
    `Cannot locate apps/api entry. Looked in:\n  ${bundledEntry}\n  ${monorepoEntry}`,
  );
}
