// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Post-compile step for `bun build --compile`: copy the
 * `templates/runtime-template/` tree from the monorepo root into
 * `packages/agent-runtime/dist/runtime-template/` so the compiled
 * binary's standalone-deploy package always ships the template
 * directory next to it.
 *
 * Why this exists: a compiled `agent-runtime` binary has no
 * filesystem access to the source tree. On a self-hosted cli-worker
 * (Linux VPS), `getRuntimeTemplatePath()` exhausts its candidate
 * list and logs `runtime-template not found in any candidate path`,
 * which silently strips Vite/React/Tailwind scaffolding from every
 * project served by that worker.
 *
 * The fix is two-pronged: this script puts the template next to the
 * binary at build time, and `getRuntimeTemplatePath` adds
 * `dirname(process.execPath)/runtime-template` as a candidate path
 * (second priority, after the `RUNTIME_TEMPLATE_DIR` env override).
 *
 * Distribution implication: the prebuilt `agent-runtime` is now a
 * binary AND a sibling `runtime-template/` directory together, not
 * a bare binary. `shogo runtime install` (the next-level installer)
 * must ship both.
 *
 * Usage:
 *   bun run packages/agent-runtime/scripts/copy-runtime-template-to-dist.ts
 *
 * The script is idempotent: any previous `dist/runtime-template/`
 * is wiped first so renames in the source tree don't accumulate
 * stale files in the bundled output.
 */
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materialize } from '../../../scripts/materialize-runtime-template.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// packages/agent-runtime/scripts/* → repo root is up three levels.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const TEMPLATE_SRC = join(REPO_ROOT, 'templates', 'runtime-template')
const PKG_DIST = resolve(__dirname, '..', 'dist')
const TEMPLATE_DEST = join(PKG_DIST, 'runtime-template')

// Same skip list `seedRuntimeTemplate()` applies at runtime — keeping
// it identical means a self-hosted operator's bundled tree is byte-
// exactly the subset that ends up in workspaces, no surprises.
const SKIP_TOP_LEVEL = new Set<string>([
  'node_modules',
  '.shogo',
  // Generated artifacts (prisma client) are workspace-specific.
  'src/generated',
])

function main(): void {
  if (!existsSync(TEMPLATE_SRC)) {
    console.error(`[copy-runtime-template-to-dist] template source not found at ${TEMPLATE_SRC}`)
    process.exit(1)
  }
  // Quick sanity: source is a directory with a package.json.
  if (!statSync(TEMPLATE_SRC).isDirectory()) {
    console.error(`[copy-runtime-template-to-dist] ${TEMPLATE_SRC} is not a directory`)
    process.exit(1)
  }
  if (!existsSync(join(TEMPLATE_SRC, 'package.json'))) {
    console.error(
      `[copy-runtime-template-to-dist] ${TEMPLATE_SRC}/package.json missing — refusing to ship a broken template`,
    )
    process.exit(1)
  }

  mkdirSync(PKG_DIST, { recursive: true })
  if (existsSync(TEMPLATE_DEST)) {
    rmSync(TEMPLATE_DEST, { recursive: true, force: true })
  }

  cpSync(TEMPLATE_SRC, TEMPLATE_DEST, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(TEMPLATE_SRC.length + 1)
      if (!rel) return true
      const topLevel = rel.split('/')[0]
      return !SKIP_TOP_LEVEL.has(topLevel) && !SKIP_TOP_LEVEL.has(rel)
    },
  })

  console.log(`[copy-runtime-template-to-dist] copied ${TEMPLATE_SRC} → ${TEMPLATE_DEST}`)

  // The source template pins `@shogo-ai/sdk` as `workspace:*`, which a pod
  // can't resolve. Rewrite the bundled copy's `package.json` to a concrete
  // `^X.Y.Z` resolved from npm's `latest` dist-tag so the standalone-deploy
  // package installs cleanly (and always tracks the latest published SDK).
  materialize(join(TEMPLATE_DEST, 'package.json'))
  console.log(`[copy-runtime-template-to-dist] materialized @shogo-ai/* pins in ${TEMPLATE_DEST}/package.json`)
}

main()
