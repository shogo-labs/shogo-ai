// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * E2E Validation Harness for DSPy Predictions
 *
 * Executes model predictions against the real agent-runtime and returns
 * structured validation results. Called from Python via subprocess:
 *
 *   echo '{"track":"canvas", ...}' | bun run packages/agent-runtime/src/evals/validate-prediction.ts
 *
 * Input: JSON on stdin with { track, ...prediction fields }
 * Output: JSON on stdout with { valid, score, checks[], errors[] }
 */

import { DynamicAppManager, getByPointer } from '../dynamic-app-manager'
import type { ComponentDefinition } from '../dynamic-app-types'
import type { ModelDefinition } from '../managed-api-runtime'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Check {
  name: string
  pass: boolean
  detail?: string
}

interface ValidationResult {
  valid: boolean
  score: number
  checks: Check[]
  errors: string[]
}

// ---------------------------------------------------------------------------
// Canvas Validation
// ---------------------------------------------------------------------------

function validateCanvas(input: Record<string, unknown>): ValidationResult {
  const checks: Check[] = []
  const errors: string[] = []

  const surfaceId = String(input.surface_id || 'test-surface')
  const componentsJson = String(input.component_tree_json || '[]')
  const dataJson = String(input.data_payload_json || '{}')
  const needsApi = Boolean(input.needs_api_schema)
  const apiModelsJson = String(input.api_models_json || '[]')
  const apiSeedJson = String(input.api_seed_json || '{}')

  let components: ComponentDefinition[]
  let data: Record<string, unknown>
  let apiModels: ModelDefinition[] = []
  let apiSeed: Record<string, unknown[]> = {}

  // Parse component tree
  try {
    components = JSON.parse(componentsJson)
    checks.push({ name: 'component_tree_parseable', pass: true })
  } catch (e) {
    errors.push(`Component tree JSON parse failed: ${e}`)
    checks.push({ name: 'component_tree_parseable', pass: false, detail: String(e) })
    return { valid: false, score: 0, checks, errors }
  }

  // Parse data payload
  try {
    data = JSON.parse(dataJson)
    checks.push({ name: 'data_payload_parseable', pass: true })
  } catch (e) {
    errors.push(`Data payload JSON parse failed: ${e}`)
    checks.push({ name: 'data_payload_parseable', pass: false, detail: String(e) })
    return { valid: false, score: 0, checks, errors }
  }

  // Parse API models/seed if needed
  if (needsApi) {
    try {
      apiModels = JSON.parse(apiModelsJson)
      checks.push({ name: 'api_models_parseable', pass: true })
    } catch (e) {
      errors.push(`API models JSON parse failed: ${e}`)
      checks.push({ name: 'api_models_parseable', pass: false, detail: String(e) })
    }
    try {
      apiSeed = JSON.parse(apiSeedJson)
      checks.push({ name: 'api_seed_parseable', pass: true })
    } catch (e) {
      checks.push({ name: 'api_seed_parseable', pass: false, detail: String(e) })
    }
  }

  // Execute against real DynamicAppManager
  const manager = new DynamicAppManager()

  // Step 1: Create surface
  const createResult = manager.createSurface(surfaceId, surfaceId) as Record<string, unknown>
  const createOk = createResult.ok === true
  checks.push({ name: 'canvas_create', pass: createOk, detail: createOk ? undefined : String(createResult.error) })
  if (!createOk) {
    errors.push(`canvas_create failed: ${createResult.error}`)
    return { valid: false, score: scoreChecks(checks), checks, errors }
  }

  // Step 2: API schema if needed
  if (needsApi && apiModels.length > 0) {
    const schemaResult = manager.applyApiSchema(surfaceId, apiModels) as Record<string, unknown>
    const schemaOk = schemaResult.ok === true
    checks.push({ name: 'canvas_api_schema', pass: schemaOk, detail: schemaOk ? undefined : String(schemaResult.error) })

    if (schemaOk) {
      // Seed data
      for (const [modelName, records] of Object.entries(apiSeed)) {
        if (Array.isArray(records) && records.length > 0) {
          const seedResult = manager.seedApiData(surfaceId, modelName, records as Record<string, unknown>[]) as Record<string, unknown>
          checks.push({
            name: `canvas_api_seed_${modelName}`,
            pass: seedResult.ok === true,
            detail: seedResult.ok ? `${seedResult.inserted} rows` : String(seedResult.error),
          })
        }
      }
    }
  }

  // Step 3: Update components
  if (components.length > 0) {
    const updateResult = manager.updateComponents(surfaceId, components) as Record<string, unknown>
    const updateOk = updateResult.ok === true
    checks.push({ name: 'canvas_update', pass: updateOk, detail: updateOk ? `${updateResult.componentsUpdated} components` : String(updateResult.error) })
    if (!updateOk) errors.push(`canvas_update failed: ${updateResult.error}`)
  } else {
    checks.push({ name: 'canvas_update', pass: false, detail: 'Empty component tree' })
    errors.push('Component tree is empty')
  }

  // Step 4: Set data
  if (Object.keys(data).length > 0) {
    const dataResult = manager.updateData(surfaceId, '/', data) as Record<string, unknown>
    const dataOk = dataResult.ok === true
    checks.push({ name: 'canvas_data', pass: dataOk, detail: dataOk ? undefined : String(dataResult.error) })
    if (!dataOk) errors.push(`canvas_data failed: ${dataResult.error}`)
  }

  // Validate resulting surface state
  const surface = manager.getSurface(surfaceId)
  if (!surface) {
    checks.push({ name: 'surface_exists', pass: false })
    errors.push('Surface does not exist after creation')
    return { valid: false, score: scoreChecks(checks), checks, errors }
  }
  checks.push({ name: 'surface_exists', pass: true })

  // Root component exists and is a layout type
  const root = surface.components.get('root')
  const hasRoot = !!root
  const rootIsLayout = hasRoot && ['Column', 'Row', 'Grid', 'Card'].includes(root!.component)
  checks.push({ name: 'has_root_component', pass: hasRoot, detail: hasRoot ? root!.component : 'missing' })
  checks.push({ name: 'root_is_layout', pass: rootIsLayout, detail: hasRoot ? root!.component : 'no root' })

  // All children references resolve
  let unresolvedChildren = 0
  for (const [, comp] of surface.components) {
    const children: string[] = Array.isArray(comp.children) ? comp.children.filter((c): c is string => typeof c === 'string') : []
    for (const childId of children) {
      if (!surface.components.has(childId)) {
        unresolvedChildren++
      }
    }
  }
  checks.push({
    name: 'children_resolve',
    pass: unresolvedChildren === 0,
    detail: unresolvedChildren > 0 ? `${unresolvedChildren} unresolved` : `all resolved`,
  })

  // Data bindings resolve to non-undefined values
  if (Object.keys(data).length > 0) {
    let totalBindings = 0
    let resolvedBindings = 0
    for (const [, comp] of surface.components) {
      for (const key of ['text', 'value', 'rows', 'data', 'title', 'description']) {
        const val = (comp as Record<string, unknown>)[key]
        if (val && typeof val === 'object' && 'path' in (val as Record<string, unknown>)) {
          totalBindings++
          const path = (val as Record<string, unknown>).path as string
          try {
            const resolved = getByPointer(surface.dataModel, path)
            if (resolved !== undefined) resolvedBindings++
          } catch { /* pointer didn't resolve */ }
        }
      }
    }
    if (totalBindings > 0) {
      checks.push({
        name: 'data_bindings_resolve',
        pass: resolvedBindings === totalBindings,
        detail: `${resolvedBindings}/${totalBindings} bindings resolved`,
      })
    }
  }

  // Component count
  const expectedCount = input.expected_component_count ? Number(input.expected_component_count) : 0
  if (expectedCount > 0) {
    const actualCount = surface.components.size
    const countOk = actualCount >= Math.floor(expectedCount * 0.5)
    checks.push({
      name: 'component_count',
      pass: countOk,
      detail: `${actualCount} actual vs ${expectedCount} expected`,
    })
  }

  const score = scoreChecks(checks)
  return { valid: errors.length === 0, score, checks, errors }
}

