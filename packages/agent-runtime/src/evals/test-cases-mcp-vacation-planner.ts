// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MCP Vacation Planner Eval Test Cases
 *
 * End-to-end scenario: user asks for a vacation planning dashboard with real
 * Airbnb listings. The agent must:
 *
 * 1. Proactively discover the Airbnb MCP via tool_search
 * 2. Install it via tool_install
 * 3. Use the Airbnb search tool to find real listings
 * 4. Build a Canvas dashboard displaying the listings
 * 5. Use mutation method "OPEN" for external Airbnb links (not href)
 *
 * This eval validates the full MCP discovery → canvas rendering pipeline,
 * including the correct use of DataList templates with per-item OPEN mutations.
 */

import type { AgentEval, EvalResult } from './types'
import { AIRBNB_VACATION_PLANNER_MOCKS } from './tool-mocks'
import { usedTool, toolCallCount, responseContains, toolCallsJson } from './eval-helpers'

// ---------------------------------------------------------------------------
// Vacation-planner-specific helpers
// ---------------------------------------------------------------------------

function usedCanvasTools(result: EvalResult): boolean {
  return result.toolCalls.some(t => t.name.startsWith('canvas_'))
}

/**
 * Checks whether any canvas_update call contains components using
 * mutation method "OPEN" for external links.
 */
function hasOpenMutation(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  for (const call of updateCalls) {
    const json = JSON.stringify(call.input).toLowerCase()
    if (json.includes('"method"') && json.includes('"open"')) return true
  }
  return false
}

/**
 * Checks whether any canvas_update call contains a DataList with
 * template-scoped data binding for the URL (using { path: "url" }).
 */
function hasDataBoundUrl(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  for (const call of updateCalls) {
    const json = JSON.stringify(call.input).toLowerCase()
    if (json.includes('"path"') && json.includes('"url"')) return true
  }
  return false
}

/**
 * Checks whether any canvas_update call uses a DataList component.
 */
