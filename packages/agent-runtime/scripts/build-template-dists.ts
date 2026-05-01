// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Pre-build dist/ for every agent template that ships a `src/App.tsx`.
 *
 * Why: when the API creates a project from a template, the canvas iframe
 * is served by the agent-runtime preview server. While Vite is doing its
 * cold rebuild, the iframe paints whatever `dist/` is already on disk.
 * Without a per-template dist that means the bundled runtime-template's
 * pre-built dist (the generic "Project Ready" page) flashes for ~1-3s.
 *
 * Solution: each template ships its own pre-built dist alongside `src/`.
 * `seedWorkspaceFromTemplate` and `overlayAgentTemplateCodeDirs` cp it
 * with `force: true`, so the canvas paints the template surface from the
 * very first byte. No flash, no race.
 *
 * Usage:
 *   bun run packages/agent-runtime/scripts/build-template-dists.ts            # builds all
 *   bun run packages/agent-runtime/scripts/build-template-dists.ts <id> [<id>...]
 *
 * The script stages a copy of `templates/runtime-template/` in a tmp
 * directory, overlays the agent template's `src/` (and `prisma/` if any)
 * on top, runs `vite build`, then moves the resulting `dist/` into
 * `packages/agent-runtime/templates/<id>/dist/`. Idempotent — old dists
 * are wiped before each rebuild.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const PKG_ROOT = join(__dirname, '..')
const REPO_ROOT = join(PKG_ROOT, '..', '..')
const TEMPLATES_BASE = join(PKG_ROOT, 'templates')
const RUNTIME_TEMPLATE_DIR = join(REPO_ROOT, 'templates', 'runtime-template')

interface BuildResult {
  templateId: string
  ok: boolean
  durationMs: number
  reason?: string
}

function listBuildableTemplates(): string[] {
  if (!existsSync(TEMPLATES_BASE)) return []
  return readdirSync(TEMPLATES_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((id) => existsSync(join(TEMPLATES_BASE, id, 'src', 'App.tsx')))
    .filter((id) => existsSync(join(TEMPLATES_BASE, id, 'template.json')))
    .sort()
}

function copyRuntimeTemplate(stagingDir: string): void {
  // Mirror the same exclusions seedRuntimeTemplate uses, plus dist/ since
  // we're about to produce a fresh one. node_modules is symlinked below
  // (copying it would add minutes per template build).
  const SKIP = new Set(['dist', 'node_modules', '.shogo', 'src/generated'])
  cpSync(RUNTIME_TEMPLATE_DIR, stagingDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(RUNTIME_TEMPLATE_DIR.length + 1)
      if (!rel) return true
      const top = rel.split('/')[0]
      return !SKIP.has(top) && !SKIP.has(rel)
    },
  })
}

function linkNodeModules(stagingDir: string): void {
  const src = join(RUNTIME_TEMPLATE_DIR, 'node_modules')
  if (!existsSync(src)) {
    throw new Error(
      `runtime-template node_modules missing at ${src} — run \`bun install\` in templates/runtime-template/ before building template dists`,
    )
  }
  symlinkSync(src, join(stagingDir, 'node_modules'), 'dir')
}

function overlayTemplate(stagingDir: string, templateId: string): void {
  const templateRoot = join(TEMPLATES_BASE, templateId)
  const srcDir = join(templateRoot, 'src')
  if (existsSync(srcDir)) {
    cpSync(srcDir, join(stagingDir, 'src'), { recursive: true, force: true })
  }
  const prismaDir = join(templateRoot, 'prisma')
  if (existsSync(prismaDir)) {
    mkdirSync(join(stagingDir, 'prisma'), { recursive: true })
    cpSync(prismaDir, join(stagingDir, 'prisma'), { recursive: true, force: true })
  }
  // Stage `.shogo/` too — some templates (e.g. virtual-engineering-team)
  // ship skill markdown under `.shogo/skills/` and import them via Vite's
  // `import.meta.glob('../../.shogo/skills/...')`. That's a valid pattern
  // because `seedWorkspaceFromTemplate` copies `.shogo/` into every
  // workspace, so the same relative path resolves at runtime. Without
  // staging it here, vite build fails with "Could not resolve
  // ../../.shogo/skills/...".
  const shogoDir = join(templateRoot, '.shogo')
  if (existsSync(shogoDir)) {
    cpSync(shogoDir, join(stagingDir, '.shogo'), { recursive: true, force: true })
  }
}

function ensureCleanStaging(stagingDir: string): void {
  if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true })
}

