// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Notices when a shell command creates something in HOME that the encrypted
 * home archive ({@link ./home-state}) will not keep, so the exec result can
 * tell the agent before a restart silently loses it (a CLI login under
 * `~/.openart`, a token under `~/.local/share/<tool>`).
 *
 * Only top-level HOME entries and the children of `~/.local/share` and
 * `~/.local/state` are compared: a few `readdirSync` calls per exec, no
 * recursion. Whatever exists when the watch is primed (the image, the runtime,
 * the workspace) is the baseline and never reported.
 */

import { readdirSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { HOME_STATE_PATHS } from './home-state'
import { homeStateConfigFromEnv } from './home-state-routes'

/** Directories whose children are watched individually (XDG data and state). */
const NESTED_DIRS = ['.local/share', '.local/state'] as const

/** Names that are caches, tool stores, or shell noise: losing them costs a reinstall at most. */
const IGNORED_NAMES = new Set<string>([
  '.cache',
  '.npm',
  '.bun',
  '.cargo',
  '.rustup',
  '.pnpm-store',
  '.yarn',
  '.node-gyp',
  'node_modules',
  '.lesshst',
  '.wget-hsts',
  '.local',
  'pnpm',
])

const PERSISTED = new Set<string>(HOME_STATE_PATHS)

function ignored(name: string): boolean {
  return (
    IGNORED_NAMES.has(name) ||
    name.endsWith('_history') ||
    name.startsWith('.shogo-home-restore-')
  )
}

function list(homeDir: string): string[] {
  const out: string[] = []
  try {
    for (const name of readdirSync(homeDir)) {
      if (!PERSISTED.has(name) && !ignored(name)) out.push(name)
    }
  } catch {
    return out
  }
  for (const dir of NESTED_DIRS) {
    try {
      for (const name of readdirSync(join(homeDir, dir))) {
        if (!ignored(name)) out.push(`${dir}/${name}`)
      }
    } catch {}
  }
  return out
}

export interface HomeWatch {
  /** Record the baseline if it has not been recorded yet. */
  prime(): void
  /** Entries created since the last check, each reported once. Empty until primed. */
  checkNew(): string[]
}

export function createHomeWatch(homeDir: string, opts: { ignore?: string[] } = {}): HomeWatch {
  let seen: Set<string> | null = null
  const extra = new Set(opts.ignore ?? [])
  return {
    prime() {
      if (!seen) seen = new Set(list(homeDir))
    },
    checkNew() {
      if (!seen) {
        seen = new Set(list(homeDir))
        return []
      }
      const fresh: string[] = []
      for (const rel of list(homeDir)) {
        if (seen.has(rel)) continue
        seen.add(rel)
        if (!extra.has(rel)) fresh.push(rel)
      }
      return fresh
    },
  }
}

let current: { homeDir: string; watch: HomeWatch } | null = null

/**
 * The process-wide watch, or null where home persistence is off (desktop,
 * local, published, no key). Rebuilt if HOME moves, which only tests do.
 */
export function getHomeWatch(workspaceDir: string, env: NodeJS.ProcessEnv = process.env): HomeWatch | null {
  const cfg = homeStateConfigFromEnv(env)
  if (!cfg) return null
  if (current?.homeDir === cfg.homeDir) return current.watch
  const rel = relative(cfg.homeDir, workspaceDir)
  const ignore = rel && !rel.startsWith('..') && !isAbsolute(rel) ? [rel.split(sep)[0]!] : []
  current = { homeDir: cfg.homeDir, watch: createHomeWatch(cfg.homeDir, { ignore }) }
  return current.watch
}

/** Test seam: forget the process-wide watch. */
export function resetHomeWatch(): void {
  current = null
}

/** The note added to an exec result when {@link HomeWatch.checkNew} found something. */
export function homeNotPersistedNote(paths: string[]): string {
  const shown = paths.map((p) => `~/${p}`).join(', ')
  const first = paths[0]!.split('/').pop()!.replace(/^\./, '')
  return (
    `${shown} ${paths.length === 1 ? 'was' : 'were'} created but will NOT be saved across restarts ` +
    `(only ~/.ssh, ~/.oci, ~/.aws, ~/.kube, ~/.docker, ~/.gnupg, ~/.config/<tool>, ~/.gitconfig, ~/.netrc, ` +
    `~/.git-credentials, ~/.bashrc and ~/.profile are). If it holds login, token or OAuth state, point the tool ` +
    `at ~/.config/${first} with its config-dir env var or flag, or move it to ~/.config/${first} and symlink the old path to it.`
  )
}
