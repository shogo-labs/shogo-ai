// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { app } from 'electron'
import path from 'path'
import fs from 'fs'

const IS_DEV = !app.isPackaged

export function getDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'shogo.db')
}

export function getWorkspacesDir(): string {
  const dir = path.join(getDataDir(), 'workspaces')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

// All dev-mode paths in this file derive from `app.getAppPath()` rather than
// `__dirname`. Reason: `scripts/bundle-main.mjs` re-bundles `main.ts` (and its
// imports, including this file) with `bun build --target node --format cjs`,
// and Bun inlines `__dirname` as a string literal of the source file's
// directory at build time. After bundling, `__dirname` is the path on the
// build machine (`/Users/runner/work/...` on CI), not the runtime CJS value
// Electron's loader would have provided. `app.getAppPath()` is supplied by
// Electron at runtime and is not subject to that inlining; in dev mode it
// returns `apps/desktop/`, which is the same root the old `__dirname/..`
// paths were aiming at.

export function getBunPath(): string {
  const isWindows = process.platform === 'win32'
  const bunExe = isWindows ? 'bun.exe' : 'bun'

  if (IS_DEV) {
    const localBun = path.join(app.getAppPath(), 'resources', 'bun', bunExe)
    if (fs.existsSync(localBun)) return localBun
    // Fall back to system bun in development
    return 'bun'
  }

  return path.join(process.resourcesPath!, 'bun', bunExe)
}

export function getApiDir(): string {
  if (IS_DEV) {
    return path.resolve(app.getAppPath(), '..', 'api')
  }
  return path.join(process.resourcesPath!, 'apps', 'api')
}

export function getWebDir(): string {
  if (IS_DEV) {
    return path.resolve(app.getAppPath(), '..', 'mobile', 'dist')
  }
  return path.join(process.resourcesPath!, 'web')
}

export function getProjectRoot(): string {
  if (IS_DEV) {
    return path.resolve(app.getAppPath(), '..', '..')
  }
  return path.join(process.resourcesPath!)
}
