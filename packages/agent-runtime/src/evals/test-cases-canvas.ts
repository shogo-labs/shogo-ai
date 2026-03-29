// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas Eval Test Cases
 *
 * Tests the agent's ability to build dynamic UIs using canvas_* tools.
 * These run against a REAL agent-runtime server — the agent decides what
 * tools to use, executes them, and we validate the actual results.
 *
 * Validation queries the /agent/dynamic-app/state endpoint to verify
 * surfaces, components, and data bindings actually exist.
 */

import type { AgentEval, EvalResult, ValidationPhase } from './types'
import { usedTool, neverUsedTool, toolCallCount, responseContains, usedToolSuccessfully, successfulToolCallCount } from './eval-helpers'
import { CICD_PIPELINE_MOCKS } from './tool-mocks'

// ---------------------------------------------------------------------------
// Canvas-specific helpers
// ---------------------------------------------------------------------------

function canvasState(result: EvalResult): any {
  const stateCall = result.toolCalls.find(t =>
    t.name === 'canvas_create' || t.name === 'canvas_update' || t.name === 'canvas_data'
  )
  return stateCall?.output
}

/**
 * Check that at least one canvas_trigger_action call returned ok: true.
 */
function triggerActionSucceeded(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'canvas_trigger_action') return false
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('"ok":true') || output.includes('"ok": true')
  })
}

/**
 * Check that all Button components in canvas_update calls have a mutation
 * in their action definition.
 */
function allButtonsHaveMutations(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  if (updateCalls.length === 0) return false
  for (const call of updateCalls) {
    const inputStr = JSON.stringify(call.input ?? '')
    const componentArrayMatch = inputStr.match(/"components"\s*:\s*\[/)
    if (!componentArrayMatch) continue
    const buttonRe = /"component"\s*:\s*"Button"/g
    let match: RegExpExecArray | null
    while ((match = buttonRe.exec(inputStr)) !== null) {
      const surroundingStart = Math.max(0, match.index - 500)
      const surroundingEnd = Math.min(inputStr.length, match.index + 500)
      const surroundingChunk = inputStr.slice(surroundingStart, surroundingEnd)
      if (surroundingChunk.includes('"action"') && !surroundingChunk.includes('"mutation"')) {
        return false
      }
    }
  }
  return true
}

/**
 * Check that canvas_trigger_action output shows actual data changes
 * (the "changes" array is populated or "VERIFIED" appears).
 */
function triggerActionChangedData(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'canvas_trigger_action') return false
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('count_changed') || output.includes('VERIFIED') || output.includes('"type":"added"')
  })
}

/**
 * Check that at least one canvas_inspect call occurs after at least one
 * canvas_trigger_action call. Handles the common pattern where a pre-flight
 * inspect occurs before the first trigger.
 */
function inspectAfterTrigger(result: EvalResult): boolean {
  const firstTrigger = result.toolCalls.findIndex(t => t.name === 'canvas_trigger_action')
  if (firstTrigger < 0) return false
  return result.toolCalls.some((t, i) => t.name === 'canvas_inspect' && i > firstTrigger)
}

/**
 * Check that all successful canvas_trigger_action calls have resolvedFromButton: true,
 * meaning the mutation was resolved from the actual button component definition.
 */
function allTriggersResolvedFromButton(result: EvalResult): boolean {
  const triggerCalls = result.toolCalls.filter(t => t.name === 'canvas_trigger_action')
  if (triggerCalls.length === 0) return false
  const successfulTriggers = triggerCalls.filter(t => {
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('"ok":true') || output.includes('"ok": true')
  })
  if (successfulTriggers.length === 0) return false
  return successfulTriggers.every(t => {
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('"resolvedFromButton":true') || output.includes('"resolvedFromButton": true')
  })
}

/**
 * Check that no canvas_trigger_action outputs contain unresolved parameter warnings.
 */
function noUnresolvedParamWarnings(result: EvalResult): boolean {
  const triggerCalls = result.toolCalls.filter(t => t.name === 'canvas_trigger_action')
  return triggerCalls.every(t => {
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return !output.includes('unresolved parameter')
  })
}

/**
 * Check that a canvas_trigger_action call produced output containing a specific
 * HTTP method (in the resolvedMutation). This replaces checking t.input for
 * method names since the new API resolves the mutation from the button definition.
 */
function triggerOutputContainsMethod(result: EvalResult, method: string): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'canvas_trigger_action') return false
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes(method)
  })
}

/**
 * Check that canvas_update response includes a testChecklist (buttons to test).
 */
function updateHasTestChecklist(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  return updateCalls.some(t => {
    const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
    return output.includes('testChecklist')
  })
}

// ---------------------------------------------------------------------------
// Search & filter helpers
// ---------------------------------------------------------------------------

/**
 * Check that at least one canvas_update call includes a TextField component.
 */
function hasTextField(result: EvalResult): boolean {
  const json = JSON.stringify(result.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
  return json.includes('"TextField"')
}

/**
 * Check that at least one TextField in canvas_update calls has a dataPath prop.
 */
function textFieldHasDataPath(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  const textFieldPattern = /"component"\s*:\s*"TextField"[^}]*"dataPath"\s*:/
  return textFieldPattern.test(json)
}

/**
 * Check that a DataList component in canvas_update calls includes filterPath
 * and filterFields props (client-side search wiring).
 */
function hasDataListWithFilter(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  return json.includes('"filterPath"') && json.includes('"filterFields"')
}

/**
 * Check that a Select component is present in canvas_update calls.
 */
function hasSelectComponent(result: EvalResult): boolean {
  const json = JSON.stringify(result.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
  return json.includes('"Select"')
}

// ---------------------------------------------------------------------------
// Basic agent display-only helpers
// ---------------------------------------------------------------------------

const FORBIDDEN_INTERACTIVE_COMPONENTS = ['TextField', 'Select', 'Checkbox', 'ChoicePicker']

/**
 * True if NO canvas_update call includes any forbidden interactive component
 * (TextField, Select, Checkbox, ChoicePicker).
 */
function noForbiddenInteractiveComponents(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  return FORBIDDEN_INTERACTIVE_COMPONENTS.every(c => !json.includes(`"${c}"`))
}

/**
 * True if any Button component in canvas_update uses a non-OPEN mutation method.
 */
function hasNonOpenButtonMutation(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  const methodPattern = /"method"\s*:\s*"(POST|PATCH|DELETE)"/i
  return methodPattern.test(json)
}

// ---------------------------------------------------------------------------
// sendToAgent helpers
// ---------------------------------------------------------------------------

/**
 * True if any Button in canvas_update calls has sendToAgent: true.
 */
function hasSendToAgentButton(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  return json.includes('"sendToAgent":true') || json.includes('"sendToAgent": true')
}

/**
 * True if a Button whose action.name matches the pattern has sendToAgent: true.
 * Scans all canvas_update calls for Button components.
 */
function buttonUsesSendToAgent(result: EvalResult, namePattern: RegExp): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  const buttonBlocks = json.split('"component"').filter(b => b.includes('"Button"'))
  for (const block of buttonBlocks) {
    const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/)
    if (nameMatch && namePattern.test(nameMatch[1])) {
      const nearbyChunk = block.substring(0, 500)
      if (nearbyChunk.includes('"sendToAgent"') && (nearbyChunk.includes('true') || nearbyChunk.includes(':true'))) {
        return true
      }
    }
  }
  return false
}

/**
 * True if both sendToAgent buttons and mutation buttons coexist.
 */
function hasMixedButtonTypes(result: EvalResult): boolean {
  return hasSendToAgentButton(result) && hasNonOpenButtonMutation(result)
}

/**
 * True if canvas_data or canvas_update was called in the final turn tool calls.
 * Used for multi-turn evals to verify the agent updated the canvas after receiving an action.
 */
function canvasUpdatedAfterActionMessage(result: EvalResult): boolean {
  return result.finalTurnToolCalls.some(t =>
    t.name === 'canvas_data' || t.name === 'canvas_update'
  )
}

// ---------------------------------------------------------------------------
// Chart-specific helpers
// ---------------------------------------------------------------------------

/**
 * Check that at least one canvas_update call includes a Chart component
 * with the given type prop value.
 */
function hasChartType(result: EvalResult, chartType: string): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  const chartPattern = new RegExp(`"component"\\s*:\\s*"Chart"`)
  const typePattern = new RegExp(`"type"\\s*:\\s*"${chartType}"`)
  if (!chartPattern.test(json)) return false
  return typePattern.test(json)
}

/**
 * Check that Chart data arrays across canvas_update AND canvas_data calls
 * have at least `minPoints` entries total. Data may be inline in canvas_update
 * or set via canvas_data when using path bindings.
 */
