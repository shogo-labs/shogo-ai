// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Post-eval runtime validation.
 *
 * After the agent finishes, these checks verify the project's API server
 * (root `server.tsx`) actually boots, CRUD endpoints work, and the
 * generated routes match the schema models.
 *
 * Route discovery reads `src/generated/routes/index.{ts,tsx}` (output of
 * `bunx shogo generate`) to extract the real paths the server registered,
 * rather than reimplementing pluralization.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeCheckResults, ModelCheckResult, WorkspaceIntegrity, ViteBuildReadiness } from './types'

const LOG_PREFIX = 'runtime-check'
const FETCH_TIMEOUT_MS = 5_000
const HEALTH_RETRY_COUNT = 6
const HEALTH_RETRY_DELAY_MS = 5_000
const ROUTE_STABILIZE_RETRIES = 8
const ROUTE_STABILIZE_DELAY_MS = 3_000

// ---------------------------------------------------------------------------
// Route path resolution — matches the SDK's toRoutePath exactly
// ---------------------------------------------------------------------------

function toRoutePath(name: string): string {
  const kebab = name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase()
  if (kebab.endsWith('y')) return kebab.slice(0, -1) + 'ies'
  if (kebab.endsWith('s') || kebab.endsWith('x') || kebab.endsWith('ch') || kebab.endsWith('sh')) {
    return kebab + 'es'
  }
  return kebab + 's'
}

/**
 * Discover registered API routes by reading the generated routes index.
 * The SDK emits `src/generated/routes/index.tsx` (or `.ts`) under the
 * project root. Older legacy outputs (`.shogo/server/generated/...`)
 * are no longer produced; the migration in
 * `migrations/skill-server-to-root.ts` retired that path.
 *
 * Falls back to schema-based toRoutePath if the generated file is missing.
 */
function discoverRoutes(workspaceDir: string, modelNames: string[]): string[] {
  const candidates = [
    join(workspaceDir, 'src', 'generated', 'routes', 'index.tsx'),
    join(workspaceDir, 'src', 'generated', 'routes', 'index.ts'),
    join(workspaceDir, 'src', 'generated', 'index.tsx'),
    join(workspaceDir, 'src', 'generated', 'index.ts'),
  ]
  for (const routesIndex of candidates) {
    if (!existsSync(routesIndex)) continue
    try {
      const content = readFileSync(routesIndex, 'utf-8')
      const paths: string[] = []
      for (const m of content.matchAll(/app\.route\(\s*["']\/([^"']+)["']/g)) {
        paths.push(m[1])
      }
      if (paths.length > 0) return paths
    } catch {}
  }

  return modelNames.map(toRoutePath)
}

// ---------------------------------------------------------------------------
// Schema parsing
// ---------------------------------------------------------------------------

interface ModelInfo {
  name: string
  requiredFields: { name: string; type: string }[]
  /**
   * True when this model is identical (modulo whitespace and trailing
   * `@@map(...)`) to the runtime-template's seeded `User` block. We
   * skip CRUD probes for these because they're scaffolding the agent
   * inherited, not work the eval is testing — and probing them either
   * collides with itself (unique `email`) or breaks when the agent
   * customizes the model in a way our generic test body doesn't satisfy.
   */
  isTemplateSentinel: boolean
}

/**
 * Field set the runtime-template ships in `templates/runtime-template/prisma/schema.prisma`.
 * If a model named `User` has *exactly* this set of fields (order-independent)
 * we treat it as scaffolding rather than agent-authored.
 *
 * Keep in sync with `templates/runtime-template/prisma/schema.prisma`. If
 * the seeded `User` shape changes, update this list — otherwise CRUD
 * probes will start tripping on the new template again.
 */
const SEEDED_USER_FIELDS = new Set(['id', 'email', 'name', 'createdAt', 'updatedAt'])

function isSeededUserBody(name: string, body: string): boolean {
  if (name !== 'User') return false
  const fields = new Set<string>()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue
    const m = trimmed.match(/^(\w+)\s+/)
    if (m) fields.add(m[1])
  }
  if (fields.size !== SEEDED_USER_FIELDS.size) return false
  for (const f of SEEDED_USER_FIELDS) if (!fields.has(f)) return false
  return true
}