function hasDataList(result: EvalResult): boolean {
  const updateCalls = result.toolCalls.filter(t => t.name === 'canvas_update')
  for (const call of updateCalls) {
    const json = JSON.stringify(call.input)
    if (json.includes('"DataList"')) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const MCP_VACATION_PLANNER_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Full Bali Vacation Planner — Discovery + Dashboard
  // Level 5 | Single turn: discover Airbnb MCP → search listings → canvas
  // =========================================================================
  {
    id: 'vacation-planner-bali-full',
    name: 'Vacation Planner: Bali Airbnb discovery + interactive dashboard',
    category: 'mcp-orchestration',
    level: 5,
    input: 'I want a vacation planning dashboard for a trip to Bali, April 21 - May 2. I\'d like to stay at an Airbnb in a natural setting close to organic restaurants, preferably in the Ubud area. Can you find real Airbnb listings and build an interactive dashboard?',
    maxScore: 100,
    toolMocks: AIRBNB_VACATION_PLANNER_MOCKS,
    validationCriteria: [
      {
        id: 'discovered-airbnb-mcp',
        description: 'Used tool_search to find the Airbnb MCP server',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'search-mentions-airbnb',
        description: 'Search query relates to airbnb/travel/accommodation',
        points: 5,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('airbnb') || json.includes('travel') || json.includes('accommodation') || json.includes('listing')
        },
      },
      {
        id: 'installed-airbnb-mcp',
        description: 'Used tool_install to add the Airbnb MCP server',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'correct-discovery-sequence',
        description: 'Discovery in correct order: search → install → use',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'tool_install')
          const useIdx = r.toolCalls.findIndex(t => t.name === 'mcp_airbnb_airbnb_search')
          return searchIdx >= 0 && installIdx > searchIdx && useIdx > installIdx
        },
      },
      {
        id: 'searched-airbnb-listings',
        description: 'Used Airbnb search tool to find Ubud listings',
        points: 10,
        phase: 'intention',
        validate: (r) => usedTool(r, 'mcp_airbnb_airbnb_search'),
      },
      {
        id: 'search-mentions-ubud',
        description: 'Airbnb search includes Ubud/Bali location',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const searchCalls = r.toolCalls.filter(t => t.name === 'mcp_airbnb_airbnb_search')
          return searchCalls.some(c => {
            const json = JSON.stringify(c.input).toLowerCase()
            return json.includes('ubud') || json.includes('bali')
          })
        },
      },
      {
        id: 'created-canvas-surface',
        description: 'Created a canvas surface for the dashboard',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_create'),
      },
      {
        id: 'built-canvas-ui',
        description: 'Built UI components on the canvas',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'canvas_update'),
      },
      {
        id: 'uses-datalist-for-listings',
        description: 'Uses DataList component for repeating listing cards',
        points: 10,
        phase: 'execution',
        validate: (r) => hasDataList(r),
      },
      {
        id: 'uses-open-mutation',
        description: 'Buttons use mutation method "OPEN" for external Airbnb links',
        points: 10,
        phase: 'execution',
        validate: (r) => hasOpenMutation(r),
      },
      {
        id: 'data-binds-url',
        description: 'URL is data-bound to each listing item (path: "url")',
        points: 5,
        phase: 'execution',
        validate: (r) => hasDataBoundUrl(r),
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
      'No tool calls at all',
      'Did not create canvas',
      'Used href instead of mutation OPEN for external links',
    ],
  },

  // =========================================================================
  // Case 2: Multi-turn — User refines after initial results
  // Level 4 | History provides discovery context, final turn tests refinement
  // =========================================================================
  {
    id: 'vacation-planner-bali-refine',
    name: 'Vacation Planner: Refine Bali search with budget constraint',
    category: 'mcp-orchestration',
    level: 4,
    conversationHistory: [
      { role: 'user', content: 'I want a vacation planning dashboard for a trip to Bali, April 21 - May 2. Find me Airbnb listings in Ubud in a natural setting.' },
      { role: 'assistant', content: 'I found the Airbnb MCP server and installed it. I searched for listings in Ubud and found 5 options ranging from $38 to $120 per night. I\'ve built a dashboard showing all the listings with ratings, prices, and links. Take a look at the canvas!' },
    ],
    input: 'These are great but some are too expensive. Can you filter to only show listings under $70 per night? Also make sure each listing card has a button that opens the actual Airbnb page.',
    maxScore: 100,
    toolMocks: AIRBNB_VACATION_PLANNER_MOCKS,
    validationCriteria: [
      {
        id: 'updated-canvas',
        description: 'Updated the canvas with filtered listings',
        points: 25,
        phase: 'intention',
        validate: (r) => usedCanvasTools(r),
      },
      {
        id: 'mentions-budget',
        description: 'Response acknowledges the budget constraint',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          return text.includes('70') || text.includes('budget') || text.includes('under') || text.includes('filter')
        },
      },
      {
        id: 'uses-open-mutation-for-links',
        description: 'Buttons use mutation method "OPEN" to open Airbnb pages',
        points: 25,
        phase: 'execution',
        validate: (r) => hasOpenMutation(r),
      },
      {
        id: 'canvas-has-listings',
        description: 'Canvas components reference listing data',
        points: 15,
        phase: 'execution',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('listing') || json.includes('airbnb') || json.includes('ubud') || json.includes('price')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 20 tool calls',
        points: 20,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 20,
      },
    ],
    antiPatterns: ['No tool calls at all', 'Did not create canvas'],
  },

  // =========================================================================
  // Case 3: MCP discovery only — user mentions travel, agent discovers MCP
  // Level 3 | Tests proactive MCP search when user mentions Airbnb
  // =========================================================================
  {
    id: 'vacation-planner-discovery-only',
    name: 'Vacation Planner: Proactive Airbnb MCP discovery',
    category: 'mcp-discovery',
    level: 3,
    input: 'I\'m planning a trip to Bali and I want to find Airbnb places to stay. Can you search for real listings in Ubud?',
    maxScore: 100,
    toolMocks: AIRBNB_VACATION_PLANNER_MOCKS,
    validationCriteria: [
      {
        id: 'proactive-mcp-search',
        description: 'Proactively searched for an Airbnb MCP without being told',
        points: 30,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_search'),
      },
      {
        id: 'installed-airbnb',
        description: 'Installed the Airbnb MCP server',
        points: 20,
        phase: 'intention',
        validate: (r) => usedTool(r, 'tool_install'),
      },
      {
        id: 'used-airbnb-search',
        description: 'Used the Airbnb search tool after installing',
        points: 20,
        phase: 'execution',
        validate: (r) => usedTool(r, 'mcp_airbnb_airbnb_search'),
      },
      {
        id: 'correct-sequence',
        description: 'Tools called in correct order: search → install → use',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'tool_install')
          const useIdx = r.toolCalls.findIndex(t => t.name === 'mcp_airbnb_airbnb_search')
          return searchIdx >= 0 && installIdx > searchIdx && useIdx > installIdx
        },
      },
      {
        id: 'response-shows-listings',
        description: 'Response mentions actual listing names or prices',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const all = (r.responseText + JSON.stringify(r.toolCalls)).toLowerCase()
          return all.includes('jungle retreat') || all.includes('rice terrace') || all.includes('bamboo') || all.includes('treehouse') || all.includes('85') || all.includes('62')
        },
      },
      {
        id: 'reasonable-tool-count',
        description: 'Completed in <= 12 tool calls',
        points: 10,
        phase: 'execution',
        validate: (r) => r.toolCalls.length <= 12,
      },
    ],
    antiPatterns: [
      'No tool calls at all',
      'Built generic dashboard without searching for real data',
    ],
  },
]