function chartHasMinDataPoints(result: EvalResult, minPoints: number): boolean {
  const relevantCalls = result.toolCalls.filter(t => t.name === 'canvas_update' || t.name === 'canvas_data')
  const json = JSON.stringify(relevantCalls.map(t => t.input))
  const labelMatches = json.match(/"label"\s*:\s*"/g)
  return (labelMatches?.length ?? 0) >= minPoints
}

/**
 * Check that chart-related tool calls include specific label text (case-insensitive).
 * Checks both canvas_update (inline data) and canvas_data (bound data).
 */
function chartDataContainsLabel(result: EvalResult, label: string): boolean {
  const relevantCalls = result.toolCalls.filter(t => t.name === 'canvas_update' || t.name === 'canvas_data')
  const json = JSON.stringify(relevantCalls.map(t => t.input)).toLowerCase()
  return json.includes(label.toLowerCase())
}

// ---------------------------------------------------------------------------
// Visual Quality Helpers
// ---------------------------------------------------------------------------

/**
 * Count the total number of unique components in canvas_update calls.
 */
function componentCount(result: EvalResult): number {
  const ids = new Set<string>()
  for (const t of result.toolCalls) {
    if (t.name !== 'canvas_update') continue
    const inputStr = JSON.stringify(t.input ?? '')
    const idMatches = inputStr.matchAll(/"id"\s*:\s*"([^"]+)"/g)
    for (const m of idMatches) ids.add(m[1])
  }
  return ids.size
}

/**
 * Check that canvas_update calls include at least N components.
 */
function hasMinimumComponents(result: EvalResult, min: number): boolean {
  return componentCount(result) >= min
}

/**
 * Check that the component tree includes a Grid of Metric components.
 */
function hasMetricGrid(result: EvalResult): boolean {
  const json = JSON.stringify(result.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
  return json.includes('"Grid"') && json.includes('"Metric"')
}

/**
 * Check that the component tree includes Card-wrapped sections (Card with title).
 */
function hasCardWrappedSections(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  const json = JSON.stringify(updateCalls.map(t => t.input))
  const cardWithTitle = /"component"\s*:\s*"Card"[^}]*"title"\s*:/
  return cardWithTitle.test(json)
}

/**
 * Check that Metric components include trendValue for auto-inferred trend display.
 * (The renderer auto-infers trend direction from trendValue, so explicit "trend" is not required.)
 */
