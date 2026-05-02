// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Quick Commands
 *
 * Builds the per-workspace list of one-click shell commands surfaced in the
 * IDE's terminal rail (and exposed at `GET /terminal/commands`). The list
 * is computed dynamically on each request from three layers, in priority
 * order:
 *
 *   1. Tech-stack defaults — `quickCommands` array in `tech-stacks/<id>/stack.json`.
 *      Authoritative for stack-specific actions (e.g. `expo run:ios`,
 *      `jupyter lab`); wins over any colliding `package.json` script entry
 *      so a stack can tune labels/timeouts.
 *
 *   2. `package.json#scripts` — any script the workspace defines is mapped
 *      through a friendly-label table (`dev` → "Start Dev Server",
 *      `build` → "Rebuild", etc.) and exposed as `bun run <name>`.
 *      Unknown script names fall through with a title-cased label so power
 *      users still see them.
 *
 *   3. File-probe presets — `prisma generate` is offered only if the
 *      workspace contains `prisma/schema.prisma`; `playwright test` only
 *      if a `playwright.config.*` exists; Python presets only when
 *      `requirements.txt` / `pyproject.toml` are present.
 *
 * No LLM round-trip, no agent prompt — the IDE invokes these directly via
 * `POST /terminal/exec`, which spawns the command and streams stdout/stderr
 * back. See `runtime-terminal-routes.ts` for the wiring.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { getTechStackPath } from './workspace-defaults'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QuickCommandCategory =
  | 'package'
  | 'database'
  | 'server'
  | 'test'
  | 'build'
  | 'lint'

export interface QuickCommand {
  id: string
  label: string
  description: string
  command: string
  category: QuickCommandCategory
  dangerous?: boolean
  /** Per-command timeout in ms; defaults to 60_000 in the executor. */
  timeout?: number
}

// ---------------------------------------------------------------------------
// Friendly-label map for well-known npm/bun scripts
// ---------------------------------------------------------------------------

interface ScriptMapping {
  label: string
  description: string
  category: QuickCommandCategory
  timeout?: number
}

/**
 * Maps `package.json#scripts` keys to friendly chip metadata. Anything not
 * listed falls through to a title-cased version of the script name with
 * category `package` so the user can still trigger it.
 */
const SCRIPT_LABELS: Record<string, ScriptMapping> = {
  dev: { label: 'Start Dev Server', description: 'Run the dev server (npm run dev)', category: 'server' },
  start: { label: 'Start', description: 'Run the start script', category: 'server' },
  serve: { label: 'Serve', description: 'Run the serve script', category: 'server' },
  build: { label: 'Rebuild', description: 'Build for production', category: 'build', timeout: 120_000 },
  'build:prod': { label: 'Build (prod)', description: 'Production build', category: 'build', timeout: 180_000 },
  preview: { label: 'Preview Build', description: 'Preview the production build locally', category: 'server' },
  test: { label: 'Run Tests', description: 'Run the test suite', category: 'test', timeout: 180_000 },
  'test:unit': { label: 'Run Unit Tests', description: 'Run the unit test suite', category: 'test', timeout: 180_000 },
  'test:e2e': { label: 'Run E2E Tests', description: 'Run end-to-end tests', category: 'test', timeout: 300_000 },
  'test:watch': { label: 'Test (watch)', description: 'Run tests in watch mode', category: 'test', timeout: 600_000 },
  lint: { label: 'Lint', description: 'Run the linter', category: 'lint', timeout: 60_000 },
  'lint:fix': { label: 'Fix Lint', description: 'Run the linter with --fix', category: 'lint', timeout: 60_000 },
  format: { label: 'Format', description: 'Format the codebase', category: 'lint', timeout: 60_000 },
  typecheck: { label: 'Type Check', description: 'Run TypeScript type checking', category: 'build', timeout: 60_000 },
  'type-check': { label: 'Type Check', description: 'Run TypeScript type checking', category: 'build', timeout: 60_000 },
  tsc: { label: 'Type Check', description: 'Run TypeScript type checking', category: 'build', timeout: 60_000 },
  ios: { label: 'Run iOS', description: 'Launch the iOS simulator build', category: 'server', timeout: 300_000 },
  android: { label: 'Run Android', description: 'Launch the Android emulator build', category: 'server', timeout: 300_000 },
  web: { label: 'Run Web', description: 'Launch the web target', category: 'server' },
}

