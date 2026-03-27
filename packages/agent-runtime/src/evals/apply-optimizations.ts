// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Apply DSPy Optimizations
 *
 * Reads optimized DSPy program JSONs from the results directory,
 * extracts the bootstrapped few-shot demos, and generates a TypeScript
 * module (`optimized-prompts.ts`) with formatted prompt sections that
 * get injected into the agent's system prompt at runtime.
 *
 * Usage:
 *   bun run src/evals/apply-optimizations.ts [--results-dir path] [--dry-run]
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, basename } from 'path'

const RESULTS_DIR = process.argv.includes('--results-dir')
  ? process.argv[process.argv.indexOf('--results-dir') + 1]
  : join(import.meta.dir, 'dspy', 'results')

const DRY_RUN = process.argv.includes('--dry-run')
const OUTPUT_PATH = join(import.meta.dir, '..', 'optimized-prompts.ts')

interface DSPyProgram {
  predict: {
    demos: Record<string, any>[]
    signature: {
      instructions: string
      fields: Array<{ prefix: string; description: string }>
    }
  }
}

function loadProgram(path: string): DSPyProgram | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function getAugmentedDemos(program: DSPyProgram): Record<string, any>[] {
  return program.predict.demos.filter(d => d.augmented)
}

// ---------------------------------------------------------------------------
// Formatters — turn raw demos into concise system-prompt examples
// ---------------------------------------------------------------------------

function formatCanvasExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const examples = demos.slice(0, 4).map((d, i) => {
    const needsApi = d.needs_api_schema ? 'Yes (CRUD app)' : 'No (display only)'
    return `**Example ${i + 1}:** "${d.user_request}"
- Surface: \`${d.surface_id}\`
- Needs API: ${needsApi}
- Tools: ${d.tool_sequence}
- Components: ${d.component_types}`
  })

  return `### Optimized Planning Examples

These examples show the optimal tool sequence for common canvas requests:

${examples.join('\n\n')}`
}

function formatMemoryExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const writes = demos.filter(d => d.should_write === true).slice(0, 2)
  const skips = demos.filter(d => d.should_write === false).slice(0, 2)

  const lines: string[] = []

  if (writes.length > 0) {
    lines.push('**Write memory when:**')
    for (const d of writes) {
      lines.push(`- "${d.conversation_summary}" → Write to ${d.target_file}: "${(d.content || '').substring(0, 80)}..."`)
    }
  }

  if (skips.length > 0) {
    lines.push('\n**Skip memory write when:**')
    for (const d of skips) {
      const reason = (d.reasoning || '').split('.')[0]
      lines.push(`- "${d.conversation_summary}" → Skip (${reason})`)
    }
  }

  return `### Memory Decision Examples

${lines.join('\n')}`
}

function formatPersonalityExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const updates = demos.filter(d => d.should_update === true).slice(0, 2)
  const skips = demos.filter(d => d.should_update === false).slice(0, 2)

  const lines: string[] = []

  if (updates.length > 0) {
    lines.push('**Update personality when:**')
    for (const d of updates) {
      lines.push(`- "${d.conversation_summary}" → Update ${d.file} section "${d.section}"`)
    }
  }

  if (skips.length > 0) {
    lines.push('\n**Don\'t update when:**')
    for (const d of skips) {
      const reason = (d.reasoning || '').split('.')[0]
      lines.push(`- "${d.conversation_summary}" → No update (${reason})`)
    }
  }

  return `### Self-Update Decision Examples

${lines.join('\n')}`
}

function formatToolPlanningExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const examples = demos.slice(0, 5).map(d => {
    const batchable = d.can_batch ? ' (batchable)' : ''
    return `- "${d.user_message}" → \`${d.planned_tool_sequence}\` (~${d.estimated_iterations} iteration${d.estimated_iterations === 1 ? '' : 's'})${batchable}`
  })

  return `## Tool Planning

Before executing, plan the full tool sequence upfront. Complete complex tasks
in fewer LLM iterations by batching independent tool calls.

### Examples

${examples.join('\n')}`
}

function formatSessionSummaryExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const examples = demos.slice(0, 2).map(d => {
    return `**Input:** ${(d.messages_text || '').substring(0, 120)}...
**Summary:** ${d.summary}
**Key facts:** ${d.key_facts}
**Preferences:** ${d.user_preferences}`
  })

  return `### Session Summarization Guide

When compacting conversation history, preserve:
- User name, timezone, and stated preferences
- Key decisions and outcomes
- Active tasks or pending actions

Discard:
- Verbose tool output details
- Repetitive heartbeat checks
- Greeting/small-talk content

${examples.join('\n\n')}`
}