function metricsHaveTrendValues(result: EvalResult): boolean {
  const json = JSON.stringify(result.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
  return json.includes('"trendValue"')
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const CANVAS_EVALS: AgentEval[] = [
  // ---- Level 1: Basic surface creation ----
  {
    id: 'canvas-basic-weather',
    name: 'Canvas: Build weather display',
    category: 'canvas',
    tags: ['view-only'],
    level: 1,
    input: 'What\'s the weather like in San Francisco? Show me something nice — it\'s 72°F and sunny out.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Used canvas_create to create a surface',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to add components',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data or canvas_api_query to populate data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
      },
      {
        id: 'canvas-has-temp',
        description: 'Response or tool calls reference temperature',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('72') || json.includes('temp')
        },
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms the canvas was built',
        points: 15,
        phase: 'execution',
        validate: (r) => responseContains(r, 'canvas') || responseContains(r, 'weather') || responseContains(r, 'display'),
      },
      {
        id: 'no-excessive-tools',
        description: 'Used a reasonable number of tool calls (<= 10)',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: ['Repeated identical tool calls (loop)'],
  },

  // ---- Level 2: Dashboard with multiple components ----
  {
    id: 'canvas-dashboard-metrics',
    name: 'Canvas: Build metrics dashboard',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'I need to see our key business numbers at a glance — we have 1,500 users, $45,000 in revenue, and 342 active sessions.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components in the layout',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Metric"')
        },
      },
      {
        id: 'has-data-values',
        description: 'Populated all three metric values',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('1500') || json.includes('1,500')
        },
      },
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data or canvas_api_query to set the data model',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
  },

  // ---- Level 3: Canvas with CRUD API ----
  {
    id: 'canvas-todo-crud',
    name: 'Canvas: Build todo app with CRUD API',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'I want to track my todos — adding, completing, and deleting them. Set me up with a few sample ones to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the backend',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate initial data',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying todos',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-todo-model',
        description: 'API schema defines a Todo model',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('todo') && json.includes('model')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a todo',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the interaction result',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: Interactive canvas with action wait ----
  {
    id: 'canvas-interactive-buttons',
    name: 'Canvas: Interactive button actions',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'I need a quick poll — give people two options, A and B, and let them pick one.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added button components',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-button-components',
        description: 'Included Button components',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Button"')
        },
      },
      {
        id: 'has-actions',
        description: 'Buttons have action handlers defined',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"action"') && json.includes('"name"')
        },
      },
      {
        id: 'has-two-buttons',
        description: 'Created at least two buttons',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const matches = JSON.stringify(r.toolCalls).match(/"Button"/g)
          return (matches?.length || 0) >= 2
        },
      },
      {
        id: 'handles-votes',
        description: 'Used canvas_data_patch, canvas_action_wait, or canvas_trigger_action to handle votes',
        points: 10,
        phase: 'execution',
        validate: (r) =>
          usedTool(r, 'canvas_data_patch') ||
          usedTool(r, 'canvas_action_wait') ||
          usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'verified-state',
        description: 'Used canvas_inspect to verify the poll state',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'response-explains',
        description: 'Response explains the canvas and verification result',
        points: 10,
        phase: 'execution',
        validate: (r) => r.responseText.length > 30,
      },
    ],
    antiPatterns: ['Did not verify button interactions work'],
  },

  // ---- Level 2: CRM Lead Pipeline Board (n8n lead scoring + Odin CRM) ----
  {
    id: 'canvas-crm-pipeline',
    name: 'Canvas: CRM lead pipeline board',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'I want to see my sales pipeline. I\'ve got leads in New, Qualified, and Closed stages — show me who\'s where with their company and score.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-canvas-data',
        description: 'Used canvas_data or canvas_api_query to populate lead data',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_data') || usedTool(r, 'canvas_api_query'),
      },
      {
        id: 'has-stage-labels',
        description: 'Includes pipeline stage labels (New, Qualified, Closed)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('new') && json.includes('qualified') && json.includes('closed')
        },
      },
      {
        id: 'has-lead-data',
        description: 'Data includes lead name and company fields',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('company') && (json.includes('name') || json.includes('lead'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // ---- Level 2: Expense Report Dashboard (Odin AI + OpenClaw) ----
  {
    id: 'canvas-expense-dashboard',
    name: 'Canvas: Expense tracker dashboard',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Help me see where my team\'s money is going this month. We\'ve spent $4,230 of our $6,000 budget so far. Show me the breakdown of recent expenses.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for totals',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for expense line items',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-spend-data',
        description: 'Data includes spend amount',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('4230') || json.includes('4,230')
        },
      },
      {
        id: 'has-budget-data',
        description: 'Data includes budget info',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('6000') || json.includes('6,000') || json.includes('1770') || json.includes('1,770') || json.includes('budget')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
  },

  // ---- Level 2: CI/CD Pipeline Monitor (GitHub Actions) ----
  {
    id: 'canvas-cicd-monitor',
    name: 'Canvas: CI/CD pipeline monitor',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Show me our recent deployments from GitHub — I want to see which ones passed and which failed, plus the trend over the last week.',
    toolMocks: CICD_PIPELINE_MOCKS,
    maxScore: 100,
    validationCriteria: [
      {
        id: 'installed-github',
        description: 'Installed the GitHub integration',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'fetched-deployments',
        description: 'Called GitHub workflow runs API to get real data',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'GITHUB_LIST_WORKFLOW_RUNS'),
      },
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-deploy-list',
        description: 'Included a Table or DataList for deploys',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') || json.includes('"DataList"')
        },
      },
      {
        id: 'has-chart',
        description: 'Included a Chart for deploy frequency',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'has-status-indicators',
        description: 'Includes status values (success/failed/running)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('success') || json.includes('fail')
        },
      },
      {
        id: 'has-deploy-data',
        description: 'Data includes branch info from the real GitHub data',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('main') || json.includes('branch')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
  },

  // ---- Level 3: Customer Support Ticket System (n8n + Odin AI) ----
  {
    id: 'canvas-support-tickets',
    name: 'Canvas: Support ticket system with CRUD',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'I need a way to manage support tickets. Should have priority levels and status tracking. Throw in some example tickets to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Ticket model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample tickets',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying tickets',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-ticket-model',
        description: 'API schema defines a Ticket model with priority and status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('ticket') && json.includes('priority') && json.includes('status')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test ticket',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the ticket was created',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: Invoice Management System (n8n AI invoice agent) ----
  {
    id: 'canvas-invoice-tracker',
    name: 'Canvas: Invoice management with CRUD',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Help me track my invoices — client, amount, due date, and whether they\'re paid. Add a few sample invoices to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Invoice model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample invoices',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying invoices',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-metric-component',
        description: 'Included a Metric for the total amount',
        points: 5,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-invoice-model',
        description: 'API schema defines an Invoice model with amount and status',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('invoice') && json.includes('amount') && json.includes('status')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test invoice',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the invoice was created',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 3: HR Applicant Pipeline (Odin AI recruiting + n8n HR) ----
  {
    id: 'canvas-hr-pipeline',
    name: 'Canvas: Recruiting pipeline with CRUD',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'I need to track job applicants through our hiring process — who applied, what role, what stage they\'re at, and how they rate. Seed it with a few sample candidates.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Applicant model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample applicants',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying applicants',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-applicant-model',
        description: 'API schema defines an Applicant model with stage and rating',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('applicant') && json.includes('stage') && json.includes('rating')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test applicant',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the applicant was added',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 4: Social Media Command Center (multi-turn) ----
  {
    id: 'canvas-social-media',
    name: 'Canvas: Social media analytics dashboard (multi-turn)',
    category: 'canvas',
    tags: ['view-only'],
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'Show me how our social media is doing — follower count, engagement rate, and what\'s scheduled to post next.' },
    ],
    input: 'We\'re @shogo_ai on Twitter/X with 12.4K followers and 4.2% engagement, @shogoai on Instagram with 8.1K followers and 6.1% engagement, and our LinkedIn company page has 3.2K followers at 2.8% engagement. We have 5 posts scheduled for next week across all three platforms. Build me a canvas dashboard showing metrics per platform, an engagement trend chart, and a table of the upcoming scheduled posts. Use those numbers as sample data.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for KPIs',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const matches = JSON.stringify(r.toolCalls).match(/"Metric"/g)
          return (matches?.length || 0) >= 3
        },
      },
      {
        id: 'has-chart',
        description: 'Included a Chart for engagement trends',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Chart"'),
      },
      {
        id: 'has-table',
        description: 'Included a Table for scheduled posts',
        points: 15,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Table"'),
      },
      {
        id: 'has-engagement-data',
        description: 'Data includes engagement metrics',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('engagement') || json.includes('follower')
        },
      },
      {
        id: 'has-platform-data',
        description: 'Includes platform-specific data (Twitter, Instagram, LinkedIn)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('platform') || json.includes('twitter') || json.includes('instagram') || json.includes('linkedin')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
  },

  // ---- Level 4: E-Commerce Order Tracker (multi-turn) ----
  {
    id: 'canvas-ecommerce-orders',
    name: 'Canvas: E-commerce order management with CRUD (multi-turn)',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I need to manage my incoming orders — can you help me track revenue, shipments, and the order list?' },
    ],
    input: 'We\'re on Shopify. Today we had 23 orders totaling $3,450 with 8 pending shipments. Each order has an order number, customer name, items, total amount, and status (Pending/Shipped/Delivered). Build me a canvas dashboard with revenue and shipment metrics at the top and the full order list below as a table. Set up a CRUD API so I can add new orders, and seed it with 5 sample orders based on those numbers. After building it, add a test order for customer "Eval Shopper" with total $42 using canvas_trigger_action, then canvas_inspect to verify it was created.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Order model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample orders',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-metric-components',
        description: 'Used Metric components for KPIs',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'has-table-component',
        description: 'Included a Table or DataList for displaying orders',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls);
          return json.includes('"Table"') || json.includes('"DataList"');
        },
      },
      {
        id: 'has-order-model',
        description: 'API schema defines an Order model with status and total',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('order') && json.includes('status') && json.includes('total')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to add a test order',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true (mutation actually worked)',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify the order was created',
        points: 10,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['Did not verify interactions work', 'Buttons missing mutation in action definition'],
  },

  // ====================================================================
  // Interaction Evals — verify the agent self-tests its canvas UIs
  // ====================================================================

  // ---- Level 4: Build CRUD app + trigger action + inspect result ----
  {
    id: 'canvas-crud-self-test',
    name: 'Canvas: CRUD app with self-testing via trigger+inspect',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    input: 'Build me a quick todo tracker with a couple sample items. Make sure it actually works.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Defined API schema for todos',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded sample data',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Built UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'tested-add-action',
        description: 'Tested a POST/add action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerOutputContainsMethod(r, 'POST'),
      },
      {
        id: 'tested-update-action',
        description: 'Tested a PATCH/mark-complete action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerOutputContainsMethod(r, 'PATCH') || triggerOutputContainsMethod(r, 'PUT'),
      },
      {
        id: 'tested-delete-action',
        description: 'Tested a DELETE action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerOutputContainsMethod(r, 'DELETE'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'At least one canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'inspect-after-each-trigger',
        description: 'canvas_inspect called at least twice to verify multiple actions',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'canvas_inspect') >= 2,
      },
      {
        id: 'inspect-after-trigger',
        description: 'canvas_inspect was called after canvas_trigger_action',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'response-confirms-count',
        description: 'Response mentions the total count (3 todos)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('3') || text.includes('three')
        },
      },
    ],
    antiPatterns: ['Did not use canvas_trigger_action', 'Did not use canvas_inspect', 'Only tested one action type — must test add, update, and delete', 'Buttons missing mutation in action definition'],
  },

  // ---- Level 4: Counter app with self-testing loop (multi-turn) ----
  {
    id: 'canvas-counter-self-test',
    name: 'Canvas: Counter with trigger/inspect verification loop (multi-turn)',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'Make me a simple counter on the canvas — just a number display and a button I can click to increment it. Start the count at 0.' },
    ],
    input: 'Looks good! Now test that the increment actually works — use canvas_trigger_action to click the increment button 3 times, then use canvas_inspect to check the counter state and tell me the final value.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'triggered-at-least-once',
        description: 'Used canvas_trigger_action successfully at least once',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolSuccessfully(r, 'canvas_trigger_action'),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to check the result',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'triggered-3-times',
        description: 'canvas_trigger_action succeeded at least 3 times',
        points: 30,
        phase: 'execution',
        validate: (r) => successfulToolCallCount(r, 'canvas_trigger_action') >= 3,
      },
      {
        id: 'inspect-after-triggers',
        description: 'Used canvas_inspect after the last trigger',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const lastTrigger = r.toolCalls.map((t, i) => ({ ...t, idx: i }))
            .filter(t => t.name === 'canvas_trigger_action').pop()
          const inspectAfter = r.toolCalls.findIndex(
            (t, i) => t.name === 'canvas_inspect' && lastTrigger && i > lastTrigger.idx
          )
          return inspectAfter >= 0
        },
      },
      {
        id: 'response-reports-value',
        description: 'Response mentions the final counter value (3 or higher)',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText
          return /\b[3-9]\b/.test(text) || text.includes('three')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['Did not trigger any actions', 'Did not inspect the result'],
  },

  // ---- Level 5: Full CRUD roundtrip verification ----
  {
    id: 'canvas-crud-roundtrip',
    name: 'Canvas: Full CRUD roundtrip with verification',
    category: 'canvas',
    tags: ['interactive'],
    level: 5,
    input: 'Build me a contacts list where I can add, edit, and delete people — name, email, phone. Seed a couple entries, then run through each operation to make sure it all works and tell me the results.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Defined Contact model via API schema',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded 2 initial contacts',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'trigger-create',
        description: 'Used canvas_trigger_action with POST mutation to add a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          return r.toolCalls.some(t => {
            if (t.name !== 'canvas_trigger_action') return false
            const json = JSON.stringify(t.input).toLowerCase()
            return json.includes('post')
          })
        },
      },
      {
        id: 'trigger-update',
        description: 'Used canvas_trigger_action with PATCH/PUT mutation to update a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerOutputContainsMethod(r, 'PATCH') || triggerOutputContainsMethod(r, 'PUT'),
      },
      {
        id: 'trigger-delete',
        description: 'Used canvas_trigger_action with DELETE mutation to remove a contact',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerOutputContainsMethod(r, 'DELETE'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'At least one canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'inspect-after-each',
        description: 'Used canvas_inspect at least 3 times (after create, update, delete)',
        points: 10,
        phase: 'execution',
        validate: (r) => toolCallCount(r, 'canvas_inspect') >= 3,
      },
      {
        id: 'response-reports-steps',
        description: 'Response describes results of each CRUD step',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('add') || text.includes('creat')) &&
                 (text.includes('update') || text.includes('patch')) &&
                 (text.includes('delete') || text.includes('remov'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Skipped verification steps',
      'Did not use canvas_trigger_action for CRUD',
      'Did not use canvas_inspect to verify',
      'Buttons missing mutation in action definition',
    ],
  },

  // ====================================================================
  // Faithful Testing Eval — proves the trigger resolves from real buttons
  // ====================================================================

  {
    id: 'canvas-faithful-trigger-test',
    name: 'Canvas: Faithful trigger resolves mutations from button definitions',
    category: 'canvas',
    tags: ['interactive'],
    level: 5,
    input: 'Build a task list where I can add tasks, mark them done, and delete them. Seed 3 tasks. Test every action to make sure it works — I need to know the buttons actually function when clicked.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Defined API schema for tasks',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Seeded 3 sample tasks',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Built UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'update-has-test-checklist',
        description: 'canvas_update response includes a testChecklist with button actions',
        points: 5,
        phase: 'execution',
        validate: (r) => updateHasTestChecklist(r),
      },
      {
        id: 'trigger-resolved-from-button',
        description: 'All successful canvas_trigger_action calls resolved mutations from actual button definitions (resolvedFromButton: true)',
        points: 15,
        phase: 'execution',
        validate: (r) => allTriggersResolvedFromButton(r),
      },
      {
        id: 'no-unresolved-params',
        description: 'No canvas_trigger_action outputs have unresolved :param warnings',
        points: 10,
        phase: 'execution',
        validate: (r) => noUnresolvedParamWarnings(r),
      },
      {
        id: 'tested-add-action',
        description: 'Tested add/POST action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
          return output.includes('"ok":true') && output.includes('POST')
        }),
      },
      {
        id: 'tested-update-action',
        description: 'Tested complete/PATCH action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
          return output.includes('"ok":true') && output.includes('PATCH')
        }),
      },
      {
        id: 'tested-delete-action',
        description: 'Tested delete/DELETE action via canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.some(t => {
          if (t.name !== 'canvas_trigger_action') return false
          const output = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '')
          return output.includes('"ok":true') && output.includes('DELETE')
        }),
      },
      {
        id: 'inspect-after-trigger',
        description: 'Used canvas_inspect after canvas_trigger_action',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 22 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 22,
      },
    ],
    antiPatterns: [
      'Did not use canvas_trigger_action',
      'Did not use canvas_inspect',
      'Buttons missing mutation in action definition',
    ],
  },

  // ====================================================================
  // Hook Evals — verify the agent uses canvas_api_hooks for auto-updating
  // ====================================================================

  // ---- Level 3: Expense tracker with recompute + validate hooks ----
  {
    id: 'canvas-hooks-expense-validated',
    name: 'Canvas: Expense tracker with auto-updating metrics and validation hooks',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Build an expense tracker with a list of expenses and summary metrics showing total spent, expense count, and average expense. The metrics should update automatically when expenses are added or removed. Also make sure expenses can\'t be added with a negative amount or without a description. Seed 3 sample expenses, then test it.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema with an Expense model',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to seed expenses',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update with Metric and DataList/Table components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-hooks',
        description: 'Used canvas_api_hooks to register hooks',
        points: 15,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_hooks'),
      },
      {
        id: 'has-recompute-hook',
        description: 'Hook definitions include recompute action with sum aggregate',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"recompute"') && json.includes('"sum"')
        },
      },
      {
        id: 'has-validate-hook',
        description: 'Hook definitions include validate action (positive or required rule)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"validate"') && (json.includes('"positive"') || json.includes('"required"'))
        },
      },
      {
        id: 'has-after-delete-hooks',
        description: 'Hook definitions include afterDelete with recompute',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"afterDelete"') && json.includes('"recompute"')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test adding an expense',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify after mutation',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button component has a mutation in its action definition',
        points: 5,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 22 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 22,
      },
    ],
    antiPatterns: [
      'Used cron instead of hooks for metric updates',
      'Hardcoded metric values without data binding',
      'No validate hooks registered',
    ],
  },

  // ---- Level 4: Project management with cascade-delete + recompute + log ----
  {
    id: 'canvas-hooks-project-cascade',
    name: 'Canvas: Project management with cascade-delete, recompute, and audit log hooks',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    input: 'Build a project management board. Each project has a name and status. Each task has a title, status, and belongs to a project (projectId). Show metrics for total projects, total tasks, and completed task count. When a project is deleted, its tasks should be automatically removed too. Keep an activity log of all changes. Seed 2 projects with 3 tasks each, then test: add a new task, delete a project (should cascade-delete its tasks), and verify the activity log.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema with Project and Task models',
        points: 5,
        phase: 'intention',
        validate: (r) => {
          const schemaCalls = r.toolCalls.filter(t => t.name === 'canvas_api_schema')
          const json = JSON.stringify(schemaCalls.map(t => t.input)).toLowerCase()
          return json.includes('project') && json.includes('task')
        },
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate sample data',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update with Metric components',
        points: 5,
        phase: 'intention',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return usedTool(r, 'canvas_update') && json.includes('"Metric"')
        },
      },
      {
        id: 'used-api-hooks',
        description: 'Used canvas_api_hooks with hooks on multiple models',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          if (hookCalls.length === 0) return false
          const models = new Set(hookCalls.map(t => (t.input as any)?.model?.toLowerCase()))
          return models.size >= 1 && hookCalls.length >= 1
        },
      },
      {
        id: 'has-cascade-delete',
        description: 'Hook definitions include cascade-delete action',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"cascade-delete"')
        },
      },
      {
        id: 'has-recompute',
        description: 'Hook definitions include recompute action for metrics',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"recompute"')
        },
      },
      {
        id: 'has-log-hook',
        description: 'Hook definitions include log action targeting an activity model',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const json = JSON.stringify(hookCalls.map(t => t.input))
          return json.includes('"log"')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test at least one operation',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify results',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
      {
        id: 'response-describes-hooks',
        description: 'Response describes cascade behavior or audit logging',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('cascade') || text.includes('audit') || text.includes('log') || text.includes('hook')
        },
      },
    ],
    antiPatterns: [
      'No cascade-delete hooks registered',
      'Only registered hooks on one model',
      'Manual deletion of child records instead of hooks',
    ],
  },

  // ---- Level 5: Full hooks lifecycle with all 5 action types ----
  {
    id: 'canvas-hooks-full-lifecycle',
    name: 'Canvas: Full hooks lifecycle with all 5 action types',
    category: 'canvas',
    tags: ['interactive'],
    level: 5,
    input: 'Build a customer order system. Customers have a name and email. Orders have a customer name, amount, and status (pending/shipped/delivered). I need: (1) metrics for total revenue, order count, and average order value that auto-update, (2) validation so orders can\'t have negative amounts and must have a status, (3) emails should be stored lowercase and trimmed, (4) when a customer is deleted, their orders should be removed too, (5) an activity log tracking all changes. Seed 3 customers and 5 orders. Test adding a new order and verify everything works.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema with Customer and Order models',
        points: 5,
        phase: 'intention',
        validate: (r) => {
          const schemaCalls = r.toolCalls.filter(t => t.name === 'canvas_api_schema')
          const json = JSON.stringify(schemaCalls.map(t => t.input)).toLowerCase()
          return json.includes('customer') && json.includes('order')
        },
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate data',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'used-canvas-update',
        description: 'Used canvas_update to build the UI',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-hooks-multi-model',
        description: 'Used canvas_api_hooks on at least 2 different models',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const hookCalls = r.toolCalls.filter(t => t.name === 'canvas_api_hooks')
          const models = new Set(hookCalls.map(t => String((t.input as any)?.model ?? '').toLowerCase()))
          return models.size >= 2
        },
      },
      {
        id: 'has-recompute',
        description: 'Hook definitions include recompute action',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_api_hooks').map(t => t.input))
          return json.includes('"recompute"')
        },
      },
      {
        id: 'has-validate',
        description: 'Hook definitions include validate action (positive amount or required status)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_api_hooks').map(t => t.input))
          return json.includes('"validate"')
        },
      },
      {
        id: 'has-transform',
        description: 'Hook definitions include transform action (lowercase/trim on email)',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_api_hooks').map(t => t.input))
          return json.includes('"transform"')
        },
      },
      {
        id: 'has-cascade-delete',
        description: 'Hook definitions include cascade-delete action',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_api_hooks').map(t => t.input))
          return json.includes('"cascade-delete"')
        },
      },
      {
        id: 'has-log',
        description: 'Hook definitions include log action',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_api_hooks').map(t => t.input))
          return json.includes('"log"')
        },
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action and it returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect to verify',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_inspect'),
      },
      {
        id: 'response-describes-system',
        description: 'Response describes the hooks system and verification results',
        points: 5,
        phase: 'execution',
        validate: (r) => r.responseText.toLowerCase().includes('hook') || r.responseText.toLowerCase().includes('auto'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 28 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 28,
      },
    ],
    antiPatterns: [
      'Used fewer than 3 hook action types',
      'No before-mutation hooks (validate/transform)',
      'No cascade-delete hooks',
      'Used cron instead of hooks',
    ],
  },

  // ---- Visual Quality: Dashboard visual polish ----
  {
    id: 'canvas-visual-quality-dashboard',
    name: 'Visual Quality: Analytics dashboard has proper layout',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Create a sales analytics dashboard with revenue charts, KPI metrics, and top products',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metric-grid',
        description: 'Uses a Grid of Metric components for KPIs',
        points: 20,
        phase: 'execution',
        validate: (r) => hasMetricGrid(r),
      },
      {
        id: 'metrics-have-trend-values',
        description: 'Metric components include trendValue for auto-inferred trends',
        points: 10,
        phase: 'execution',
        validate: (r) => metricsHaveTrendValues(r),
      },
      {
        id: 'has-chart-component',
        description: 'Includes at least one Chart component',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
          return json.includes('"Chart"')
        },
      },
      {
        id: 'has-card-sections',
        description: 'Data sections are wrapped in Cards with titles',
        points: 15,
        phase: 'execution',
        validate: (r) => hasCardWrappedSections(r),
      },
      {
        id: 'minimum-component-count',
        description: 'Has at least 12 components for a polished dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 12),
      },
      {
        id: 'has-header-row',
        description: 'Includes a header Row with title variant h2',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
          return json.includes('"h2"') && json.includes('"Row"')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'Fewer than 10 components (sparse layout)',
      'No Metric components in a dashboard request',
      'No Chart in an analytics dashboard',
      'Missing Card wrappers on data sections',
    ],
  },

  // ---- Visual Quality: CRUD app visual polish ----
  {
    id: 'canvas-visual-quality-crud',
    name: 'Visual Quality: CRUD app has proper layout hierarchy',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Build an expense tracker with categories, amounts, and budget tracking',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for backend',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'has-metric-grid',
        description: 'Uses a Grid of Metric components for summary stats',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMetricGrid(r),
      },
      {
        id: 'metrics-have-trend-values',
        description: 'Metric components include trendValue for auto-inferred trends',
        points: 10,
        phase: 'execution',
        validate: (r) => metricsHaveTrendValues(r),
      },
      {
        id: 'has-card-wrapped-form',
        description: 'Form section is wrapped in a Card with title',
        points: 15,
        phase: 'execution',
        validate: (r) => hasCardWrappedSections(r),
      },
      {
        id: 'has-header-row',
        description: 'Includes a header Row with title',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
          return json.includes('"Row"') && (json.includes('"h2"') || json.includes('"h3"'))
        },
      },
      {
        id: 'minimum-component-count',
        description: 'Has at least 10 components for a polished CRUD app',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 10),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button has action.mutation defined',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'tested-actions',
        description: 'All actions tested with canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: [
      'Fewer than 8 components (sparse layout)',
      'No Metric summary row in a CRUD app',
      'Missing Card wrappers',
    ],
  },

  // ---- Chart Types: Line ----
  {
    id: 'canvas-chart-line-trend',
    name: 'Chart: Line chart for revenue trend',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Show me monthly revenue for the past 6 months as a line chart. Use these numbers: Jan $42K, Feb $38K, Mar $45K, Apr $51K, May $48K, Jun $55K.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-line-chart',
        description: 'Included a Chart with type "line"',
        points: 25,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'line'),
      },
      {
        id: 'has-6-data-points',
        description: 'Chart data has at least 6 data points',
        points: 15,
        phase: 'execution',
        validate: (r) => chartHasMinDataPoints(r, 6),
      },
      {
        id: 'has-title',
        description: 'Chart has a title',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
          return json.includes('"title"') && json.includes('"Chart"')
        },
      },
      {
        id: 'has-jan-label',
        description: 'Data includes month labels from the prompt',
        points: 10,
        phase: 'execution',
        validate: (r) => chartDataContainsLabel(r, 'Jan') || chartDataContainsLabel(r, 'January'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Used bar chart instead of line for time series data',
      'Used pie/donut for time series data',
    ],
  },

  // ---- Chart Types: Pie ----
  {
    id: 'canvas-chart-pie-breakdown',
    name: 'Chart: Pie chart for market share',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Create a pie chart showing market share: Company A 35%, Company B 28%, Company C 22%, Others 15%.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-pie-chart',
        description: 'Included a Chart with type "pie"',
        points: 25,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'pie'),
      },
      {
        id: 'has-4-data-points',
        description: 'Pie chart has 4 segments',
        points: 15,
        phase: 'execution',
        validate: (r) => chartHasMinDataPoints(r, 4),
      },
      {
        id: 'has-company-labels',
        description: 'Data includes company labels from the prompt',
        points: 15,
        phase: 'execution',
        validate: (r) => chartDataContainsLabel(r, 'Company A') || chartDataContainsLabel(r, 'company a'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Used bar chart for proportional/market share data',
      'Used line chart for non-time-series proportional data',
    ],
  },

  // ---- Chart Types: Donut ----
  {
    id: 'canvas-chart-donut-budget',
    name: 'Chart: Donut chart for budget allocation',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Show my budget allocation as a donut chart: Rent $1500, Food $600, Transport $300, Entertainment $200, Savings $400.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-donut-chart',
        description: 'Included a Chart with type "donut"',
        points: 25,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'donut'),
      },
      {
        id: 'has-5-segments',
        description: 'Donut chart has 5 segments',
        points: 15,
        phase: 'execution',
        validate: (r) => chartHasMinDataPoints(r, 5),
      },
      {
        id: 'has-rent-label',
        description: 'Data includes budget category labels from the prompt',
        points: 15,
        phase: 'execution',
        validate: (r) => chartDataContainsLabel(r, 'Rent'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Used bar chart for budget allocation/proportional data',
      'Used line chart for non-time-series data',
    ],
  },

  // ---- Chart Types: Area ----
  {
    id: 'canvas-chart-area-growth',
    name: 'Chart: Area chart for user growth',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Display user growth over the last 8 weeks as an area chart. Week 1: 120, Week 2: 145, Week 3: 168, Week 4: 192, Week 5: 235, Week 6: 278, Week 7: 312, Week 8: 367.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-area-chart',
        description: 'Included a Chart with type "area"',
        points: 25,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'area'),
      },
      {
        id: 'has-8-data-points',
        description: 'Area chart has at least 8 data points',
        points: 15,
        phase: 'execution',
        validate: (r) => chartHasMinDataPoints(r, 8),
      },
      {
        id: 'has-week-labels',
        description: 'Data includes week labels',
        points: 10,
        phase: 'execution',
        validate: (r) => chartDataContainsLabel(r, 'Week') || chartDataContainsLabel(r, 'W1') || chartDataContainsLabel(r, 'Wk'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
      {
        id: 'response-mentions-growth',
        description: 'Agent response references growth or the chart',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'growth') || responseContains(r, 'area') || responseContains(r, 'chart'),
      },
    ],
    antiPatterns: [
      'Used bar chart for time series growth data',
      'Used pie/donut for sequential growth data',
    ],
  },

  // ---- Chart Types: Mixed dashboard ----
  {
    id: 'canvas-chart-dashboard-mixed',
    name: 'Chart: Analytics dashboard with mixed chart types',
    category: 'canvas',
    tags: ['view-only'],
    level: 3,
    input: 'Build an analytics dashboard for our SaaS product. Include: KPI metrics at the top (MRR $48K +8%, Active Users 1,240 +12%, Churn Rate 2.1% -0.3%), a line chart showing weekly signups over 6 weeks (45, 52, 61, 58, 73, 82), and a donut chart showing traffic sources (Organic 42%, Paid 28%, Referral 18%, Direct 12%).',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-metrics',
        description: 'Includes Metric components for KPIs',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMetricGrid(r),
      },
      {
        id: 'has-line-chart',
        description: 'Includes a line chart for weekly signups',
        points: 20,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'line') || hasChartType(r, 'area'),
      },
      {
        id: 'has-donut-chart',
        description: 'Includes a donut chart for traffic sources',
        points: 20,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'donut') || hasChartType(r, 'pie'),
      },
      {
        id: 'has-card-sections',
        description: 'Charts are wrapped in Cards',
        points: 10,
        phase: 'execution',
        validate: (r) => hasCardWrappedSections(r),
      },
      {
        id: 'minimum-component-count',
        description: 'Has at least 15 components for a complete dashboard',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 15),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'No Metric components in an analytics dashboard',
      'Only one chart type when two were requested',
      'Fewer than 12 components for a dashboard',
      'Missing Card wrappers on chart sections',
    ],
  },

  // ---- Chart Types: Type selection intelligence ----
  {
    id: 'canvas-chart-type-selection',
    name: 'Chart: Agent selects pie/donut for distribution data',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Show me the distribution of support tickets by category: Bug 45, Feature Request 32, Question 18, Other 8. Visualize this nicely.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'chose-pie-or-donut',
        description: 'Selected pie or donut chart for proportional distribution data',
        points: 30,
        phase: 'execution',
        validate: (r) => hasChartType(r, 'pie') || hasChartType(r, 'donut'),
      },
      {
        id: 'has-4-segments',
        description: 'Chart has 4 data segments',
        points: 15,
        phase: 'execution',
        validate: (r) => chartHasMinDataPoints(r, 4),
      },
      {
        id: 'has-bug-label',
        description: 'Data includes category labels from the prompt',
        points: 15,
        phase: 'execution',
        validate: (r) => chartDataContainsLabel(r, 'Bug'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 10 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 10,
      },
    ],
    antiPatterns: [
      'Used bar chart for proportional distribution data when pie/donut is more appropriate',
      'Used line chart for non-sequential category data',
    ],
  },

  // ---- Search & Filter: Searchable Contact List ----
  {
    id: 'canvas-search-contacts',
    name: 'Canvas: Searchable contact list',
    category: 'canvas',
    tags: ['interactive'],
    level: 2,
    input: 'Build me a contact list with a search bar. I should be able to type a name and filter the list. Seed it with 6 sample contacts with name, email, and company fields.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the Contact model',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate contacts',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-textfield',
        description: 'Includes a TextField component for search',
        points: 10,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'textfield-has-datapath',
        description: 'TextField has a dataPath configured to write to data model',
        points: 10,
        phase: 'execution',
        validate: (r) => textFieldHasDataPath(r),
      },
      {
        id: 'has-datalist',
        description: 'Includes a DataList component for displaying contacts',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"DataList"'),
      },
      {
        id: 'datalist-has-filter',
        description: 'DataList has filterPath and filterFields for search wiring',
        points: 15,
        phase: 'execution',
        validate: (r) => hasDataListWithFilter(r),
      },
      {
        id: 'minimum-components',
        description: 'Has at least 8 components',
        points: 10,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 8),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['Search TextField not connected to DataList filtering', 'No TextField component for search'],
  },

  // ---- Search & Filter: Product Catalog with Search + CRUD ----
  {
    id: 'canvas-search-products',
    name: 'Canvas: Product catalog with search and CRUD',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'I need a product catalog manager. Products have a name, category, price, and stock count. Include a search bar to filter products by name or category, and buttons to add new products and delete existing ones. Add 5 sample products.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for Product model',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return usedTool(r, 'canvas_api_schema') && json.includes('product') && json.includes('name') && json.includes('price')
        },
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate products',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-textfield',
        description: 'Includes a TextField for search',
        points: 10,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'textfield-has-datapath',
        description: 'TextField has dataPath for search binding',
        points: 10,
        phase: 'execution',
        validate: (r) => textFieldHasDataPath(r),
      },
      {
        id: 'has-datalist',
        description: 'DataList or Table present for product display',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"DataList"') || json.includes('"Table"')
        },
      },
      {
        id: 'datalist-has-filter',
        description: 'DataList has filterPath + filterFields for search',
        points: 10,
        phase: 'execution',
        validate: (r) => hasDataListWithFilter(r),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'Every Button has a mutation in its action definition',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to test add/delete',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'used-inspect',
        description: 'Used canvas_inspect after trigger',
        points: 5,
        phase: 'execution',
        validate: (r) => inspectAfterTrigger(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: ['Search not wired to DataList', 'Buttons missing mutation', 'Did not verify interactions'],
  },

  // ---- Search & Filter: Searchable FAQ Knowledge Base ----
  {
    id: 'canvas-search-faq',
    name: 'Canvas: FAQ knowledge base with search and category filter',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Create a FAQ knowledge base. Each entry has a question, answer, and category (General, Billing, Technical). Add a search bar that filters across both question and answer text, and a category dropdown to filter by category. Seed with 6 sample FAQs.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for FAQ model',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate FAQs',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-textfield',
        description: 'Includes a TextField for text search',
        points: 10,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'has-select',
        description: 'Includes a Select for category filter',
        points: 10,
        phase: 'execution',
        validate: (r) => hasSelectComponent(r),
      },
      {
        id: 'datalist-has-filter',
        description: 'DataList has filterPath connected to search input',
        points: 15,
        phase: 'execution',
        validate: (r) => hasDataListWithFilter(r),
      },
      {
        id: 'has-faq-model',
        description: 'FAQ model includes question, answer, category fields',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return json.includes('question') && json.includes('answer') && json.includes('category')
        },
      },
      {
        id: 'minimum-components',
        description: 'Has at least 10 components',
        points: 10,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 10),
      },
      {
        id: 'has-card-sections',
        description: 'Has Card-wrapped sections',
        points: 10,
        phase: 'execution',
        validate: (r) => hasCardWrappedSections(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
      {
        id: 'response-explains',
        description: 'Agent response explains the search functionality',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'search') || responseContains(r, 'filter'),
      },
    ],
    antiPatterns: ['No search input', 'Search not connected to data list', 'Missing category filter'],
  },

  // ---- Search & Filter: Employee Directory with Server-Side Search ----
  {
    id: 'canvas-search-employees',
    name: 'Canvas: Employee directory with server-side search',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    input: 'Build an employee directory for a large company. Employees have name, department, title, email, and phone. I need a search bar that searches across name and title — this should use the API to filter since there could be thousands of employees. Include department metrics at the top. Seed with 8 sample employees across 3 departments.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for Employee model',
        points: 10,
        phase: 'intention',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return usedTool(r, 'canvas_api_schema') && json.includes('employee') && json.includes('department')
        },
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed with employees across departments',
        points: 5,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-textfield',
        description: 'Includes a TextField for search',
        points: 10,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'textfield-has-datapath',
        description: 'TextField has dataPath configured',
        points: 5,
        phase: 'execution',
        validate: (r) => textFieldHasDataPath(r),
      },
      {
        id: 'has-search-wiring',
        description: 'DataList uses API binding with _search params or client-side filterPath',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('_search') || json.includes('filterPath')
        },
      },
      {
        id: 'has-metrics',
        description: 'Has Metric components for department stats',
        points: 10,
        phase: 'execution',
        validate: (r) => JSON.stringify(r.toolCalls).includes('"Metric"'),
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'All buttons have mutations',
        points: 10,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 22 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 22,
      },
      {
        id: 'minimum-components',
        description: 'Has at least 12 components',
        points: 5,
        phase: 'execution',
        validate: (r) => hasMinimumComponents(r, 12),
      },
    ],
    antiPatterns: ['No search input for employee lookup', 'Missing department metrics'],
  },

  // ---- Search & Filter: Recipe Finder (Simple) ----
  {
    id: 'canvas-search-recipes',
    name: 'Canvas: Recipe finder with search',
    category: 'canvas',
    tags: ['interactive'],
    level: 2,
    input: 'Make me a recipe browser. Show a list of recipes with name, cuisine type, and prep time. I want to be able to search by recipe name. Add 6 sample recipes.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-textfield',
        description: 'Includes a TextField for search',
        points: 15,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'textfield-has-datapath',
        description: 'TextField has dataPath for search binding',
        points: 10,
        phase: 'execution',
        validate: (r) => textFieldHasDataPath(r),
      },
      {
        id: 'datalist-has-filter',
        description: 'DataList present with filterPath for search',
        points: 20,
        phase: 'execution',
        validate: (r) => hasDataListWithFilter(r),
      },
      {
        id: 'has-recipe-data',
        description: 'Data includes recipe names and cuisine types',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          return (json.includes('recipe') || json.includes('cuisine')) && json.includes('name')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 18 tool calls',
        points: 15,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 18,
      },
    ],
    antiPatterns: ['No search input', 'DataList missing filterPath'],
  },

  // ---- Negative: Basic agent must NOT use interactive components ----
  {
    id: 'canvas-basic-no-interactive',
    name: 'Canvas: Notes app must be display-only (no buttons/inputs)',
    category: 'canvas',
    tags: ['view-only'],
    level: 2,
    input: 'Build a simple notes app',
    requiredAgent: 'basic',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'no-textfield',
        description: 'Did NOT use TextField component',
        points: 20,
        phase: 'execution',
        validate: (r) => !hasTextField(r),
      },
      {
        id: 'no-select',
        description: 'Did NOT use Select component',
        points: 10,
        phase: 'execution',
        validate: (r) => !hasSelectComponent(r),
      },
      {
        id: 'no-forbidden-interactive',
        description: 'No forbidden interactive components (TextField, Select, Checkbox, ChoicePicker)',
        points: 20,
        phase: 'execution',
        validate: (r) => noForbiddenInteractiveComponents(r),
      },
      {
        id: 'no-crud-mutations',
        description: 'No POST/PATCH/DELETE mutations on buttons',
        points: 20,
        phase: 'execution',
        validate: (r) => !hasNonOpenButtonMutation(r),
      },
      {
        id: 'no-trigger-action',
        description: 'Did NOT use canvas_trigger_action (basic agent lacks it)',
        points: 10,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'canvas_trigger_action'),
      },
    ],
    antiPatterns: [
      'Agent used TextField or other form inputs in a display-only canvas',
      'Agent used POST/PATCH/DELETE mutations in basic agent mode',
    ],
  },

  // ---- Action-Not-UI: Agent should do work, not build builder UIs ----
  {
    id: 'action-not-ui-campaign',
    name: 'Action-Not-UI: Create ad campaign (agent does the work)',
    category: 'canvas',
    tags: ['view-only'],
    initialMode: 'none',
    level: 2,
    input: 'Create a Google Ads campaign for $20/day targeting sign-ups for our web app shogo.ai. We want to spend $20 a day and get sign ups.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'did-work',
        description: 'Used tools to research or produce campaign content (web, write_file, tool_search, tool_install)',
        points: 25,
        phase: 'intention',
        validate: (r) => usedTool(r, 'web') || usedTool(r, 'write_file') || usedTool(r, 'tool_search') || usedTool(r, 'tool_install'),
      },
      {
        id: 'response-has-campaign-details',
        description: 'Response includes concrete campaign details (keywords, budget, ad copy)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const hasKeywords = text.includes('keyword') || text.includes('search term')
          const hasBudget = text.includes('$20') || text.includes('budget')
          const hasAdCopy = text.includes('headline') || text.includes('ad copy') || text.includes('description')
          return (hasKeywords && hasBudget) || (hasBudget && hasAdCopy)
        },
      },
      {
        id: 'no-interactive-builder',
        description: 'Did NOT build an interactive builder UI (no CRUD schema, no form fields with Select/TextField in DataList)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          if (usedTool(r, 'canvas_api_schema')) return false
          const updateCalls = r.toolCalls.filter(t => t.name === 'canvas_update')
          if (updateCalls.length === 0) return true
          const json = JSON.stringify(updateCalls.map(t => t.input))
          const hasInteractive = (json.match(/"(TextField|Select|ChoicePicker)"/g) || []).length
          return hasInteractive <= 1
        },
      },
      {
        id: 'no-api-schema-crud',
        description: 'Did NOT create a CRUD API schema (agent produced content, not a builder)',
        points: 15,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in reasonable number of tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Built interactive UI instead of doing the work (canvas without work)',
      'Built a "Campaign Builder" or "Campaign Manager" form with text fields (builder ui)',
    ],
  },
  {
    id: 'action-not-ui-email-templates',
    name: 'Action-Not-UI: Draft email templates (agent writes them)',
    category: 'canvas',
    tags: ['view-only'],
    initialMode: 'none',
    level: 2,
    input: 'Draft 3 email templates for onboarding new users to our SaaS product.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'produced-content',
        description: 'Used write_file or response contains actual email content',
        points: 25,
        phase: 'intention',
        validate: (r) => {
          const wroteFile = usedTool(r, 'write_file')
          const hasEmailContent = r.responseText.toLowerCase().includes('subject') &&
            (r.responseText.toLowerCase().includes('welcome') || r.responseText.toLowerCase().includes('onboard'))
          return wroteFile || hasEmailContent
        },
      },
      {
        id: 'has-multiple-templates',
        description: 'Response or tool calls reference at least 2 distinct templates',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const templateIndicators = ['template 1', 'template 2', 'template 3', 'email 1', 'email 2', 'email 3',
            'welcome email', 'getting started', 'first email', 'second email', 'third email']
          const matches = templateIndicators.filter(t => text.includes(t))
          return matches.length >= 2
        },
      },
      {
        id: 'no-interactive-management-ui',
        description: 'Did NOT build interactive management UI (no CRUD schema, no Select/TextField in DataList for editing)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          if (usedTool(r, 'canvas_api_schema')) return false
          const updateCalls = r.toolCalls.filter(t => t.name === 'canvas_update')
          if (updateCalls.length === 0) return true
          const json = JSON.stringify(updateCalls.map(t => t.input))
          const hasInteractive = (json.match(/"(TextField|Select|ChoicePicker)"/g) || []).length
          return hasInteractive <= 1
        },
      },
      {
        id: 'no-api-schema-crud',
        description: 'Did NOT create a CRUD API schema for templates',
        points: 20,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in reasonable number of tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: [
      'Built interactive UI instead of doing the work (canvas without work)',
      'Built an "Email Template Editor" with editable text fields (builder ui)',
    ],
  },
  {
    id: 'action-not-ui-content-calendar',
    name: 'Action-Not-UI: Create content calendar (agent produces it)',
    category: 'canvas',
    tags: ['view-only'],
    initialMode: 'none',
    level: 2,
    input: 'Create a social media content calendar for next week. We post on Twitter and LinkedIn daily.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'produced-content',
        description: 'Agent produced actual calendar content (days, topics, posts)',
        points: 30,
        phase: 'intention',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const json = JSON.stringify(r.toolCalls).toLowerCase()
          const combined = text + json
          const hasDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].filter(d => combined.includes(d)).length >= 3
          const hasContent = combined.includes('post') || combined.includes('tweet') || combined.includes('linkedin')
          return hasDays && hasContent
        },
      },
      {
        id: 'canvas-is-display-only',
        description: 'If canvas was used, it is display-only (no CRUD schema, no Select/TextField/ChoicePicker/Delete in DataList)',
        points: 25,
        phase: 'execution',
        validate: (r) => {
          if (usedTool(r, 'canvas_api_schema')) return false
          const updateCalls = r.toolCalls.filter(t => t.name === 'canvas_update')
          if (updateCalls.length === 0) return true
          const json = JSON.stringify(updateCalls.map(t => t.input))
          const interactiveCount = (json.match(/"(TextField|Select|ChoicePicker)"/g) || []).length
          const hasDeleteButton = json.includes('"deleteAction"') || json.includes('"DELETE"')
          return interactiveCount <= 1 && !hasDeleteButton
        },
      },
      {
        id: 'no-post-scheduler-crud',
        description: 'Did NOT build a CRUD post scheduler with API schema',
        points: 25,
        phase: 'execution',
        validate: (r) => neverUsedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in reasonable number of tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
      {
        id: 'response-confirms',
        description: 'Agent confirms it created the calendar',
        points: 10,
        phase: 'execution',
        validate: (r) => responseContains(r, 'calendar') || responseContains(r, 'schedule') || responseContains(r, 'content plan'),
      },
    ],
    antiPatterns: [
      'Built interactive UI instead of doing the work (canvas without work)',
      'Built a "Content Calendar Manager" or "Post Scheduler" with forms (builder ui)',
    ],
  },

  // ---- sendToAgent: Agent uses sendToAgent for smart actions ----
  {
    id: 'sendToAgent-approval-workflow',
    name: 'sendToAgent: Content approval dashboard',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Build me a content approval dashboard. Show my pending blog drafts and let me approve or reject them -- the agent should handle publishing approved posts.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'approve-button-sends-to-agent',
        description: 'An approve/publish button uses sendToAgent: true',
        points: 25,
        phase: 'execution',
        validate: (r) => buttonUsesSendToAgent(r, /approve|publish/i),
      },
      {
        id: 'reject-button-sends-to-agent',
        description: 'A reject button uses sendToAgent: true',
        points: 15,
        phase: 'execution',
        validate: (r) => buttonUsesSendToAgent(r, /reject|decline/i),
      },
      {
        id: 'no-mutation-for-approval',
        description: 'Approve/reject buttons do NOT have CRUD mutations (POST/PATCH/DELETE)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const updateCalls = r.toolCalls.filter(t => t.name === 'canvas_update')
          const json = JSON.stringify(updateCalls.map(t => t.input))
          const blocks = json.split('"component"').filter(b => b.includes('"Button"'))
          for (const block of blocks) {
            const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/)
            if (nameMatch && /approve|publish|reject|decline/i.test(nameMatch[1])) {
              if (block.includes('"mutation"') && /"method"\s*:\s*"(POST|PATCH|DELETE)"/i.test(block)) {
                return false
              }
            }
          }
          return true
        },
      },
      {
        id: 'has-content-display',
        description: 'Canvas includes a DataList or Table for showing drafts',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls.filter(t => t.name === 'canvas_update').map(t => t.input))
          return json.includes('"DataList"') || json.includes('"Table"')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Repeated identical tool calls (loop)',
    ],
  },
  {
    id: 'sendToAgent-generative-action',
    name: 'sendToAgent: Keyword research tool with analyze button',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Create a keyword research tool. I want a text field where I enter a URL and a button so you can analyze it and extract the top SEO keywords for me.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added components to the canvas',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'has-text-field',
        description: 'Canvas includes a TextField for URL input',
        points: 15,
        phase: 'execution',
        validate: (r) => hasTextField(r),
      },
      {
        id: 'analyze-button-sends-to-agent',
        description: 'The analyze/research button uses sendToAgent: true',
        points: 25,
        phase: 'execution',
        validate: (r) => buttonUsesSendToAgent(r, /analyz|research|extract|scan|keyword/i),
      },
      {
        id: 'no-mutation-for-analysis',
        description: 'The analyze button does NOT have a CRUD mutation',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const updateCalls = r.toolCalls.filter(t => t.name === 'canvas_update')
          const json = JSON.stringify(updateCalls.map(t => t.input))
          const blocks = json.split('"component"').filter(b => b.includes('"Button"'))
          for (const block of blocks) {
            const nameMatch = block.match(/"name"\s*:\s*"([^"]+)"/)
            if (nameMatch && /analyz|research|extract|scan|keyword/i.test(nameMatch[1])) {
              if (block.includes('"mutation"') && /"method"\s*:\s*"(POST|PATCH|DELETE)"/i.test(block)) {
                return false
              }
            }
          }
          return true
        },
      },
      {
        id: 'response-explains-flow',
        description: 'Agent explains that clicking the button triggers analysis',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return (text.includes('click') || text.includes('button') || text.includes('press')) &&
            (text.includes('analyz') || text.includes('extract') || text.includes('keyword'))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Repeated identical tool calls (loop)',
    ],
  },
  {
    id: 'sendToAgent-hybrid-coexistence',
    name: 'sendToAgent: Task tracker with CRUD + auto-prioritize',
    category: 'canvas',
    tags: ['interactive'],
    level: 4,
    input: 'Build a task tracker with add, complete, and delete. Also add an \'Auto-prioritize\' button where you re-order tasks by importance.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema for task CRUD',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'crud-buttons-have-mutations',
        description: 'CRUD buttons (add/complete/delete) have mutations',
        points: 20,
        phase: 'execution',
        validate: (r) => hasNonOpenButtonMutation(r),
      },
      {
        id: 'prioritize-button-sends-to-agent',
        description: 'Auto-prioritize button uses sendToAgent: true',
        points: 25,
        phase: 'execution',
        validate: (r) => buttonUsesSendToAgent(r, /priorit|reorder|sort|rank/i),
      },
      {
        id: 'has-mixed-button-types',
        description: 'Both mutation buttons and sendToAgent buttons coexist',
        points: 15,
        phase: 'execution',
        validate: (r) => hasMixedButtonTypes(r),
      },
      {
        id: 'used-trigger-action',
        description: 'Tested CRUD buttons with canvas_trigger_action',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'At least one canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 25 tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: [],
  },

  // ---- Canvas Action handling: Agent processes [Canvas Action] messages ----
  {
    id: 'canvas-action-report-generation',
    name: 'Canvas Action: Generate report on button click',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Create a reporting dashboard with a \'Generate Weekly Report\' button that you\'ll use to compile the report when I click it.',
      },
      {
        role: 'assistant',
        content: 'I\'ve built a reporting dashboard with a "Generate Weekly Report" button. When you click it, I\'ll compile a weekly report with key metrics, highlights, and recommendations. The dashboard is ready on the canvas — click the button whenever you want a report generated.',
      },
    ],
    input: '[Canvas Action] The user clicked "generate-report" on surface "reports".\nContext: {"reportType": "weekly"}\nProcess this action and update the canvas accordingly.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'did-work',
        description: 'Produced report content in final turn (write_file, web, tool_search, or canvas_data)',
        points: 30,
        phase: 'intention',
        validate: (r) => {
          return r.finalTurnToolCalls.some(t =>
            t.name === 'write_file' || t.name === 'web' ||
            t.name === 'tool_search' ||
            t.name === 'canvas_data'
          )
        },
      },
      {
        id: 'updated-canvas',
        description: 'Called canvas_data or canvas_update in final turn',
        points: 30,
        phase: 'execution',
        validate: (r) => canvasUpdatedAfterActionMessage(r),
      },
      {
        id: 'used-context-data',
        description: 'Response or tool calls reference "weekly" (used the context)',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const combined = (r.responseText + JSON.stringify(r.finalTurnToolCalls)).toLowerCase()
          return combined.includes('weekly')
        },
      },
      {
        id: 'no-clarifying-questions',
        description: 'Did not ask clarifying questions — just processed the action',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const questions = ['what kind', 'which one', 'do you want', 'would you prefer', 'could you clarify', 'what type']
          return !questions.some(q => r.responseText.toLowerCase().includes(q))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls in final turn',
        points: 10,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Asked unnecessary clarifying questions (unnecessary clarification)',
      'Repeated identical tool calls (loop)',
    ],
  },
  {
    id: 'canvas-action-form-submit',
    name: 'Canvas Action: Draft blog post from form submission',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    conversationHistory: [
      {
        role: 'user',
        content: 'Create a form where I describe a blog post idea and you draft it for me.',
      },
      {
        role: 'assistant',
        content: 'I\'ve created a blog post idea form on the canvas. Fill in the title, target audience, and tone, then click "Submit" and I\'ll draft the full blog post for you. The form is ready — go ahead and fill it in!',
      },
    ],
    input: '[Canvas Action] The user clicked "submit-idea" on surface "blog-writer".\nContext: {"title": "10 Tips for Remote Work", "audience": "tech professionals", "tone": "casual"}\nProcess this action and update the canvas accordingly.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'produced-content',
        description: 'Response or write_file contains blog content about remote work',
        points: 30,
        phase: 'intention',
        validate: (r) => {
          const combined = (r.responseText + JSON.stringify(r.finalTurnToolCalls)).toLowerCase()
          return combined.includes('remote work') || combined.includes('remote-work')
        },
      },
      {
        id: 'updated-canvas',
        description: 'Called canvas_data or canvas_update in final turn',
        points: 25,
        phase: 'execution',
        validate: (r) => canvasUpdatedAfterActionMessage(r),
      },
      {
        id: 'used-all-context-fields',
        description: 'Used title, audience, and tone from context',
        points: 20,
        phase: 'execution',
        validate: (r) => {
          const combined = (r.responseText + JSON.stringify(r.finalTurnToolCalls)).toLowerCase()
          const hasTitle = combined.includes('remote work')
          const hasAudience = combined.includes('tech') || combined.includes('professional')
          const hasTone = combined.includes('casual') || combined.includes('conversational') || combined.includes('friendly')
          return hasTitle && (hasAudience || hasTone)
        },
      },
      {
        id: 'no-clarifying-questions',
        description: 'Processed without asking clarifying questions',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const questions = ['what kind', 'which one', 'do you want', 'would you prefer', 'could you clarify']
          return !questions.some(q => r.responseText.toLowerCase().includes(q))
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 15 tool calls in final turn',
        points: 15,
        phase: 'execution',
        validate: (r) => r.finalTurnToolCalls.length <= 15,
      },
    ],
    antiPatterns: [
      'Asked unnecessary clarifying questions (unnecessary clarification)',
      'Repeated identical tool calls (loop)',
    ],
  },

  // ---- Negative: Simple CRUD should NOT use sendToAgent ----
  {
    id: 'no-sendToAgent-for-simple-crud',
    name: 'Negative: Simple CRUD todo should not use sendToAgent',
    category: 'canvas',
    tags: ['interactive'],
    level: 3,
    input: 'Track my todos -- adding, completing, and deleting them. Set me up with a few sample ones to start.',
    maxScore: 100,
    validationCriteria: [
      {
        id: 'used-canvas-create',
        description: 'Created a canvas surface',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'used-canvas-update',
        description: 'Added UI components',
        points: 5,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'used-api-schema',
        description: 'Used canvas_api_schema to define the backend',
        points: 15,
        phase: 'intention',
        validate: (r) => usedTool(r, 'canvas_api_schema'),
      },
      {
        id: 'used-api-seed',
        description: 'Used canvas_api_seed to populate initial data',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_api_seed'),
      },
      {
        id: 'has-list-component',
        description: 'Included a Table or DataList for displaying todos',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const json = JSON.stringify(r.toolCalls)
          return json.includes('"Table"') || json.includes('"DataList"')
        },
      },
      {
        id: 'all-buttons-have-mutations',
        description: 'All CRUD buttons have mutations (not sendToAgent)',
        points: 15,
        phase: 'execution',
        validate: (r) => allButtonsHaveMutations(r),
      },
      {
        id: 'no-sendToAgent-on-crud',
        description: 'No button uses sendToAgent: true (simple CRUD should use mutations)',
        points: 15,
        phase: 'execution',
        validate: (r) => !hasSendToAgentButton(r),
      },
      {
        id: 'used-trigger-action',
        description: 'Used canvas_trigger_action to verify buttons work',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_trigger_action'),
      },
      {
        id: 'trigger-action-succeeded',
        description: 'canvas_trigger_action returned ok: true',
        points: 10,
        phase: 'execution',
        validate: (r) => triggerActionSucceeded(r),
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in reasonable number of tool calls',
        points: 5,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 25,
      },
    ],
    antiPatterns: [
      'Used sendToAgent for simple CRUD operations (sendToAgent for simple crud)',
    ],
  },
]