// ---------------------------------------------------------------------------
// Canvas Interaction Validation
// ---------------------------------------------------------------------------

interface InteractionStep {
  action: 'trigger' | 'inspect'
  actionName?: string
  mutation?: { endpoint: string; method: string; body?: unknown }
  inspectPath?: string
  expectCount?: number
  expectContains?: string
}

async function validateCanvasInteraction(input: Record<string, unknown>): Promise<ValidationResult> {
  const checks: Check[] = []
  const errors: string[] = []

  const surfaceId = String(input.surface_id || 'test-surface')
  const componentsJson = String(input.component_tree_json || '[]')
  const apiModelsJson = String(input.api_models_json || '[]')
  const apiSeedJson = String(input.api_seed_json || '{}')
  const stepsJson = String(input.interaction_steps_json || '[]')

  let components: ComponentDefinition[]
  let apiModels: ModelDefinition[] = []
  let apiSeed: Record<string, unknown[]> = {}
  let steps: InteractionStep[] = []

  // Parse inputs
  try {
    components = JSON.parse(componentsJson)
    checks.push({ name: 'components_parseable', pass: true })
  } catch (e) {
    errors.push(`Components JSON parse failed: ${e}`)
    checks.push({ name: 'components_parseable', pass: false, detail: String(e) })
    return { valid: false, score: 0, checks, errors }
  }

  try {
    apiModels = JSON.parse(apiModelsJson)
    checks.push({ name: 'api_models_parseable', pass: true })
  } catch (e) {
    checks.push({ name: 'api_models_parseable', pass: false, detail: String(e) })
  }

  try {
    apiSeed = JSON.parse(apiSeedJson)
    checks.push({ name: 'api_seed_parseable', pass: true })
  } catch (e) {
    checks.push({ name: 'api_seed_parseable', pass: false, detail: String(e) })
  }

  try {
    steps = JSON.parse(stepsJson)
    checks.push({ name: 'interaction_steps_parseable', pass: true })
  } catch (e) {
    errors.push(`Interaction steps JSON parse failed: ${e}`)
    checks.push({ name: 'interaction_steps_parseable', pass: false, detail: String(e) })
    return { valid: false, score: scoreChecks(checks), checks, errors }
  }

  // Build the surface
  const manager = new DynamicAppManager()

  const createResult = manager.createSurface(surfaceId, surfaceId) as Record<string, unknown>
  checks.push({ name: 'surface_created', pass: createResult.ok === true })
  if (!createResult.ok) {
    errors.push(`canvas_create failed: ${createResult.error}`)
    return { valid: false, score: scoreChecks(checks), checks, errors }
  }

  // Apply API schema and seed
  if (apiModels.length > 0) {
    const schemaResult = manager.applyApiSchema(surfaceId, apiModels) as Record<string, unknown>
    checks.push({ name: 'api_schema_applied', pass: schemaResult.ok === true })
    if (schemaResult.ok) {
      for (const [modelName, records] of Object.entries(apiSeed)) {
        if (Array.isArray(records) && records.length > 0) {
          const seedResult = manager.seedApiData(surfaceId, modelName, records as Record<string, unknown>[]) as Record<string, unknown>
          checks.push({ name: `seed_${modelName}`, pass: seedResult.ok === true })
        }
      }
      // Load initial data into data model for each model
      for (const model of apiModels) {
        const dataPath = `/${model.name.toLowerCase()}s`
        manager.queryApiData(surfaceId, model.name, undefined, dataPath)
      }
    }
  }

  // Add components
  if (components.length > 0) {
    const updateResult = manager.updateComponents(surfaceId, components) as Record<string, unknown>
    checks.push({ name: 'components_added', pass: updateResult.ok === true })
  }

  // Execute interaction steps
  let stepIdx = 0
  for (const step of steps) {
    stepIdx++
    const stepLabel = `step_${stepIdx}_${step.action}`

    if (step.action === 'trigger') {
      const context: Record<string, unknown> = {}
      if (step.mutation) {
        context._mutation = step.mutation
      }

      manager.deliverAction({
        surfaceId,
        name: step.actionName || 'test_action',
        context,
        timestamp: new Date().toISOString(),
      })

      // Allow async mutation to complete
      if (step.mutation) {
        await new Promise((r) => setTimeout(r, 200))
      }

      checks.push({ name: stepLabel, pass: true, detail: `triggered ${step.actionName || 'test_action'}` })

    } else if (step.action === 'inspect') {
      const surface = manager.getSurface(surfaceId)
      if (!surface) {
        checks.push({ name: stepLabel, pass: false, detail: 'surface not found' })
        errors.push(`Step ${stepIdx}: surface not found during inspection`)
        continue
      }

      if (step.inspectPath) {
        const value = getByPointer(surface.dataModel, step.inspectPath)

        if (step.expectCount !== undefined) {
          const isArray = Array.isArray(value)
          const countMatch = isArray && value.length === step.expectCount
          checks.push({
            name: stepLabel,
            pass: countMatch,
            detail: isArray ? `count=${value.length}, expected=${step.expectCount}` : 'not an array',
          })
          if (!countMatch) {
            errors.push(`Step ${stepIdx}: expected ${step.expectCount} items at ${step.inspectPath}, got ${isArray ? value.length : 'non-array'}`)
          }
        } else if (step.expectContains) {
          const json = JSON.stringify(value).toLowerCase()
          const found = json.includes(step.expectContains.toLowerCase())
          checks.push({ name: stepLabel, pass: found, detail: found ? 'found' : `"${step.expectContains}" not in data` })
          if (!found) {
            errors.push(`Step ${stepIdx}: "${step.expectContains}" not found at ${step.inspectPath}`)
          }
        } else {
          checks.push({ name: stepLabel, pass: value !== undefined, detail: value !== undefined ? 'data present' : 'undefined' })
        }
      } else {
        checks.push({ name: stepLabel, pass: true, detail: `${surface.components.size} components` })
      }
    }
  }

  const score = scoreChecks(checks)
  return { valid: errors.length === 0, score, checks, errors }
}

