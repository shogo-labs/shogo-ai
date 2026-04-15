// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Luxury Trip Planner Eval Test Cases
 *
 * End-to-end scenario: user wants a comprehensive luxury trip to Bali.
 * The agent must:
 *
 * 1. Use the web tool to research flights to Bali
 * 2. Discover and install the Airbnb MCP to find luxury accommodations
 * 3. Use the Airbnb MCP search tool to find luxury villas / boutique stays
 * 4. Build a canvas with Airbnb links (OPEN mutation) so the user can
 *    click through to actual listings
 * 5. Produce a comprehensive itinerary covering flights, accommodations,
 *    restaurants, activities, and transportation
 *
 * This eval validates the agent's ability to combine built-in tools (web)
 * with dynamically discovered MCP tools (Airbnb) to fulfill a complex,
 * multi-faceted planning request.
 */

import type { AgentEval, EvalResult } from './types'
import { LUXURY_BALI_TRIP_PLANNER_MOCKS } from './tool-mocks'
import {
  usedTool,
  usedToolAnywhere,
  responseContains,
  toolCallsJson,
} from './eval-helpers'

// ---------------------------------------------------------------------------
// Trip-planner-specific helpers
// ---------------------------------------------------------------------------

/** All text from response + every tool call's input/output, lowercased. */
function allContent(result: EvalResult): string {
  return (result.responseText + JSON.stringify(result.toolCalls)).toLowerCase()
}

/** True if any written code contains Airbnb links. */
function canvasHasOpenMutation(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const content = String((t.input as any).content ?? (t.input as any).new_string ?? '').toLowerCase()
    return content.includes('airbnb.com') || (content.includes('href') && content.includes('airbnb'))
  })
}

/** True if any written code contains an Airbnb URL. */
function canvasHasAirbnbLinks(result: EvalResult): boolean {
  return result.toolCalls.some(t => {
    if (t.name !== 'write_file' && t.name !== 'edit_file') return false
    const content = String((t.input as any).content ?? (t.input as any).new_string ?? '').toLowerCase()
    return content.includes('airbnb.com/rooms') || content.includes('airbnb.com')
  })
}

// ---------------------------------------------------------------------------
// Test Cases
// ---------------------------------------------------------------------------