function parseModels(schemaPath: string): ModelInfo[] {
  if (!existsSync(schemaPath)) return []
  const content = readFileSync(schemaPath, 'utf-8')
  const models: ModelInfo[] = []
  const modelBlocks = content.matchAll(/^model\s+(\w+)\s*\{([^}]+)\}/gm)
  for (const m of modelBlocks) {
    const name = m[1]
    const body = m[2]
    const requiredFields: { name: string; type: string }[] = []
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('@@')) continue
      const fieldMatch = trimmed.match(/^(\w+)\s+(String|Int|Float|Boolean|DateTime)(\?)?\s*(.*)$/)
      if (!fieldMatch) continue
      const [, fieldName, fieldType, optional, rest] = fieldMatch
      if (optional) continue
      if (rest.includes('@id') || rest.includes('@default') || rest.includes('@updatedAt') || rest.includes('@relation')) continue
      requiredFields.push({ name: fieldName, type: fieldType })
    }
    models.push({ name, requiredFields, isTemplateSentinel: isSeededUserBody(name, body) })
  }
  return models
}

function buildTestBody(model: ModelInfo): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const field of model.requiredFields) {
    switch (field.type) {
      case 'String': body[field.name] = `eval-test-${field.name}`; break
      case 'Int': body[field.name] = 1; break
      case 'Float': body[field.name] = 1.0; break
      case 'Boolean': body[field.name] = false; break
      case 'DateTime': body[field.name] = new Date().toISOString(); break
    }
  }
  return body
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function findCanvasFiles(workspaceDir: string): string[] {
  const canvasDir = join(workspaceDir, 'canvas')
  if (!existsSync(canvasDir)) return []
  try {
    return readdirSync(canvasDir)
      .filter(f => f.endsWith('.ts'))
      .map(f => join(canvasDir, f))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Canvas compilation check
// ---------------------------------------------------------------------------

function findSourceFiles(dir: string): string[] {
  const files: string[] = []
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'generated') {
        files.push(...findSourceFiles(fullPath))
      } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
        files.push(fullPath)
      }
    }
  } catch {}
  return files
}

function checkCanvasCompilation(
  workspaceDir: string,
  verbose?: boolean,
): { compiles: boolean | null; errors: string[] } {
  const srcDir = join(workspaceDir, 'src')
  if (!existsSync(srcDir)) return { compiles: null, errors: [] }

  const srcFiles = findSourceFiles(srcDir)
  if (srcFiles.length === 0) return { compiles: null, errors: [] }

  const compileErrors: string[] = []
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })

  for (const file of srcFiles) {
    try {
      const content = readFileSync(file, 'utf-8')
      transpiler.transformSync(content)
    } catch (e: any) {
      const relPath = file.slice(workspaceDir.length + 1)
      compileErrors.push(`${relPath}: ${e.message}`)
    }
  }

  const compiles = compileErrors.length === 0
  if (verbose) {
    console.log(`  [${LOG_PREFIX}] Canvas compile (${srcFiles.length} files): ${compiles ? 'OK' : `FAIL (${compileErrors.length} error(s))`}`)
    for (const err of compileErrors) console.log(`    ${err}`)
  }

  return { compiles, errors: compileErrors }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<{ ok: boolean; status?: number; data: any; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      return { ok: res.ok, status: res.status, data: json }
    } catch {
      return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message }
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status?: number; data: any; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)
    const text = await res.text()
    try {
      const json = JSON.parse(text)
      return { ok: res.ok, status: res.status, data: json }
    } catch {
      return { ok: false, status: res.status, data: null, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message }
  }
}

// ---------------------------------------------------------------------------
// Workspace integrity check
// ---------------------------------------------------------------------------