// ---------------------------------------------------------------------------
// Skill Validation
// ---------------------------------------------------------------------------

function validateSkill(input: Record<string, unknown>): ValidationResult {
  const checks: Check[] = []
  const errors: string[] = []

  const skillName = String(input.skill_name || '')
  const triggerPattern = String(input.trigger_pattern || '')
  const requiredTools = String(input.required_tools || '')
  const skillBody = String(input.skill_body || '')

  // Skill name is kebab-case
  const nameValid = /^[a-z][a-z0-9-]+$/.test(skillName)
  checks.push({ name: 'skill_name_kebab', pass: nameValid, detail: skillName })
  if (!nameValid) errors.push(`Invalid skill name: "${skillName}"`)

  // Trigger pattern has multiple phrases
  const phrases = triggerPattern.split('|').map(p => p.trim()).filter(Boolean)
  checks.push({ name: 'trigger_has_phrases', pass: phrases.length >= 3, detail: `${phrases.length} phrases` })
  if (phrases.length < 2) errors.push('Trigger pattern needs at least 2 phrases')

  // No single-word generic triggers
  const genericWords = new Set(['check', 'do', 'run', 'make', 'get', 'help', 'show'])
  const hasGeneric = phrases.some(p => genericWords.has(p.toLowerCase()))
  checks.push({ name: 'no_generic_triggers', pass: !hasGeneric })

  // Tools are valid
  const VALID_TOOLS = new Set([
    'exec', 'read_file', 'write_file', 'edit_file', 'delete_file',
    'glob', 'grep', 'ls', 'web', 'browser',
    'memory_read', 'memory_search',
    'send_message', 'cron', 'read_lints',
  ])
  const tools = requiredTools.split(',').map(t => t.trim()).filter(Boolean)
  const allValid = tools.every(t => VALID_TOOLS.has(t))
  checks.push({ name: 'tools_valid', pass: allValid, detail: tools.join(', ') })

  // Body has content
  const bodyHasContent = skillBody.trim().length > 20
  checks.push({ name: 'body_has_content', pass: bodyHasContent, detail: `${skillBody.length} chars` })
  if (!bodyHasContent) errors.push('Skill body is too short')

  // Body contains instruction-like content (markdown headings or numbered steps)
  const hasStructure = /^#+\s/m.test(skillBody) || /^\d+\.\s/m.test(skillBody) || /^-\s/m.test(skillBody)
  checks.push({ name: 'body_has_structure', pass: hasStructure })

  const score = scoreChecks(checks)
  return { valid: errors.length === 0, score, checks, errors }
}