export const TRIP_PLANNER_EVALS: AgentEval[] = [

  // =========================================================================
  // Case 1: Full Luxury Bali Trip Planner
  // Level 5 | Single turn: web (flights) + MCP discovery (airbnb) + itinerary
  // =========================================================================
  {
    id: 'trip-planner-bali-luxury',
    name: 'Trip Planner: Luxury Bali itinerary with flights & Airbnb',
    category: 'mcp-orchestration',
    level: 5,
    input: 'I want to plan a luxury trip to Bali, Indonesia. The trip should start next monday and it should be for 10 days. My budget is $5,000. I want an agent that can help me plan the full itinerary including luxury accommodations (Airbnb villas or boutique hotels), high-end restaurants, activities, and transportation. Please help me create a comprehensive trip planner.',
    maxScore: 100,
    toolMocks: LUXURY_BALI_TRIP_PLANNER_MOCKS,
    validationCriteria: [
      // --- Web tool for flight research ---
      {
        id: 'used-web-for-flights',
        description: 'Used the web tool to search for flights to Bali',
        points: 15,
        phase: 'intention',
        validate: (r) => {
          const webCalls = r.toolCalls.filter(t => t.name === 'web')
          if (webCalls.length === 0) return false
          const json = JSON.stringify(webCalls.map(c => c.input)).toLowerCase()
          return json.includes('flight') || json.includes('bali') || json.includes('dps') || json.includes('airline')
        },
      },
      // --- Airbnb MCP discovery ---
      {
        id: 'searched-for-airbnb-mcp',
        description: 'Used mcp_search to find the Airbnb MCP server',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'mcp_search') || usedToolAnywhere(r, 'tool_search'),
      },
      {
        id: 'search-query-relevant',
        description: 'Search query relates to airbnb/accommodation/travel',
        points: 5,
        phase: 'intention',
        validate: (r) => {
          const json = toolCallsJson(r)
          return json.includes('airbnb') || json.includes('accommodation') || json.includes('travel') || json.includes('listing') || json.includes('rental') || json.includes('villa') || json.includes('hotel')
        },
      },
      {
        id: 'installed-airbnb-mcp',
        description: 'Used mcp_install to add the Airbnb MCP server',
        points: 10,
        phase: 'intention',
        validate: (r) => usedToolAnywhere(r, 'mcp_install'),
      },
      // --- Actually used Airbnb search ---
      {
        id: 'used-airbnb-search',
        description: 'Used the Airbnb search tool to find Bali listings',
        points: 10,
        phase: 'execution',
        validate: (r) => usedTool(r, 'mcp_airbnb_airbnb_search'),
      },
      {
        id: 'correct-discovery-sequence',
        description: 'MCP tools called in correct order: search → install → use',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const searchIdx = r.toolCalls.findIndex(t => t.name === 'mcp_search' || t.name === 'tool_search')
          const installIdx = r.toolCalls.findIndex(t => t.name === 'mcp_install')
          const useIdx = r.toolCalls.findIndex(t => t.name === 'mcp_airbnb_airbnb_search')
          return searchIdx >= 0 && installIdx > searchIdx && useIdx > installIdx
        },
      },
      // --- Canvas has clickable Airbnb links ---
      {
        id: 'canvas-airbnb-links',
        description: 'Canvas includes Airbnb listing URLs or OPEN mutations for listings',
        points: 10,
        phase: 'execution',
        validate: (r) => canvasHasAirbnbLinks(r) || canvasHasOpenMutation(r),
      },
      // --- Response quality: comprehensive itinerary ---
      {
        id: 'has-flight-info',
        description: 'Flight information appears in response text or canvas',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const text = r.responseText.toLowerCase()
          const inResponse = (text.includes('flight') || text.includes('airline')) &&
                 (text.includes('$') || text.includes('economy') || text.includes('business') || text.includes('round trip'))
          if (inResponse) return true
          const content = allContent(r)
          return (content.includes('singapore airlines') || content.includes('qatar') || content.includes('cathay')) &&
                 (content.includes('980') || content.includes('1,100') || content.includes('1,250') || content.includes('2,900'))
        },
      },
      {
        id: 'response-mentions-accommodations',
        description: 'Response or canvas mentions Airbnb listings or luxury accommodations',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const content = allContent(r)
          return content.includes('villa') || content.includes('airbnb') ||
                 content.includes('ubud') || content.includes('seminyak') ||
                 content.includes('accommodation') || content.includes('hotel')
        },
      },
      {
        id: 'response-mentions-restaurants-or-activities',
        description: 'Response covers restaurants or activities',
        points: 5,
        phase: 'execution',
        validate: (r) => {
          const content = allContent(r)
          const hasRestaurants = content.includes('restaurant') || content.includes('dining') || content.includes('food') || content.includes('cuisine')
          const hasActivities = content.includes('activity') || content.includes('tour') || content.includes('temple') || content.includes('surf') || content.includes('spa') || content.includes('trek')
          return hasRestaurants || hasActivities
        },
      },
      {
        id: 'response-addresses-budget',
        description: 'Response acknowledges or plans around the $5,000 budget',
        points: 10,
        phase: 'execution',
        validate: (r) => {
          const content = allContent(r)
          return content.includes('5,000') || content.includes('5000') || content.includes('budget')
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
      'Agent did not use the web tool for flight research',
      'Agent did not install the Airbnb MCP for accommodation search',
      'Agent only addressed one aspect of the trip (flights only, or accommodations only)',
      'Agent ignored the $5,000 budget constraint entirely',
      'Canvas does not include links to Airbnb listings',
    ],
  },
]
