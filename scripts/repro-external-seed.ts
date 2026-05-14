#!/usr/bin/env bun
/**
 * Reproduce the "external project seeding" bug in isolation.
 *
 * Faithfully replays the destructive sequence in
 *   packages/agent-runtime/src/server.ts :: ensureWorkspaceFiles()
 *
 * Inlined (no imports from `@shogo/agent-runtime`) so the script runs
 * standalone — useful for verifying the fix without a full dev-server
 * boot, and for proving the bug exists even when the workspace
 * dependencies aren't installed.
 *
 * Usage:
 *   bun scripts/repro-external-seed.ts [<workspace-dir>] [--fixed]
 *
 *   --fixed: short-circuit at the WORKING_MODE='external' guard (the fix
 *            applied to ensureWorkspaceFiles) — only `.shogo/` is touched.
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  cpSync,
  rmSync,
  statSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const WORKSPACE_DIR = process.argv[2] ?? '/tmp/shogo-external-repro'
const FIXED = process.argv.includes('--fixed')
const __dirname = dirname(fileURLToPath(import.meta.url))

function md5OfTree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  function walk(rel: string): void {
    const abs = join(dir, rel)
    for (const entry of readdirSync(abs)) {
      if (entry === '.git') continue
      const relPath = rel ? `${rel}/${entry}` : entry
      const absPath = join(abs, entry)
      // Use lstat first so we can record broken-symlink entries without
      // crashing on stat()'s ENOENT (the whole point of testing scenario C).
      let lst
      try { lst = lstatSync(absPath) } catch { continue }
      if (lst.isSymbolicLink()) {
        try {
          const st = statSync(absPath)
          if (st.isDirectory()) { walk(relPath); continue }
          if (st.isFile()) {
            out.set(relPath, createHash('md5').update(readFileSync(absPath)).digest('hex'))
            continue
          }
        } catch {
          out.set(relPath, 'SYMLINK_DANGLING')
          continue
        }
      }
      if (lst.isDirectory()) walk(relPath)
      else if (lst.isFile()) out.set(relPath, createHash('md5').update(readFileSync(absPath)).digest('hex'))
    }
  }
  walk('')
  return out
}

function snapshot(label: string): void {
  console.log(`\n--- ${label} ---`)
  for (const entry of readdirSync(WORKSPACE_DIR).sort()) console.log(`  ${entry}`)
}

function safeMoveSync(src: string, dest: string): void {
  try { renameSync(src, dest); return } catch {}
  cpSync(src, dest, { recursive: true, force: true, errorOnExist: false })
  rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

// --- Replicas of the relevant workspace-defaults helpers -----------------

function removeStaleShogoSymlink(dir: string): void {
  const shogoDir = join(dir, '.shogo')
  try {
    const st = lstatSync(shogoDir)
    if (st.isSymbolicLink()) {
      try { statSync(shogoDir) } catch { rmSync(shogoDir, { force: true }) }
    }
  } catch {}
}

function seedWorkspaceDefaults_external(dir: string): void {
  removeStaleShogoSymlink(dir)
  const shogoPath = join(dir, '.shogo')
  if (existsSync(shogoPath)) {
    const st = lstatSync(shogoPath)
    if (!st.isDirectory() && !st.isSymbolicLink()) {
      throw new Error(
        `Cannot bind external project: '${shogoPath}' exists and is not a directory. ` +
          `Move or rename the existing file, then re-open the folder.`,
      )
    }
  }
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'local'), { recursive: true })
}

function getRuntimeTemplatePath(): string | null {
  const candidates = [
    join(__dirname, '..', 'packages', 'agent-runtime', 'templates', 'runtime-template'),
  ]
  for (const p of candidates) {
    if (existsSync(join(p, 'package.json'))) {
      try { return realpathSync(p) } catch { return p }
    }
  }
  return null
}

const RUNTIME_TEMPLATE_SKIP = new Set(['node_modules', '.shogo', 'src/generated'])
function seedRuntimeTemplate(dir: string): boolean {
  if (existsSync(join(dir, 'package.json'))) return false
  const templatePath = getRuntimeTemplatePath()
  if (!templatePath) { console.warn('[repro] runtime-template not found'); return false }
  cpSync(templatePath, dir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(templatePath.length + 1)
      if (!rel) return true
      const top = rel.split('/')[0]
      return !RUNTIME_TEMPLATE_SKIP.has(top) && !RUNTIME_TEMPLATE_SKIP.has(rel)
    },
  })
  return true
}

function seedLSPConfig(dir: string): void {
  writeFileSync(join(dir, 'pyrightconfig.json'), JSON.stringify({
    pythonVersion: '3.11', typeCheckingMode: 'basic',
    reportMissingImports: true, reportMissingModuleSource: false,
    reportOptionalMemberAccess: true,
    exclude: ['.shogo', 'node_modules', 'canvas'],
  }, null, 2), 'utf-8')
}

// --- Replica of ensureWorkspaceFiles() ----------------------------------

function ensureWorkspaceFiles_replica(): void {
  // THE FIX (applied in server.ts on the same branch): short-circuit
  // for external projects. Only `.shogo/{skills,plans,local}` is
  // created — everything else is owned by the user.
  if (FIXED && process.env.WORKING_MODE === 'external') {
    seedWorkspaceDefaults_external(WORKSPACE_DIR)
    return
  }

  seedWorkspaceDefaults_external(WORKSPACE_DIR)

  const legacyPkgJson = join(WORKSPACE_DIR, 'package.json')
  const agentsMd = join(WORKSPACE_DIR, 'AGENTS.md')
  if (existsSync(legacyPkgJson) && !existsSync(agentsMd)) {
    console.log('[repro] LEGACY APP MIGRATION TRIGGERED — user files will be moved into project/')
    const projectDir = join(WORKSPACE_DIR, 'project')
    mkdirSync(projectDir, { recursive: true })
    const appFiles = ['package.json', 'bun.lock', 'tsconfig.json', 'vite.config.ts', 'tailwind.config.ts', 'postcss.config.js', 'components.json', '.gitignore']
    for (const f of appFiles) {
      const src = join(WORKSPACE_DIR, f)
      if (existsSync(src)) safeMoveSync(src, join(projectDir, f))
    }
    for (const d of ['src', 'prisma', 'dist', 'public', 'node_modules']) {
      const src = join(WORKSPACE_DIR, d)
      if (existsSync(src)) safeMoveSync(src, join(projectDir, d))
    }
    seedWorkspaceDefaults_external(WORKSPACE_DIR)
  }

  const seeded = seedRuntimeTemplate(WORKSPACE_DIR)
  console.log(`[repro] seedRuntimeTemplate returned ${seeded}`)
  seedLSPConfig(WORKSPACE_DIR)
}

// --- Execute ------------------------------------------------------------

process.env.WORKING_MODE = 'external'
const before = md5OfTree(WORKSPACE_DIR)
snapshot('BEFORE')

ensureWorkspaceFiles_replica()

snapshot('AFTER')
const after = md5OfTree(WORKSPACE_DIR)

// `.shogo` and everything under it is agent-owned: the boot legitimately
// adds the standard subdirs, and it may replace a broken `.shogo` symlink
// with a real directory. Mutations there are expected; only changes
// OUTSIDE `.shogo/` count as damage to the user.
const isAgentOwned = (p: string) => p === '.shogo' || p.startsWith('.shogo/')
const damage: string[] = []
for (const [path, hash] of before) {
  if (isAgentOwned(path)) continue
  if (!after.has(path)) damage.push(`MISSING  ${path}`)
  else if (after.get(path) !== hash) damage.push(`MUTATED  ${path}`)
}
for (const path of after.keys()) {
  if (isAgentOwned(path)) continue
  if (!before.has(path)) damage.push(`ADDED    ${path}`)
}

console.log('\n--- DAMAGE REPORT ---')
if (damage.length === 0) {
  console.log('  none — only `.shogo/` was touched. FIX VERIFIED.')
  process.exit(0)
} else {
  for (const line of damage) console.log(`  ${line}`)
  console.log(`\n${damage.length} non-.shogo paths damaged. BUG REPRODUCED.`)
  process.exit(1)
}