function checkWorkspaceIntegrity(workspaceDir: string, verbose?: boolean): WorkspaceIntegrity {
  const schemaPath = join(workspaceDir, 'prisma', 'schema.prisma')
  const generatedRoutesDir = join(workspaceDir, 'src', 'generated', 'routes')
  const generatedFlatDir = join(workspaceDir, 'src', 'generated')

  const schema = existsSync(schemaPath)
  // `schemaHasModels` gates the CRUD-functional eval criterion. We
  // count only agent-authored models — the runtime-template seeds a
  // `User` block on every workspace, and treating that as "the agent
  // built a backend" causes the runtime-check pipeline to probe a
  // model the eval never asked for and dock 15% of maxScore when the
  // probe's generic test body doesn't match the seeded shape.
  let schemaHasModels = false
  if (schema) {
    try {
      const models = parseModels(schemaPath)
      schemaHasModels = models.some(m => !m.isTemplateSentinel)
    } catch {}
  }

  const generated = (() => {
    for (const dir of [generatedRoutesDir, generatedFlatDir]) {
      if (existsSync(dir)) {
        try {
          if (readdirSync(dir).length > 0) return true
        } catch {}
      }
    }
    return false
  })()

  const server = existsSync(join(workspaceDir, 'server.ts')) || existsSync(join(workspaceDir, 'server.tsx'))
  const db = existsSync(join(workspaceDir, 'src', 'lib', 'db.ts')) || existsSync(join(workspaceDir, 'src', 'lib', 'db.tsx'))
  const prismaClient = existsSync(join(workspaceDir, 'node_modules', '@prisma', 'client'))

  const integrity: WorkspaceIntegrity = { schema, schemaHasModels, generated, server, db, prismaClient }

  if (verbose) {
    const items = Object.entries(integrity).map(([k, v]) => `${k}=${v ? 'OK' : 'MISS'}`)
    console.log(`  [${LOG_PREFIX}] Workspace integrity: ${items.join(', ')}`)
  }

  return integrity
}

// ---------------------------------------------------------------------------
// Canvas-API contract check
// ---------------------------------------------------------------------------