// ---------------------------------------------------------------------------
// Multiturn Planning Validation
// ---------------------------------------------------------------------------

function validateMultiturnPlan(input: Record<string, unknown>): ValidationResult {
  const checks: Check[] = []
  const errors: string[] = []

  const plannedSequence = String(input.planned_tool_sequence || '')
  const estimatedIterations = Number(input.estimated_iterations || 0)
  const canBatch = Boolean(input.can_batch)

  const VALID_TOOLS = new Set([
    'exec', 'read_file', 'write_file', 'edit_file', 'delete_file',
    'glob', 'grep', 'ls', 'web', 'browser',
    'memory_read', 'memory_search',
    'send_message', 'cron', 'read_lints',
  ])

  const tools = plannedSequence.split(',').map(t => t.trim()).filter(Boolean)

  // All tools are valid names
  const invalidTools = tools.filter(t => !VALID_TOOLS.has(t))
  checks.push({
    name: 'all_tools_valid',
    pass: invalidTools.length === 0,
    detail: invalidTools.length > 0 ? `invalid: ${invalidTools.join(', ')}` : `${tools.length} valid tools`,
  })

  // Ordering: write_file (schema) should come before write_file (canvas) when both present
  // This is a soft check — multiple write_file calls are expected in v2 code mode

  // Reasonable iteration count
  if (tools.length > 0) {
    const reasonable = estimatedIterations >= 1 && estimatedIterations <= tools.length
    checks.push({ name: 'iterations_reasonable', pass: reasonable, detail: `${estimatedIterations} iterations for ${tools.length} tools` })
  }

  // Batch flag makes sense (independent tools can batch, dependent ones can't)
  if (tools.length > 1) {
    const hasWriteAndEdit = tools.includes('write_file') && tools.includes('edit_file')
    if (hasWriteAndEdit && canBatch) {
      checks.push({ name: 'batch_decision', pass: false, detail: 'marked batchable but edit_file depends on write_file' })
    } else {
      checks.push({ name: 'batch_decision', pass: true })
    }
  }

  const score = scoreChecks(checks)
  return { valid: errors.length === 0, score, checks, errors }
}