/**
 * Some templates import shadcn/ui components or rely on `@/` aliases that
 * the runtime-template's `tsconfig.json` already sets up. We only need to
 * make sure the staging dir has the right Tailwind/postcss config (which
 * the runtime-template provides) and the template's `index.css` if any.
 */
function buildOnce(templateId: string, stagingDir: string): { ok: boolean; reason?: string } {
  // Use `bun x` instead of `bunx`: bunx isn't always present (CI Linux
  // images, the bundled bun.exe shipped with Shogo Desktop on Windows,
  // pre-1.2 manual installs). `bun x` is built into bun and only needs
  // bun on PATH.
  const result = spawnSync('bun', ['x', 'vite', 'build'], {
    cwd: stagingDir,
    stdio: 'pipe',
    encoding: 'utf-8',
    env: { ...process.env, NODE_ENV: 'production' },
  })
  if (result.status === 0) return { ok: true }
  const stderr = (result.stderr ?? '').trim()
  const stdout = (result.stdout ?? '').trim()
  return {
    ok: false,
    reason: `vite build failed for ${templateId} (status=${result.status})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
  }
}

function moveBuildArtifacts(stagingDir: string, templateId: string): void {
  const stagingDist = join(stagingDir, 'dist')
  if (!existsSync(stagingDist)) {
    throw new Error(`vite build for ${templateId} produced no dist/`)
  }
  const targetDist = join(TEMPLATES_BASE, templateId, 'dist')
  rmSync(targetDist, { recursive: true, force: true })
  mkdirSync(dirname(targetDist), { recursive: true })
  cpSync(stagingDist, targetDist, { recursive: true })
  // Drop a marker so it's obvious this is a generated artefact.
  writeFileSync(
    join(targetDist, '.generated'),
    [
      `# Generated by packages/agent-runtime/scripts/build-template-dists.ts`,
      `# Template: ${templateId}`,
      `# Built at: ${new Date().toISOString()}`,
      '',
    ].join('\n'),
    'utf-8',
  )
}

function buildTemplate(templateId: string): BuildResult {
  const start = Date.now()
  const stagingDir = join(tmpdir(), `shogo-template-build-${templateId}-${process.pid}`)
  try {
    ensureCleanStaging(stagingDir)
    copyRuntimeTemplate(stagingDir)
    linkNodeModules(stagingDir)
    overlayTemplate(stagingDir, templateId)
    const built = buildOnce(templateId, stagingDir)
    if (!built.ok) {
      return { templateId, ok: false, durationMs: Date.now() - start, reason: built.reason }
    }
    moveBuildArtifacts(stagingDir, templateId)
    return { templateId, ok: true, durationMs: Date.now() - start }
  } catch (err: any) {
    return {
      templateId,
      ok: false,
      durationMs: Date.now() - start,
      reason: err?.stack || err?.message || String(err),
    }
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup; tmp will eventually be reaped by the OS.
    }
  }
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2)
  const targets = requested.length > 0 ? requested : listBuildableTemplates()

  if (targets.length === 0) {
    console.log('[build-template-dists] No templates with src/App.tsx found — nothing to do.')
    return
  }

  // Sanity check: bail loudly if the runtime-template's deps are missing —
  // every build below would fail with the same useless message otherwise.
  if (!existsSync(join(RUNTIME_TEMPLATE_DIR, 'node_modules', '.bin', 'vite'))) {
    console.error(
      `[build-template-dists] Vite binary missing at templates/runtime-template/node_modules/.bin/vite.\n` +
        `Run \`cd templates/runtime-template && bun install\` first, then retry.`,
    )
    process.exit(1)
  }

  console.log(`[build-template-dists] Building dists for ${targets.length} template(s):`)
  for (const id of targets) console.log(`  - ${id}`)

  const results: BuildResult[] = []
  for (const id of targets) {
    const start = Date.now()
    process.stdout.write(`[build-template-dists] ${id} ... `)
    const result = buildTemplate(id)
    results.push(result)
    if (result.ok) {
      console.log(`ok (${(result.durationMs / 1000).toFixed(1)}s)`)
    } else {
      console.log(`FAILED (${(result.durationMs / 1000).toFixed(1)}s)`)
      console.error(result.reason)
    }
    void start
  }

  const failed = results.filter((r) => !r.ok)
  console.log(
    `\n[build-template-dists] Done — ${results.length - failed.length}/${results.length} ok` +
      (failed.length ? `, ${failed.length} failed` : ''),
  )
  if (failed.length) process.exit(1)
}

void main()