function formatSkillMatchingExamples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''

  const matches = demos.filter(d => d.matched_skill !== 'none').slice(0, 3)
  const noMatches = demos.filter(d => d.matched_skill === 'none').slice(0, 1)

  const lines: string[] = []

  if (matches.length > 0) {
    lines.push('**Match examples:**')
    for (const d of matches) {
      lines.push(`- "${d.user_message}" → skill: \`${d.matched_skill}\` (confidence: ${d.confidence})`)
    }
  }

  if (noMatches.length > 0) {
    lines.push('\n**No match:**')
    for (const d of noMatches) {
      lines.push(`- "${d.user_message}" → no skill matches (confidence: ${d.confidence})`)
    }
  }

  return `### Skill Matching

Match user messages to skills semantically, not just by exact keyword.
Consider the skill's description and purpose, not only trigger phrases.

${lines.join('\n')}`
}

// ---------------------------------------------------------------------------
// Canvas V2 formatters — one per DSPy-optimizable prompt section
// ---------------------------------------------------------------------------

function formatCanvasV2Guide(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''
  const componentSets = demos.slice(0, 5).map(d => d.react_patterns || d.component_types || '').filter(Boolean)
  const patterns = [...new Set(componentSets.join(', ').split(/,\s*/))]
  return `### Optimized Canvas Code Patterns\n\nMost common React patterns: ${patterns.slice(0, 10).join(', ')}`
}

function formatCanvasV2Backend(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''
  const withBackend = demos.filter(d => d.needs_backend === true || d.needs_backend === 'True')
  const examples = withBackend.slice(0, 3).map(d =>
    `- "${d.user_request}" → models: ${d.prisma_models}, endpoints: ${d.api_endpoints || d.fetch_patterns || 'CRUD'}`
  )
  return `### Optimized Backend Patterns\n\n${examples.join('\n')}`
}

function formatCanvasV2React(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''
  const qualityPatterns = demos.slice(0, 5).map(d => d.quality_patterns || d.react_patterns || '').filter(Boolean)
  const patterns = [...new Set(qualityPatterns.join(', ').split(/,\s*/))]
  return `### Optimized React Quality Patterns\n\nAlways apply: ${patterns.slice(0, 8).join(', ')}`
}