function checkCanvasApiContract(
  workspaceDir: string,
  discoveredRoutes: string[],
  verbose?: boolean,
): { valid: boolean | null; orphaned: string[] } {
  const canvasFiles = findCanvasFiles(workspaceDir)
  const srcDir = join(workspaceDir, 'src')
  const srcFiles = existsSync(srcDir) ? findSourceFiles(srcDir) : []
  const allFiles = [...canvasFiles, ...srcFiles]

  if (allFiles.length === 0) return { valid: null, orphaned: [] }

  const fetchUrlPattern = /fetch\(\s*[`"'](?:https?:\/\/localhost:\d+)?\/api\/([^`"'/\s?]+)/g
  const orphaned: string[] = []
  const routeSet = new Set(discoveredRoutes.map(r => r.toLowerCase()))

  for (const filePath of allFiles) {
    try {
      const content = readFileSync(filePath, 'utf-8')
      for (const m of content.matchAll(fetchUrlPattern)) {
        const path = m[1].toLowerCase()
        if (!routeSet.has(path)) {
          orphaned.push(`/api/${m[1]}`)
        }
      }
    } catch {}
  }

  const valid = orphaned.length === 0
  if (verbose) {
    console.log(`  [${LOG_PREFIX}] Canvas-API contract: ${valid ? 'OK' : `${orphaned.length} orphaned fetch(es)`}`)
    for (const o of orphaned) console.log(`    orphaned: ${o}`)
  }

  return { valid, orphaned }
}

// ---------------------------------------------------------------------------
// Vite build readiness check
// ---------------------------------------------------------------------------

function checkViteBuildReadiness(workspaceDir: string, verbose?: boolean): ViteBuildReadiness {
  const hasPackageJson = existsSync(join(workspaceDir, 'package.json'))
  const hasViteConfig = existsSync(join(workspaceDir, 'vite.config.ts')) || existsSync(join(workspaceDir, 'vite.config.js'))
  const hasAppTsx = existsSync(join(workspaceDir, 'src', 'App.tsx')) || existsSync(join(workspaceDir, 'src', 'App.jsx'))
  const hasTsConfig = existsSync(join(workspaceDir, 'tsconfig.json'))
  const hasNodeModules = existsSync(join(workspaceDir, 'node_modules'))
  const hasViteBin = existsSync(join(workspaceDir, 'node_modules', '.bin', 'vite'))

  const ready = hasPackageJson && hasViteConfig && hasAppTsx && hasViteBin

  if (verbose) {
    const items = [
      `package.json=${hasPackageJson ? 'OK' : 'MISS'}`,
      `vite.config=${hasViteConfig ? 'OK' : 'MISS'}`,
      `src/App.tsx=${hasAppTsx ? 'OK' : 'MISS'}`,
      `tsconfig=${hasTsConfig ? 'OK' : 'MISS'}`,
      `node_modules=${hasNodeModules ? 'OK' : 'MISS'}`,
      `vite-bin=${hasViteBin ? 'OK' : 'MISS'}`,
    ]
    console.log(`  [${LOG_PREFIX}] Vite build readiness: ${ready ? 'READY' : 'NOT READY'} (${items.join(', ')})`)
  }

  return { hasPackageJson, hasViteConfig, hasAppTsx, hasTsConfig, hasNodeModules, hasViteBin, ready }
}

// ---------------------------------------------------------------------------
// Main check
// ---------------------------------------------------------------------------

export interface RuntimeCheckOptions {
  workspaceDir: string
  /**
   * Port the project's API server (root `server.tsx`) is reachable on.
   * Historically named `skillServerPort`; that name is preserved as an
   * alias for backwards compatibility with existing eval workers.
   */
  apiServerPort?: number
  /** @deprecated use `apiServerPort` */
  skillServerPort?: number
  canvasExpectedPort?: number
  evalId: string
  verbose?: boolean
}

export async function runRuntimeChecks(opts: RuntimeCheckOptions): Promise<RuntimeCheckResults | null> {
  const { workspaceDir, canvasExpectedPort, evalId, verbose } = opts
  const apiServerPort = opts.apiServerPort ?? opts.skillServerPort ?? 3001
  const canvasPort = canvasExpectedPort ?? apiServerPort
  const schemaPath = join(workspaceDir, 'prisma', 'schema.prisma')
  const hasSchema = existsSync(schemaPath)

  // 0. Canvas compilation check (independent of skill server)
  const { compiles: canvasCompiles, errors: canvasCompileErrors } = checkCanvasCompilation(workspaceDir, verbose)

  // 0a. Vite build readiness (always check when src/ exists or package.json exists)
  const viteBuildReadiness = (existsSync(join(workspaceDir, 'package.json')) || existsSync(join(workspaceDir, 'src')))
    ? checkViteBuildReadiness(workspaceDir, verbose)
    : null

  if (!hasSchema && canvasCompiles === null && !viteBuildReadiness) {
    if (verbose) console.log(`  [${LOG_PREFIX}] No schema.prisma, canvas source files, or Vite project — skipping runtime checks`)
    return null
  }

  const errors: string[] = [...canvasCompileErrors.map(e => `Compile: ${e}`)]
  const modelResults: ModelCheckResult[] = []
  const missingRoutes: string[] = []

  // 0b. Workspace integrity
  const workspaceIntegrity = hasSchema ? checkWorkspaceIntegrity(workspaceDir, verbose) : null

  if (hasSchema && workspaceIntegrity && !workspaceIntegrity.schemaHasModels && canvasCompiles === null) {
    if (verbose) console.log(`  [${LOG_PREFIX}] Schema exists but has no models and no canvas source, skipping runtime checks`)
    return null
  }

  // 1-3. API server checks (only when schema exists)
  let serverHealthy: boolean | null = hasSchema ? false : null
  let healthEndpoint = false
  let canListModels = false
  let canCreateRecord = false

  let discoveredRoutePaths: string[] = []

  if (hasSchema) {
    const baseUrl = `http://localhost:${apiServerPort}`

    // 1. Health check with retries
    for (let attempt = 1; attempt <= HEALTH_RETRY_COUNT; attempt++) {
      const health = await fetchJson(`${baseUrl}/health`)
      healthEndpoint = health.ok && health.data?.ok === true
      if (healthEndpoint) break
      if (attempt < HEALTH_RETRY_COUNT) {
        if (verbose) console.log(`  [${LOG_PREFIX}] Health: FAIL (attempt ${attempt}/${HEALTH_RETRY_COUNT}, retrying in ${HEALTH_RETRY_DELAY_MS / 1000}s...)`)
        await new Promise(r => setTimeout(r, HEALTH_RETRY_DELAY_MS))
      } else {
        errors.push(`Health check failed after ${HEALTH_RETRY_COUNT} attempts: ${health.error || JSON.stringify(health.data)}`)
      }
    }
    if (verbose) console.log(`  [${LOG_PREFIX}] Health: ${healthEndpoint ? 'OK' : 'FAIL'}`)
    serverHealthy = healthEndpoint

    // 2. Discover actual routes and check schema-route completeness.
    // We exclude template-sentinel models (e.g. seeded `User`) from the
    // CRUD probe because they're scaffolding the runtime-template
    // ships, not models the eval is testing. They still get listed in
    // `discoverRoutes` so the route-stabilization probe catches them,
    // but `buildTestBody` is too generic to safely insert into them.
    const allModels = parseModels(schemaPath)
    const sentinelNames = new Set(allModels.filter(m => m.isTemplateSentinel).map(m => m.name))
    const routePaths = discoverRoutes(workspaceDir, allModels.map(m => m.name))
    discoveredRoutePaths = routePaths
    // Routes worth CRUD-probing — sentinel models are template
    // scaffolding and skipped below. If the agent didn't add any
    // models of its own, `canListModels` stays false and the eval
    // criterion is `skip:true` via `schemaHasModels`.
    const probeRoutes = routePaths.filter(rp => {
      const m = allModels.find(am => toRoutePath(am.name).toLowerCase() === rp.toLowerCase())
      return !m || !m.isTemplateSentinel
    })
    canListModels = probeRoutes.length > 0

    // Schema-route completeness: every agent-authored model should
    // have a corresponding route (sentinels are not the eval's
    // responsibility, so don't flag them as missing).
    const routePathSet = new Set(routePaths.map(r => r.toLowerCase()))
    for (const model of allModels) {
      if (model.isTemplateSentinel) continue
      const expected = toRoutePath(model.name).toLowerCase()
      if (!routePathSet.has(expected)) {
        missingRoutes.push(model.name)
      }
    }
    if (verbose && missingRoutes.length > 0) {
      console.log(`  [${LOG_PREFIX}] Missing routes for models: ${missingRoutes.join(', ')}`)
    }

    // Wait for ALL routes to stabilize — the skill server may still be
    // restarting after a schema change. We probe every discovered route
    // (not just the first) because the agent writes models incrementally
    // and a partial generation may serve early routes while later ones 404.
    if (routePaths.length > 0 && serverHealthy) {
      let stabilized = false
      for (let attempt = 1; attempt <= ROUTE_STABILIZE_RETRIES; attempt++) {
        let allOk = true
        for (const rp of routePaths) {
          const probe = await fetchJson(`${baseUrl}/api/${rp}`)
          if (probe.status !== 200 || probe.data?.ok !== true) {
            allOk = false
            break
          }
        }
        if (allOk) {
          stabilized = true
          break
        }
        if (verbose) console.log(`  [${LOG_PREFIX}] Route probe: not all routes ready (attempt ${attempt}/${ROUTE_STABILIZE_RETRIES}, waiting ${ROUTE_STABILIZE_DELAY_MS / 1000}s...)`)
        await new Promise(r => setTimeout(r, ROUTE_STABILIZE_DELAY_MS))
      }
      if (verbose) console.log(`  [${LOG_PREFIX}] Routes stabilized: ${stabilized ? 'YES' : 'NO'} (${routePaths.length} routes)`)
    }

    // 3. Full model CRUD: GET + POST + round-trip GET for every
    //    *agent-authored* model. Sentinel models (e.g. seeded `User`)
    //    are skipped — they're template scaffolding and probing them
    //    either collides with itself on `email @unique` or fails when
    //    the agent renames `name` to a required field.
    for (let i = 0; i < routePaths.length; i++) {
      const routePath = routePaths[i]
      // Re-resolve the model by route path rather than positional index
      // so sentinel skipping is robust to ordering. `model` may be
      // undefined if `discoverRoutes` returned a path that doesn't map
      // back to a parsed model (e.g. fallback pluralization).
      const model = allModels.find(m => toRoutePath(m.name).toLowerCase() === routePath.toLowerCase())
      if (model?.isTemplateSentinel || sentinelNames.has(model?.name ?? '')) {
        if (verbose) console.log(`  [${LOG_PREFIX}] Skipping sentinel model ${model?.name} (template scaffolding)`)
        continue
      }
      const endpoint = `${baseUrl}/api/${routePath}`

      // GET (list)
      const listRes = await fetchJson(endpoint)
      const listOk = listRes.ok && listRes.data?.ok === true && Array.isArray(listRes.data?.items)
      if (!listOk) {
        canListModels = false
        errors.push(`GET /api/${routePath}: ${listRes.error || JSON.stringify(listRes.data)}`)
      }
      if (verbose) console.log(`  [${LOG_PREFIX}] GET /api/${routePath}: ${listOk ? 'OK' : 'FAIL'}`)

      // POST (create) + round-trip GET
      let createOk = false
      let roundTripOk = false
      if (model && serverHealthy) {
        const testBody = buildTestBody(model)
        const createRes = await postJson(endpoint, testBody)
        createOk = createRes.ok && createRes.data?.ok === true && createRes.data?.data != null
        if (!createOk) {
          errors.push(`POST /api/${routePath}: ${createRes.error || JSON.stringify(createRes.data)}`)
        }
        if (verbose) console.log(`  [${LOG_PREFIX}] POST /api/${routePath}: ${createOk ? 'OK' : 'FAIL'}`)

        // Round-trip: GET after POST should return at least 1 item
        if (createOk) {
          const verifyRes = await fetchJson(endpoint)
          roundTripOk = verifyRes.ok && verifyRes.data?.ok === true &&
            Array.isArray(verifyRes.data?.items) && verifyRes.data.items.length > 0
          if (verbose) console.log(`  [${LOG_PREFIX}] Round-trip GET /api/${routePath}: ${roundTripOk ? 'OK' : 'FAIL'}`)
        }

        if (createOk) canCreateRecord = true
      }

      modelResults.push({
        model: model?.name ?? routePath,
        canList: listOk,
        canCreate: createOk,
        roundTripOk,
      })
    }
  }

  // 4. Canvas port check
  let canvasPortCorrect: boolean | null = null
  const canvasFiles = findCanvasFiles(workspaceDir)
  if (canvasFiles.length > 0) {
    canvasPortCorrect = true
    const portPattern = /localhost:(\d+)/g
    // We flag any hard-coded localhost port that isn't the API server's
    // port (3001 by default), since the agent should always use relative
    // `/api/...` URLs from canvas / src code. The legacy 4100-4200
    // range (skill server) is now invalid wherever it appears.
    for (const filePath of canvasFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        for (const match of content.matchAll(portPattern)) {
          const usedPort = parseInt(match[1], 10)
          if (usedPort !== canvasPort && (usedPort === 3001 || (usedPort >= 4100 && usedPort <= 4200))) {
            canvasPortCorrect = false
            errors.push(`Canvas ${filePath} references port ${usedPort}, but the API server is on ${canvasPort}`)
          }
        }
      } catch {}
    }
    if (verbose) console.log(`  [${LOG_PREFIX}] Canvas port: ${canvasPortCorrect ? 'OK' : 'MISMATCH'}`)
  }

  // 5. Canvas-API contract check (only meaningful when routes exist)
  let canvasFetchesValid: boolean | null = null
  let canvasOrphanedFetches: string[] = []
  if (discoveredRoutePaths.length > 0) {
    const contract = checkCanvasApiContract(workspaceDir, discoveredRoutePaths, verbose)
    canvasFetchesValid = contract.valid
    canvasOrphanedFetches = contract.orphaned
    for (const o of canvasOrphanedFetches) {
      errors.push(`Canvas fetches non-existent route: ${o}`)
    }
  }

  if (viteBuildReadiness && !viteBuildReadiness.ready) {
    if (!viteBuildReadiness.hasPackageJson) errors.push('Vite: missing package.json')
    if (!viteBuildReadiness.hasViteConfig) errors.push('Vite: missing vite.config.ts')
    if (!viteBuildReadiness.hasAppTsx) errors.push('Vite: missing src/App.tsx')
    if (!viteBuildReadiness.hasViteBin) errors.push('Vite: missing node_modules/.bin/vite (deps not installed)')
  }

  return {
    serverHealthy,
    healthEndpoint,
    canListModels,
    canCreateRecord,
    modelResults,
    missingRoutes,
    canvasOrphanedFetches,
    canvasFetchesValid,
    workspaceIntegrity,
    canvasPortCorrect,
    canvasCompiles,
    canvasCompileErrors,
    viteBuildReadiness,
    errors,
  }
}