function titleCase(name: string): string {
  return name
    .replace(/[-_:]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

// ---------------------------------------------------------------------------
// Stack defaults loader
// ---------------------------------------------------------------------------

function readJsonSafe(path: string): any {
  try {
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function readWorkspaceStackId(workspaceDir: string): string | null {
  try {
    const marker = join(workspaceDir, '.tech-stack')
    if (!existsSync(marker)) return null
    const id = readFileSync(marker, 'utf-8').trim()
    return id || null
  } catch {
    return null
  }
}

function loadStackQuickCommands(stackId: string | null): QuickCommand[] {
  if (!stackId) return []
  const stackPath = getTechStackPath(stackId)
  if (!stackPath) return []
  const meta = readJsonSafe(join(stackPath, 'stack.json'))
  const raw = meta?.quickCommands
  if (!Array.isArray(raw)) return []
  return raw.filter(isValidQuickCommand)
}

function isValidQuickCommand(value: unknown): value is QuickCommand {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !v.id) return false
  if (typeof v.label !== 'string' || !v.label) return false
  if (typeof v.command !== 'string' || !v.command) return false
  if (typeof v.category !== 'string') return false
  return true
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function commandsFromPackageJson(workspaceDir: string): QuickCommand[] {
  const pkgPath = join(workspaceDir, 'package.json')
  const pkg = readJsonSafe(pkgPath)
  if (!pkg) return []

  const scripts = pkg?.scripts
  if (!scripts || typeof scripts !== 'object') return []

  const out: QuickCommand[] = []
  for (const [name, value] of Object.entries(scripts)) {
    if (typeof value !== 'string' || !value.trim()) continue
    const mapping = SCRIPT_LABELS[name]
    if (mapping) {
      out.push({
        id: `script-${name}`,
        label: mapping.label,
        description: mapping.description,
        command: `bun run ${name}`,
        category: mapping.category,
        timeout: mapping.timeout,
      })
    } else {
      out.push({
        id: `script-${name}`,
        label: titleCase(name),
        description: `Run \`bun run ${name}\``,
        command: `bun run ${name}`,
        category: 'package',
      })
    }
  }
  return out
}

function commandsFromPrisma(workspaceDir: string): QuickCommand[] {
  if (!existsSync(join(workspaceDir, 'prisma', 'schema.prisma'))) return []
  return [
    {
      id: 'prisma-generate',
      label: 'Generate Prisma Client',
      description: 'Regenerate Prisma client after schema changes',
      // Use `bun x` instead of `bunx`: Shogo Desktop on Windows ships
      // bun.exe without a bunx.exe companion, so the bunx form fails
      // immediately with `'bunx' is not recognized`.
      command: 'bun x prisma generate',
      category: 'database',
    },
    {
      id: 'prisma-push',
      label: 'Push Schema',
      description: 'Push schema changes to the database',
      command: 'bun x prisma db push',
      category: 'database',
    },
    {
      id: 'prisma-migrate',
      label: 'Run Migrations',
      description: 'Create and apply database migrations',
      command: 'bun x prisma migrate dev --name auto',
      category: 'database',
      timeout: 60_000,
    },
    {
      id: 'prisma-reset',
      label: 'Reset Database',
      description: 'Wipe and recreate database from schema (destructive)',
      command: 'bun x prisma db push --force-reset',
      category: 'database',
      dangerous: true,
      timeout: 30_000,
    },
  ]
}

function commandsFromPlaywright(workspaceDir: string): QuickCommand[] {
  const exists =
    existsSync(join(workspaceDir, 'playwright.config.ts')) ||
    existsSync(join(workspaceDir, 'playwright.config.js')) ||
    existsSync(join(workspaceDir, 'playwright.config.mjs'))
  if (!exists) return []
  return [
    {
      id: 'playwright-test',
      label: 'Run Playwright Tests',
      description: 'Run Playwright E2E tests',
      command: 'bun x playwright test',
      category: 'test',
      timeout: 180_000,
    },
    {
      id: 'playwright-test-headed',
      label: 'Playwright (Visible)',
      description: 'Run Playwright tests with browser visible',
      command: 'bun x playwright test --headed',
      category: 'test',
      timeout: 180_000,
    },
  ]
}

function commandsFromPython(workspaceDir: string): QuickCommand[] {
  const out: QuickCommand[] = []

  const reqPath = join(workspaceDir, 'requirements.txt')
  if (existsSync(reqPath)) {
    out.push({
      id: 'pip-install-requirements',
      label: 'Install Deps',
      description: 'Install Python dependencies from requirements.txt',
      command: 'pip install -r requirements.txt',
      category: 'package',
      timeout: 180_000,
    })
  }

  const pyproject = join(workspaceDir, 'pyproject.toml')
  if (existsSync(pyproject)) {
    let raw = ''
    try {
      raw = readFileSync(pyproject, 'utf-8')
    } catch {
      raw = ''
    }
    if (/\[tool\.pytest/.test(raw) || /^\s*pytest\b/m.test(raw)) {
      out.push({
        id: 'pytest',
        label: 'Run Tests',
        description: 'Run the pytest suite',
        command: 'pytest',
        category: 'test',
        timeout: 180_000,
      })
    }
    if (/\[tool\.ruff/.test(raw)) {
      out.push({
        id: 'ruff-check',
        label: 'Lint',
        description: 'Run ruff linter',
        command: 'ruff check .',
        category: 'lint',
        timeout: 60_000,
      })
    }
  }

  return out
}

function commandsFromBunInstall(workspaceDir: string): QuickCommand[] {
  // Always offer `bun install` whenever there's a package.json — the existing
  // PRESET_COMMANDS contract preserved by the test suite.
  if (!existsSync(join(workspaceDir, 'package.json'))) return []
  return [
    {
      id: 'bun-install',
      label: 'Install Dependencies',
      description: 'Install all project dependencies with bun',
      command: 'bun install',
      category: 'package',
      timeout: 120_000,
    },
  ]
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the dynamic per-workspace quick-command list. Cheap (a handful of
 * file reads) and stateless — invoked per request so a freshly added
 * `package.json` script appears in the rail without restarting the runtime.
 *
 * Layering, lowest-priority first (later entries win on `id` collision):
 *   1. `package.json#scripts` (mapped or fallthrough)
 *   2. `bun install`
 *   3. Prisma probe (only if `prisma/schema.prisma` exists)
 *   4. Playwright probe (only if `playwright.config.*` exists)
 *   5. Python probe (`requirements.txt` / `pyproject.toml`)
 *   6. Tech-stack defaults from `stack.json#quickCommands`
 */
export function buildQuickCommands(workspaceDir: string): QuickCommand[] {
  const stackId = readWorkspaceStackId(workspaceDir)

  const layers: QuickCommand[][] = [
    commandsFromPackageJson(workspaceDir),
    commandsFromBunInstall(workspaceDir),
    commandsFromPrisma(workspaceDir),
    commandsFromPlaywright(workspaceDir),
    commandsFromPython(workspaceDir),
    loadStackQuickCommands(stackId),
  ]

  const byId = new Map<string, QuickCommand>()
  for (const layer of layers) {
    for (const cmd of layer) {
      byId.set(cmd.id, cmd)
    }
  }
  return Array.from(byId.values())
}

/**
 * Group a flat list by category, in the same shape `GET /terminal/commands`
 * has historically returned (`Record<category, Array<...>>`).
 */
export function groupQuickCommandsByCategory(
  commands: QuickCommand[],
): Record<string, Array<{
  id: string
  label: string
  description: string
  category: string
  dangerous: boolean
}>> {
  return commands.reduce(
    (acc, cmd) => {
      acc[cmd.category] ??= []
      acc[cmd.category].push({
        id: cmd.id,
        label: cmd.label,
        description: cmd.description,
        category: cmd.category,
        dangerous: cmd.dangerous || false,
      })
      return acc
    },
    {} as Record<string, Array<{
      id: string
      label: string
      description: string
      category: string
      dangerous: boolean
    }>>,
  )
}
