// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Narrow-view filter for the Agent Files panel.
 *
 * Extracted from `FilesBrowserPanel.tsx` so unit tests can exercise the
 * predicate without pulling in React Native, Expo modules, or the rest of
 * the panel component. The panel re-exports `filterForFilesBrowser` for
 * convenience so call-sites stay readable.
 *
 * Why this exists:
 *   The IDE Monaco file tree wants VS Code semantics — it shows EVERYTHING
 *   the user might want to edit (dotfiles, package.json, node_modules-on-
 *   expand, …). The Agent Files panel intentionally curates a much narrower
 *   view: text content users uploaded, plus app-template scaffolding, minus
 *   the heavy build dirs, dotfiles, and config files that the AGENT writes
 *   /reads on its own (handled via the pinned `WORKSPACE_FILES` section in
 *   the panel).
 *
 *   Previously the agent-runtime baked these UX excludes into the tree
 *   endpoint, which leaked into Monaco and made dotfiles invisible there
 *   too. The fix split the policy: server-side returns a VS Code-like tree
 *   (just `.git` / OS junk hidden + `node_modules` / `dist` / etc. as lazy),
 *   and this filter narrows it down on the client.
 *
 *   Bump the SETs below if a new config file or build artifact starts
 *   showing up in the panel that the user shouldn't see.
 */

import type { FileNode } from '@shogo-ai/sdk/agent'

const FILES_PANEL_HIDDEN_DIRS = new Set([
  // Heavy build/dep dirs — visible in the IDE on expand, never useful here.
  'node_modules',
  'dist', 'build',
  'dist.canvas.staging', 'dist.staging', 'dist.prev',
  '.next', '.cache', '.turbo', '.parcel-cache',
  'coverage', '.nyc_output',
  '__pycache__', '.venv', 'venv',
  // App-internal dirs the user shouldn't be poking at from here.
  'memory', 'scripts',
])

const FILES_PANEL_HIDDEN_FILES = new Set([
  // Agent-managed configs. Surfaced as the `WORKSPACE_FILES` shortcuts in
  // the panel (Agent / Heartbeat / Memory / Tools), so hiding the raw
  // entries here avoids a confusing double-listing.
  'AGENTS.md', 'HEARTBEAT.md', 'MEMORY.md', 'TOOLS.md',
  // Project boilerplate the user doesn't typically edit through this panel.
  'package.json', 'tsconfig.json',
  'vite.config.ts', 'tailwind.config.ts',
  'postcss.config.js', 'postcss.config.mjs',
  'components.json', 'pyrightconfig.json',
  'LICENSE', 'README.md',
  // Internal lockfiles / scaffolding markers.
  'bun.lock', '.app-template',
])

/**
 * Apply the FilesBrowserPanel narrow-view filter to a tree returned by
 * `client.getWorkspaceTree()`. Pure, returns a new array.
 */
export function filterForFilesBrowser(tree: FileNode[]): FileNode[] {
  const out: FileNode[] = []
  for (const node of tree) {
    // Preserve the panel's prior blanket dotfile policy — applies to both
    // files (.env, .gitignore) and directories (.shogo, .vscode, .git).
    // Users seeding agent content shouldn't be sifting through dotfiles.
    if (node.name.startsWith('.')) continue
    if (node.type === 'directory') {
      if (FILES_PANEL_HIDDEN_DIRS.has(node.name)) continue
      out.push({
        ...node,
        children: node.children ? filterForFilesBrowser(node.children) : node.children,
      })
    } else {
      if (FILES_PANEL_HIDDEN_FILES.has(node.name)) continue
      out.push(node)
    }
  }
  return out
}
