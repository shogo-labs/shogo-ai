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
// Canvas Validation (V1 removed — stub returns skip)
// ---------------------------------------------------------------------------

function validateCanvas(_input: Record<string, unknown>): ValidationResult {
  return {
    valid: false,
    score: 0,
    checks: [{ name: 'v1_removed', pass: false, detail: 'V1 canvas validation removed' }],
    errors: ['V1 canvas track is no longer supported'],
  }
}

// ---------------------------------------------------------------------------
// Canvas Interaction Validation (V1 removed — stub returns skip)
// ---------------------------------------------------------------------------

async function validateCanvasInteraction(_input: Record<string, unknown>): Promise<ValidationResult> {
  return {
    valid: false,
    score: 0,
    checks: [{ name: 'v1_removed', pass: false, detail: 'V1 canvas interaction validation removed' }],
    errors: ['V1 canvas_interaction track is no longer supported'],
  }
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
    'web', 'browser',
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
    'web', 'browser',
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
    case 'skill_write':
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