function formatCanvasV2Examples(demos: Record<string, any>[]): string {
  if (demos.length === 0) return ''
  const examples = demos.slice(0, 4).map((d, i) => {
    const backend = d.needs_backend ? `Schema: ${d.prisma_models || d.prisma_schema || 'yes'}` : 'No backend'
    return `**Example ${i + 1}:** "${d.user_request}"
- ${backend}
- Canvas: ${d.canvas_files || d.canvas_filename || 'canvas/app.js'}
- Tools: ${d.tool_sequence}
- Patterns: ${d.react_patterns || 'useState'}`
  })
  return `### Optimized Full-Stack Examples\n\n${examples.join('\n\n')}`
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  console.log('='.repeat(60))
  console.log('APPLY DSPy OPTIMIZATIONS')
  console.log('='.repeat(60))
  console.log(`  Results dir: ${RESULTS_DIR}`)
  console.log(`  Output:      ${OUTPUT_PATH}`)
  console.log(`  Dry run:     ${DRY_RUN}`)
  console.log()

  if (!existsSync(RESULTS_DIR)) {
    console.error(`Results directory not found: ${RESULTS_DIR}`)
    console.error('Run the optimization pipeline first: bun run evals:optimize')
    process.exit(1)
  }

  const files = readdirSync(RESULTS_DIR).filter(f => f.endsWith('_optimized.json'))
  if (files.length === 0) {
    console.error('No optimized program files found.')
    process.exit(1)
  }

  console.log(`Found ${files.length} optimized programs:`)
  for (const f of files) console.log(`  - ${f}`)
  console.log()

  // Load programs by track
  const programs: Record<string, DSPyProgram> = {}
  for (const f of files) {
    const program = loadProgram(join(RESULTS_DIR, f))
    if (program) {
      const key = basename(f, '.json').replace('_optimized', '')
      programs[key] = program
    }
  }

  // Extract demos per track
  const emptyProgram = { predict: { demos: [], signature: { instructions: '', fields: [] } } }
  const canvasDemos = [
    ...getAugmentedDemos(programs['canvas_planning'] || emptyProgram),
    ...getAugmentedDemos(programs['canvas_e2e'] || emptyProgram),
  ]
  const memoryDemos = getAugmentedDemos(programs['memory_write'] || emptyProgram)
  const personalityDemos = getAugmentedDemos(programs['personality_self_update'] || emptyProgram)
  const planningDemos = getAugmentedDemos(programs['multiturn_plan'] || emptyProgram)
  const summaryDemos = getAugmentedDemos(programs['multiturn_summarize'] || emptyProgram)
  const skillMatchDemos = getAugmentedDemos(programs['skill_match'] || emptyProgram)

  // Canvas V2 code mode demos
  const canvasV2PlanningDemos = getAugmentedDemos(programs['canvas_v2_planning'] || emptyProgram)
  const canvasV2BackendDemos = getAugmentedDemos(programs['canvas_v2_backend'] || emptyProgram)
  const canvasV2ReactDemos = getAugmentedDemos(programs['canvas_v2_react'] || emptyProgram)
  const canvasV2E2EDemos = getAugmentedDemos(programs['canvas_v2_e2e'] || emptyProgram)

  console.log('Extracted demos:')
  console.log(`  Canvas:      ${canvasDemos.length} demos`)
  console.log(`  Memory:      ${memoryDemos.length} demos`)
  console.log(`  Personality: ${personalityDemos.length} demos`)
  console.log(`  Planning:    ${planningDemos.length} demos`)
  console.log(`  Summary:     ${summaryDemos.length} demos`)
  console.log(`  Skill Match: ${skillMatchDemos.length} demos`)
  console.log(`  Canvas V2 Guide:    ${canvasV2PlanningDemos.length} demos`)
  console.log(`  Canvas V2 Backend:  ${canvasV2BackendDemos.length} demos`)
  console.log(`  Canvas V2 React:    ${canvasV2ReactDemos.length} demos`)
  console.log(`  Canvas V2 Examples: ${canvasV2E2EDemos.length} demos`)
  console.log()

  // Format prompt sections
  const canvasSection = formatCanvasExamples(canvasDemos)
  const memorySection = formatMemoryExamples(memoryDemos)
  const personalitySection = formatPersonalityExamples(personalityDemos)
  const planningSection = formatToolPlanningExamples(planningDemos)
  const summarySection = formatSessionSummaryExamples(summaryDemos)
  const skillSection = formatSkillMatchingExamples(skillMatchDemos)

  // Canvas V2 sections
  const canvasV2GuideSection = formatCanvasV2Guide(canvasV2PlanningDemos)
  const canvasV2BackendSection = formatCanvasV2Backend(canvasV2BackendDemos)
  const canvasV2ReactSection = formatCanvasV2React(canvasV2ReactDemos)
  const canvasV2ExamplesSection = formatCanvasV2Examples(canvasV2E2EDemos)

  // Generate TypeScript module
  const output = `/**
 * Optimized Prompts — Auto-generated by apply-optimizations.ts
 *
 * These prompt sections were generated from DSPy-optimized few-shot demos.
 * DO NOT EDIT MANUALLY — re-run the optimization pipeline and apply script instead.
 *
 * Generated: ${new Date().toISOString()}
 * Source: ${files.length} optimized programs from DSPy bootstrap optimization
 */

export const OPTIMIZED_CANVAS_EXAMPLES = \`${escapeTemplate(canvasSection)}\`

export const OPTIMIZED_MEMORY_GUIDE = \`${escapeTemplate(memorySection)}\`

export const OPTIMIZED_PERSONALITY_GUIDE = \`${escapeTemplate(personalitySection)}\`

export const OPTIMIZED_TOOL_PLANNING_GUIDE = \`${escapeTemplate(planningSection)}\`

export const OPTIMIZED_SESSION_SUMMARY_GUIDE = \`${escapeTemplate(summarySection)}\`

export const OPTIMIZED_SKILL_MATCHING_GUIDE = \`${escapeTemplate(skillSection)}\`

export const OPTIMIZED_CANVAS_V2_GUIDE = \`${escapeTemplate(canvasV2GuideSection)}\`

export const OPTIMIZED_CANVAS_V2_BACKEND_GUIDE = \`${escapeTemplate(canvasV2BackendSection)}\`

export const OPTIMIZED_CANVAS_V2_REACT_GUIDE = \`${escapeTemplate(canvasV2ReactSection)}\`

export const OPTIMIZED_CANVAS_V2_EXAMPLES = \`${escapeTemplate(canvasV2ExamplesSection)}\`
`

  if (DRY_RUN) {
    console.log('--- DRY RUN OUTPUT ---')
    console.log(output)
  } else {
    writeFileSync(OUTPUT_PATH, output, 'utf-8')
    console.log(`Written: ${OUTPUT_PATH}`)
  }

  console.log('\nDone. Update gateway.ts to import from optimized-prompts.ts')
}

function escapeTemplate(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$')
}

main()
