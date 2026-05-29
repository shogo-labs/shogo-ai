// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Materialize the `workspace:*` `@shogo-ai/*` pins in a shipped/installed
 * copy of the runtime template (or an SDK example) into a concrete
 * `^X.Y.Z` range.
 *
 * Why this exists
 * ---------------
 * `templates/runtime-template/package.json` (and `packages/sdk/examples/*`)
 * reference the SDK as `"@shogo-ai/sdk": "workspace:*"`. That keeps the
 * source from ever going stale — there is no version number to forget to
 * bump. But `workspace:*` only resolves from the monorepo root, so it can
 * NOT be shipped to a pod or installed standalone (`cd templates/
 * runtime-template && bun install` outside the workspace, or a pod that
 * receives the template's `package.json` verbatim). Both would fail with
 * `EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:"`.
 *
 * So every boundary that ships the template to a pod or installs it
 * standalone runs this script first to rewrite `workspace:*` -> `^X.Y.Z`.
 *
 * Where X.Y.Z comes from — and the "SDK released first" guarantee
 * ----------------------------------------------------------------
 * The version is resolved from npm's `latest` dist-tag via
 * `npm view <name> version` (the exact approach proven in
 * .github/workflows/publish-shogo-worker.yml). Because the pin is read
 * *from* the registry, this script can only ever write a version that is
 * already published. That is the mechanism that makes "the SDK gets
 * released first" true by construction — there is no separate publish gate
 * to race. If `packages/sdk` has been bumped to a version that is not yet
 * on npm, the template simply pins the previous published version until
 * the SDK lands, never an unresolvable pin.
 *
 * Offline / local-dev fallback
 * ----------------------------
 * `npm view` needs network. When it fails AND `ALLOW_UNPUBLISHED_SDK_PIN`
 * is set, we fall back to the in-repo `packages/<pkg>/package.json` version
 * and emit a loud warning (the pin is unverified against npm). CI builds,
 * where the published-first guarantee matters, run online and never set the
 * flag, so they can never silently ship an unpublished pin.
 *
 * Usage
 * -----
 *   bun run scripts/materialize-runtime-template.ts [<pkgJsonPath> ...]
 *
 * With no args it defaults to `templates/runtime-template/package.json`.
 * Each caller (bundle-api.mjs, copy-runtime-template-to-dist.ts, Docker/VM
 * builds) passes the concrete manifest it is about to ship or install.
 *
 * Idempotent: a manifest with no `@shogo-ai/* : workspace:*` deps is left
 * untouched (no-op), so it is safe to run on an already-materialized copy.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ sits at the repo root.
const REPO_ROOT = resolve(__dirname, '..')

const DEP_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const

const versionCache = new Map<string, string>()

/**
 * Resolve the version to pin for a single `@shogo-ai/*` package.
 *
 * Primary: npm `latest` dist-tag. Fallback (only with
 * ALLOW_UNPUBLISHED_SDK_PIN=1): the in-repo source version.
 */
function resolveVersion(name: string): string {
  const cached = versionCache.get(name)
  if (cached) return cached

  let version = ''
  try {
    version = execFileSync('npm', ['view', name, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    version = ''
  }

  if (!version) {
    if (process.env.ALLOW_UNPUBLISHED_SDK_PIN === '1') {
      const fallback = readInRepoVersion(name)
      if (fallback) {
        console.warn(
          `[materialize-runtime-template] WARNING: npm view ${name} failed; ` +
            `falling back to in-repo version ${fallback} (UNVERIFIED against npm — ` +
            `ALLOW_UNPUBLISHED_SDK_PIN=1). Do NOT use this for a real release build.`,
        )
        version = fallback
      }
    }
  }

  if (!version) {
    throw new Error(
      `[materialize-runtime-template] could not resolve a published version for ${name} ` +
        `(npm view returned empty). Set ALLOW_UNPUBLISHED_SDK_PIN=1 to fall back to the ` +
        `in-repo version for offline/local builds.`,
    )
  }

  versionCache.set(name, version)
  return version
}

/**
 * Map `@shogo-ai/<pkg>` to its in-repo `packages/<pkg>/package.json`
 * version. Best-effort: returns null if the package isn't found in-tree.
 */
function readInRepoVersion(name: string): string | null {
  const short = name.replace(/^@shogo-ai\//, '')
  const candidate = join(REPO_ROOT, 'packages', short, 'package.json')
  if (!existsSync(candidate)) return null
  try {
    const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * @param pkgJsonPath manifest to rewrite in place.
 * @param resolveFn   version resolver (defaults to npm `latest` dist-tag).
 *                    Injectable so tests can avoid network access.
 */
export function materialize(pkgJsonPath: string, resolveFn: (name: string) => string = resolveVersion): boolean {
  const abs = isAbsolute(pkgJsonPath) ? pkgJsonPath : resolve(process.cwd(), pkgJsonPath)
  if (!existsSync(abs)) {
    throw new Error(`[materialize-runtime-template] manifest not found: ${abs}`)
  }

  const raw = readFileSync(abs, 'utf8')
  const pkg = JSON.parse(raw)

  let changed = false
  for (const key of DEP_KEYS) {
    const deps = pkg[key]
    if (!deps || typeof deps !== 'object') continue
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string' || !spec.startsWith('workspace:')) continue
      if (!name.startsWith('@shogo-ai/')) {
        // Only @shogo-ai/* are published; a non-@shogo-ai workspace dep in a
        // shipped template would be unresolvable. Surface it loudly.
        throw new Error(
          `[materialize-runtime-template] ${abs}: ${key}.${name} is "${spec}" but ` +
            `is not an @shogo-ai/* package — cannot materialize to a published version.`,
        )
      }
      const version = resolveFn(name)
      deps[name] = `^${version}`
      changed = true
      console.log(`[materialize-runtime-template] ${name}: ${spec} -> ^${version} (${abs})`)
    }
  }

  if (changed) {
    // Preserve the trailing-newline style of the original file.
    const trailing = raw.endsWith('\n') ? '\n' : ''
    writeFileSync(abs, JSON.stringify(pkg, null, 2) + trailing)
  } else {
    console.log(`[materialize-runtime-template] no @shogo-ai/* workspace:* deps in ${abs} — no-op`)
  }

  // Hard guard (mirrors publish-shogo-worker.yml): never let a `workspace:`
  // specifier survive into a manifest we are about to ship or install.
  const after = readFileSync(abs, 'utf8')
  if (after.includes('"workspace:')) {
    throw new Error(
      `[materialize-runtime-template] ${abs} still contains a "workspace:" specifier after ` +
        `materialization — refusing to ship a broken manifest.`,
    )
  }

  return changed
}

function main(): void {
  const args = process.argv.slice(2)
  const targets = args.length > 0 ? args : [join(REPO_ROOT, 'templates', 'runtime-template', 'package.json')]
  for (const target of targets) {
    materialize(target)
  }
}

// Only run the CLI when invoked directly (`bun run materialize-runtime-template.ts`),
// not when imported by another build script.
if (import.meta.main) {
  main()
}
