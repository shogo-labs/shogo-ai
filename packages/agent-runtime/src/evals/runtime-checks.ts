// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Post-eval runtime validation.
 *
 * After the agent finishes, these checks verify the skill server actually
 * boots, CRUD endpoints work, and canvas code references the correct port.
 * Results are informational (do not affect the eval score).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RuntimeCheckResults } from './types'

const LOG_PREFIX = 'runtime-check'
const FETCH_TIMEOUT_MS = 5_000

function pluralize(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('s')) return lower + 'es'
  if (lower.endsWith('y')) return lower.slice(0, -1) + 'ies'
  return lower + 's'
}

interface ModelInfo {
  name: string
  requiredFields: { name: string; type: string }[]
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
    models.push({ name, requiredFields })
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

async function fetchJson(url: string): Promise<{ ok: boolean; data: any; error?: string }> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)
    const json = await res.json()
    return { ok: res.ok, data: json }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message }
  }
}

async function postJson(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; data: any; error?: string }> {
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
    const json = await res.json()
    return { ok: res.ok, data: json }
  } catch (e: any) {
    return { ok: false, data: null, error: e.message }
  }
}

export interface RuntimeCheckOptions {
  workspaceDir: string
  skillServerPort: number
  evalId: string
  verbose?: boolean
}

export async function runRuntimeChecks(opts: RuntimeCheckOptions): Promise<RuntimeCheckResults | null> {
  const { workspaceDir, skillServerPort, evalId, verbose } = opts
  const schemaPath = join(workspaceDir, '.shogo/server/schema.prisma')

  if (!existsSync(schemaPath)) {
    if (verbose) console.log(`  [${LOG_PREFIX}] No schema.prisma found, skipping runtime checks`)
    return null
  }

  const baseUrl = `http://localhost:${skillServerPort}`
  const errors: string[] = []

  // 1. Health check
  const health = await fetchJson(`${baseUrl}/health`)
  const healthEndpoint = health.ok && health.data?.ok === true
  if (!healthEndpoint) {
    errors.push(`Health check failed: ${health.error || JSON.stringify(health.data)}`)
  }
  if (verbose) console.log(`  [${LOG_PREFIX}] Health: ${healthEndpoint ? 'OK' : 'FAIL'}`)

  const serverHealthy = healthEndpoint

  // 2. List endpoints for each model
  const models = parseModels(schemaPath)
  let canListModels = models.length > 0

  for (const model of models) {
    const endpoint = `${baseUrl}/api/${pluralize(model.name)}`
    const listRes = await fetchJson(endpoint)
    const listOk = listRes.ok && listRes.data?.ok === true && Array.isArray(listRes.data?.items)
    if (!listOk) {
      canListModels = false
      errors.push(`GET ${endpoint}: ${listRes.error || JSON.stringify(listRes.data)}`)
    }
    if (verbose) console.log(`  [${LOG_PREFIX}] GET /api/${pluralize(model.name)}: ${listOk ? 'OK' : 'FAIL'}`)
  }

  // 3. Create a test record on the first model
  let canCreateRecord = false
  if (models.length > 0 && serverHealthy) {
    const firstModel = models[0]
    const endpoint = `${baseUrl}/api/${pluralize(firstModel.name)}`
    const testBody = buildTestBody(firstModel)
    const createRes = await postJson(endpoint, testBody)
    canCreateRecord = createRes.ok && createRes.data?.ok === true && createRes.data?.data != null
    if (!canCreateRecord) {
      errors.push(`POST ${endpoint}: ${createRes.error || JSON.stringify(createRes.data)}`)
    }
    if (verbose) console.log(`  [${LOG_PREFIX}] POST /api/${pluralize(firstModel.name)}: ${canCreateRecord ? 'OK' : 'FAIL'}`)
  }

  // 4. Canvas port check
  let canvasPortCorrect: boolean | null = null
  const canvasFiles = findCanvasFiles(workspaceDir)
  if (canvasFiles.length > 0) {
    canvasPortCorrect = true
    const portPattern = /localhost:(\d+)/g
    for (const filePath of canvasFiles) {
      try {
        const content = readFileSync(filePath, 'utf-8')
        for (const match of content.matchAll(portPattern)) {
          const usedPort = parseInt(match[1], 10)
          if (usedPort !== skillServerPort && usedPort >= 4100 && usedPort <= 4200) {
            canvasPortCorrect = false
            errors.push(`Canvas ${filePath} references port ${usedPort}, but skill server is on ${skillServerPort}`)
          }
        }
      } catch {}
    }
    if (verbose) console.log(`  [${LOG_PREFIX}] Canvas port: ${canvasPortCorrect ? 'OK' : 'MISMATCH'}`)
  }

  return {
    serverHealthy,
    healthEndpoint,
    canListModels,
    canCreateRecord,
    canvasPortCorrect,
    errors,
  }
}
