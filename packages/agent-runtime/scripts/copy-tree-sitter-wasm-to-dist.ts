// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Post-compile step for `bun build --compile`: copy tree-sitter WASM
 * assets that the agent-runtime needs at runtime into
 * `packages/agent-runtime/dist/tree-sitter-wasm/` so the compiled
 * binary's standalone-deploy package always ships them next to it.
 *
 * Why this exists: `web-tree-sitter` resolves its parser-core WASM via
 * `__dirname + "/tree-sitter.wasm"` at runtime. `bun build --compile`
 * resolves `__dirname` AT BUILD TIME and bakes the absolute build-
 * machine filesystem path into the compiled binary. So a Mac-built
 * binary references `/Users/<dev>/.../tree-sitter.wasm` and ENOENT-
 * aborts when the operator runs it on a Linux VPS.
 *
 * The fix has three coordinated parts (see PR #2):
 *   1. This script puts the WASMs next to the binary at build time.
 *   2. `code-extractor.ts` adds `dirname(process.execPath)/
 *      tree-sitter-wasm` as a candidate path.
 *   3. `WorkerRuntimeManager.buildEnv` exports
 *      `TREE_SITTER_WASM_DIR=<bundled>` to the spawned runtime as a
 *      belt-and-suspenders override that's also discoverable via
 *      `env | grep TREE_SITTER`.
 *
 * Distribution implication: the prebuilt `agent-runtime` is now a
 * binary AND a sibling `runtime-template/` directory AND a sibling
 * `tree-sitter-wasm/` directory together. `shogo runtime install`
 * (the next-level installer) must ship all three.
 *
 * Usage:
 *   bun run packages/agent-runtime/scripts/copy-tree-sitter-wasm-to-dist.ts
 *
 * The script is idempotent: any previous `dist/tree-sitter-wasm/` is
 * wiped first so renames in source packages don't accumulate stale
 * files in the bundled output.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// packages/agent-runtime/scripts/* → repo root is up three levels.
const REPO_ROOT = resolve(__dirname, '..', '..', '..')
const PKG_ROOT = resolve(__dirname, '..')
const PKG_DIST = join(PKG_ROOT, 'dist')
const WASM_DEST = join(PKG_DIST, 'tree-sitter-wasm')

/**
 * Languages the agent-runtime can actually parse. This list MUST stay
 * lockstep with `EXTENSION_TO_LANGUAGE` in
 * `packages/agent-runtime/src/code-extractor.ts` — every entry there
 * must have a corresponding `tree-sitter-${lang}.wasm` here, and vice
 * versa. The runtime calls `getLanguage(langId)` with values from
 * `EXTENSION_TO_LANGUAGE`; any WASM we ship outside that set is dead
 * weight that adds ~10MB per language to the artifact.
 *
 * TODO: when `EXTENSION_TO_LANGUAGE` grows (e.g. ruby, php, swift),
 * also append the matching language id here and ensure the
 * tree-sitter-wasms package actually contains it (some grammars are
 * vendored separately).
 *
 * `tsx` is intentionally omitted: `tree-sitter-wasms` ships
 * `tree-sitter-tsx.wasm` as a JSX-aware variant under the same name,
 * which `code-extractor.ts:144-145` resolves directly.
 */
const SUPPORTED_LANGUAGES = [
  'python',
  'typescript',
  'tsx',
  'javascript',
  'go',
  'rust',
  'java',
] as const

/**
 * Walk up from `startDir` looking for an installed copy of `pkgName`
 * inside any `node_modules/<pkgName>/` ancestor. Bun stores packages
 * under `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/` rather
 * than directly in `node_modules/<pkg>/`, so we resolve via Node's
 * module-resolution algorithm by reading `package.json`'s actual
 * filesystem location.
 *
 * Mirrors `findInstalledPkg` in `apps/desktop/scripts/bundle-api.mjs`,
 * adapted to TypeScript with strict typing.
 */
function findInstalledPkg(pkgName: string, startDir: string): string {
  // `import.meta.resolve` is the cleanest path on Bun, but we want to
  // avoid coupling this script to a specific resolver — we ship from
  // many entry points (`bun run`, package.json scripts, manual). Use
  // a require-from-startDir approach via Bun's `Bun.resolveSync` if
  // available, falling back to a manual ancestor walk.
  if (typeof Bun !== 'undefined' && typeof Bun.resolveSync === 'function') {
    try {
      const pkgJson = Bun.resolveSync(`${pkgName}/package.json`, startDir)
      return dirname(pkgJson)
    } catch {
      // Fall through to manual walk.
    }
  }
  let dir = startDir
  while (true) {
    const candidate = join(dir, 'node_modules', pkgName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error(
    `[copy-tree-sitter-wasm-to-dist] could not resolve ${pkgName} starting from ${startDir}. ` +
      `Did you run \`bun install\` at the repo root?`,
  )
}

function copyParserCoreWasm(): void {
  const webTreeSitterDir = findInstalledPkg('web-tree-sitter', PKG_ROOT)
  const src = join(webTreeSitterDir, 'tree-sitter.wasm')
  if (!existsSync(src)) {
    throw new Error(
      `[copy-tree-sitter-wasm-to-dist] ${src} missing — web-tree-sitter@${readPkgVersion(webTreeSitterDir)} ` +
        `does not ship tree-sitter.wasm at its package root. The package layout may have changed; ` +
        `inspect ${webTreeSitterDir} and update this script.`,
    )
  }
  if (!statSync(src).isFile()) {
    throw new Error(`[copy-tree-sitter-wasm-to-dist] ${src} is not a regular file`)
  }
  cpSync(src, join(WASM_DEST, 'tree-sitter.wasm'))
  console.log(`[copy-tree-sitter-wasm-to-dist] copied parser core: ${src}`)
}

function copyLanguageWasms(): void {
  const treeSitterWasmsDir = findInstalledPkg('tree-sitter-wasms', PKG_ROOT)
  const langWasmDir = join(treeSitterWasmsDir, 'out')
  if (!existsSync(langWasmDir)) {
    throw new Error(
      `[copy-tree-sitter-wasm-to-dist] ${langWasmDir} missing — tree-sitter-wasms@${readPkgVersion(treeSitterWasmsDir)} ` +
        `package layout changed; expected an out/ subdirectory of language WASMs.`,
    )
  }

  // Sanity: enumerate what's actually shipped so a missing language
  // surfaces here, not at runtime when an operator first opens a Ruby
  // file. We do NOT silently skip — this script's job is to produce a
  // complete artifact or fail loudly.
  const present = new Set(readdirSync(langWasmDir))
  const missing: string[] = []
  for (const lang of SUPPORTED_LANGUAGES) {
    const fileName = `tree-sitter-${lang}.wasm`
    if (!present.has(fileName)) {
      missing.push(fileName)
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `[copy-tree-sitter-wasm-to-dist] tree-sitter-wasms is missing required language grammars:\n` +
        missing.map((f) => `  - ${f}`).join('\n') +
        `\nLook for ${langWasmDir} contents and reconcile with SUPPORTED_LANGUAGES in this script ` +
        `and EXTENSION_TO_LANGUAGE in code-extractor.ts.`,
    )
  }

  for (const lang of SUPPORTED_LANGUAGES) {
    const fileName = `tree-sitter-${lang}.wasm`
    const src = join(langWasmDir, fileName)
    cpSync(src, join(WASM_DEST, fileName))
  }
  console.log(
    `[copy-tree-sitter-wasm-to-dist] copied ${SUPPORTED_LANGUAGES.length} language grammar(s): ` +
      SUPPORTED_LANGUAGES.join(', '),
  )
}

function readPkgVersion(pkgDir: string): string {
  try {
    const pkgPath = join(pkgDir, 'package.json')
    const text = require('node:fs').readFileSync(pkgPath, 'utf-8') as string
    const parsed = JSON.parse(text) as { version?: string }
    return parsed.version ?? '?'
  } catch {
    return '?'
  }
}

function main(): void {
  // The repo-root touchpoint isn't strictly required (we resolve
  // packages relative to PKG_ROOT) but keeping the constant referenced
  // here keeps the import alive in case future logic needs to read
  // monorepo-level state (e.g. a workspace-pinned tree-sitter-wasms
  // version override).
  void REPO_ROOT

  mkdirSync(PKG_DIST, { recursive: true })
  if (existsSync(WASM_DEST)) {
    rmSync(WASM_DEST, { recursive: true, force: true })
  }
  mkdirSync(WASM_DEST, { recursive: true })

  copyParserCoreWasm()
  copyLanguageWasms()

  console.log(`[copy-tree-sitter-wasm-to-dist] artifacts ready at ${WASM_DEST}`)
}

main()