// ---------------------------------------------------------------------------
// Memory Write Validation
// ---------------------------------------------------------------------------

function validateMemoryWrite(input: Record<string, unknown>): ValidationResult {
  const checks: Check[] = []
  const errors: string[] = []

  const shouldWrite = Boolean(input.should_write)
  const content = String(input.content || '')
  const targetFile = String(input.target_file || '')

  if (!shouldWrite) {
    // Model decided not to write — validate that content is empty/minimal
    const noSpuriousContent = !content || content.trim().length < 5
    checks.push({ name: 'no_write_no_content', pass: noSpuriousContent })
    return { valid: true, score: scoreChecks(checks), checks, errors }
  }

  // Should write: validate the output
  checks.push({ name: 'has_content', pass: content.trim().length > 0 })
  if (!content.trim()) errors.push('Expected memory content but got empty string')

  checks.push({ name: 'has_target_file', pass: targetFile.length > 0 })

  // Content is concise (under 100 words)
  const wordCount = content.split(/\s+/).filter(Boolean).length
  checks.push({ name: 'content_concise', pass: wordCount <= 100, detail: `${wordCount} words` })

  // Target file is valid format (MEMORY.md or YYYY-MM-DD)
  const validTarget = targetFile === 'MEMORY.md' || /^\d{4}-\d{2}-\d{2}$/.test(targetFile)
  checks.push({ name: 'target_file_valid', pass: validTarget, detail: targetFile })

  const score = scoreChecks(checks)
  return { valid: errors.length === 0, score, checks, errors }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function scoreChecks(checks: Check[]): number {
  if (checks.length === 0) return 0
  const passed = checks.filter(c => c.pass).length
  return passed / checks.length
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const stdin = await Bun.stdin.text()
  let input: Record<string, unknown>

  try {
    input = JSON.parse(stdin)
  } catch (e) {
    console.log(JSON.stringify({ valid: false, score: 0, checks: [], errors: [`Invalid JSON input: ${e}`] }))
    process.exit(1)
  }

  const track = String(input.track || '')
  let result: ValidationResult

  switch (track) {
    case 'canvas':
      result = validateCanvas(input)
      break
    case 'canvas_interaction':
      result = await validateCanvasInteraction(input)
      break
    case 'skill_create':
      result = validateSkill(input)
      break
    case 'multiturn_plan':
      result = validateMultiturnPlan(input)
      break
    case 'memory_write':
      result = validateMemoryWrite(input)
      break
    default:
      result = { valid: false, score: 0, checks: [], errors: [`Unknown track: ${track}`] }
  }

  console.log(JSON.stringify(result))
}

main()
