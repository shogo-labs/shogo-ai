/**
 * Extract DSPy evaluation fixtures from the actual TypeScript source files.
 *
 * This is the source-of-truth pipeline:
 *   TS tests / templates / skills  →  JSON fixtures  →  Python datasets
 *
 * Run:  bun run packages/agent-runtime/src/evals/extract-fixtures.ts
 * Check: bun run packages/agent-runtime/src/evals/extract-fixtures.ts --check
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { getTemplateSummaries } from '../agent-templates'
import { VALID_COMPONENT_TYPES } from '../canvas-component-schema'
import { ALL_TOOL_NAMES } from '../gateway-tools'

const FIXTURES_DIR = resolve(import.meta.dir, 'fixtures')
const isCheckMode = process.argv.includes('--check')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripVolatileFields(obj: any): any {
  if (Array.isArray(obj)) return obj.map(stripVolatileFields)
  if (obj && typeof obj === 'object') {
    const result: any = {}
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'generated_at') continue
      result[k] = stripVolatileFields(v)
    }
    return result
  }
  return obj
}

function writeFixture(name: string, data: unknown) {
  const path = join(FIXTURES_DIR, `${name}.json`)
  const json = JSON.stringify(data, null, 2) + '\n'

  if (isCheckMode) {
    if (!existsSync(path)) {
      console.error(`MISSING: ${path}`)
      process.exit(1)
    }
    const existing = JSON.parse(readFileSync(path, 'utf-8'))
    const stableExisting = JSON.stringify(stripVolatileFields(existing))
    const stableNew = JSON.stringify(stripVolatileFields(data))
    if (stableExisting !== stableNew) {
      console.error(`OUT OF SYNC: ${path}`)
      console.error('  Run without --check to regenerate.')
      process.exit(1)
    }
    console.log(`  OK: ${name}.json`)
    return
  }

  writeFileSync(path, json)
  console.log(`  Wrote: ${name}.json`)
}

// ---------------------------------------------------------------------------
// Canvas fixtures — derived from VALID_COMPONENT_TYPES + test patterns
// ---------------------------------------------------------------------------

function extractCanvasFixtures() {
  const componentList = [...VALID_COMPONENT_TYPES].join(', ')

  return {
    _meta: {
      track: 'canvas',
      generated: true,
      generated_at: new Date().toISOString(),
      description: 'Canvas UI creation examples — extracted from dynamic-app-e2e.test.ts + managed-api-runtime.test.ts',
      sources: [
        'packages/agent-runtime/src/__tests__/dynamic-app-e2e.test.ts',
        'packages/agent-runtime/src/__tests__/managed-api-runtime.test.ts',
      ],
    },
    constants: {
      available_components: componentList,
    },
    examples: [
      {
        id: 'weather-display',
        source_test: 'agent creates a surface, adds components, and populates data via tool calls',
        user_request: 'Show me the current weather forecast',
        needs_api_schema: false,
        surface_id: 'weather',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Text', 'Badge'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 4,
      },
      {
        id: 'flight-search',
        source_test: 'agent creates a flight search UI and waits for user selection',
        user_request: 'Find flights from SFO to JFK and let me pick one',
        needs_api_schema: false,
        surface_id: 'flights',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_action_wait'],
        component_types: ['Column', 'Text', 'Card', 'Button'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 6,
      },
      {
        id: 'email-dashboard',
        source_test: 'builds a multi-section email dashboard with metrics and lists',
        user_request: 'Build an email dashboard with metrics, tabs, and email tables',
        needs_api_schema: false,
        surface_id: 'email-dashboard',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Grid', 'Metric', 'Separator', 'Tabs', 'Table', 'Alert', 'Text'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 14,
      },
      {
        id: 'analytics-dashboard',
        source_test: 'builds a dashboard with charts, metrics, and a data table',
        user_request: 'Create a sales analytics dashboard with revenue chart and top products',
        needs_api_schema: false,
        surface_id: 'analytics',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Row', 'Text', 'Badge', 'Grid', 'Metric', 'Card', 'Chart', 'Table'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 12,
      },
      {
        id: 'research-report',
        source_test: 'builds a research report with accordion sections and progress tracking',
        user_request: 'Build a research report on the EV market with progress tracking and expandable sections',
        needs_api_schema: false,
        surface_id: 'report',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Row', 'Text', 'Badge', 'Card', 'Chart', 'Accordion', 'AccordionItem', 'Grid', 'Metric', 'Table', 'Alert'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 17,
      },
      {
        id: 'counter',
        source_test: 'agent updates data without resending layout',
        user_request: 'Show a counter and set it to 42',
        needs_api_schema: false,
        surface_id: 'counter',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data', 'canvas_data'],
        component_types: ['Column', 'Metric'],
        optimal_tool_calls: 4,
        optimal_iterations: 1,
        component_count: 2,
      },
      {
        id: 'task-tracker-crud',
        source_test: 'full lifecycle: create surface → apply schema → seed → query',
        user_request: 'Build a task tracker where I can add, complete, and delete tasks',
        needs_api_schema: true,
        surface_id: 'todo-app',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Card', 'Table', 'Button', 'TextField'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 8,
      },
      {
        id: 'stock-dashboard-crud',
        source_test: 'builds a stock portfolio dashboard with price snapshots',
        user_request: 'Create a stock portfolio dashboard with price tracking',
        needs_api_schema: true,
        surface_id: 'stock-dashboard',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Grid', 'Metric', 'Card', 'Table', 'Chart'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 10,
      },
      {
        id: 'meeting-scheduler',
        source_test: 'builds a meeting scheduler form with user input and submit action',
        user_request: 'Create a meeting scheduler with date/time pickers and a submit button',
        needs_api_schema: false,
        surface_id: 'scheduler',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Card', 'Column', 'TextField', 'Select', 'ChoicePicker', 'Row', 'Button'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 9,
      },
      {
        id: 'notification-feed',
        source_test: 'builds a notification feed using DataList with template children',
        user_request: 'Show a notification feed with PR reviews, build failures, and meeting reminders',
        needs_api_schema: false,
        surface_id: 'notifications',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Text', 'DataList', 'Card', 'Row', 'Badge'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 7,
      },
      // --- New: n8n / OpenClaw / Odin AI inspired use cases ---
      {
        id: 'crm-pipeline',
        source_test: null,
        user_request: 'Build a CRM pipeline canvas showing leads in 3 stages: New, Qualified, Closed with lead details',
        needs_api_schema: false,
        surface_id: 'crm-pipeline',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Grid', 'Card', 'Text', 'Badge', 'Metric'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 12,
      },
      {
        id: 'expense-dashboard',
        source_test: null,
        user_request: 'Create an expense tracker dashboard with total spend, budget remaining, and a table of recent expenses',
        needs_api_schema: false,
        surface_id: 'expense-tracker',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Row', 'Metric', 'Table', 'Badge'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 8,
      },
      {
        id: 'cicd-monitor',
        source_test: null,
        user_request: 'Build a CI/CD pipeline monitor showing recent deploys with status and a deploy frequency chart',
        needs_api_schema: false,
        surface_id: 'cicd-monitor',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Card', 'Table', 'Badge', 'Text', 'Chart'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 10,
      },
      {
        id: 'support-tickets-crud',
        source_test: null,
        user_request: 'Build a support ticket management app with CRUD API, priority levels, and status tracking',
        needs_api_schema: true,
        surface_id: 'support-tickets',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Table', 'Button', 'Badge'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 8,
      },
      {
        id: 'invoice-tracker-crud',
        source_test: null,
        user_request: 'Build an invoice tracker with CRUD API, client name, amount, due date, status, and total metric',
        needs_api_schema: true,
        surface_id: 'invoice-tracker',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Metric', 'Table', 'Badge', 'Button'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 9,
      },
      {
        id: 'hr-pipeline-crud',
        source_test: null,
        user_request: 'Create a recruiting pipeline app tracking applicants with name, position, stage, rating, and notes',
        needs_api_schema: true,
        surface_id: 'recruiting-pipeline',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Table', 'Badge', 'Text', 'Button'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 8,
      },
      {
        id: 'social-media-dashboard',
        source_test: null,
        user_request: 'Build a social media analytics dashboard with follower/engagement metrics, trends chart, and scheduled posts table',
        needs_api_schema: false,
        surface_id: 'social-analytics',
        tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'],
        component_types: ['Column', 'Row', 'Grid', 'Metric', 'Chart', 'Table', 'Badge'],
        optimal_tool_calls: 3,
        optimal_iterations: 1,
        component_count: 14,
      },
      {
        id: 'ecommerce-orders-crud',
        source_test: null,
        user_request: 'Build an order management dashboard with CRUD showing order metrics, order table with status, and seed data',
        needs_api_schema: true,
        surface_id: 'order-management',
        tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'],
        component_types: ['Column', 'Row', 'Metric', 'Table', 'Badge', 'Button'],
        optimal_tool_calls: 5,
        optimal_iterations: 1,
        component_count: 12,
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Personality fixtures — derived from agent-templates.ts
// ---------------------------------------------------------------------------

function extractPersonalityFixtures() {
  const templates = getTemplateSummaries()

  return {
    _meta: {
      track: 'personality',
      generated: true,
      generated_at: new Date().toISOString(),
      description: 'Agent template selection + personality self-update examples — extracted from agent-templates.ts',
      sources: ['packages/agent-runtime/src/agent-templates.ts'],
      template_count: templates.length,
    },
    constants: {
      available_templates: templates.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description,
        category: t.category,
      })),
    },
    examples: [
      { id: 'personal-assistant-match', source_template: 'personal-assistant', user_description: 'I want a personal assistant that helps me manage my day', expected_template_id: 'personal-assistant', expected_confidence_min: 0.8, agent_type: 'personal', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'code-reviewer-semantic', source_template: 'code-reviewer', user_description: 'Help me review pull requests and catch bugs', expected_template_id: 'code-reviewer', expected_confidence_min: 0.7, agent_type: 'development', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'github-monitor-match', source_template: 'github-monitor', user_description: 'Monitor my GitHub repos for new issues and CI failures', expected_template_id: 'github-monitor', expected_confidence_min: 0.8, agent_type: 'development', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'meal-planner-semantic', source_template: 'meal-planner', user_description: 'I need help tracking what I eat and planning meals', expected_template_id: 'meal-planner', expected_confidence_min: 0.7, agent_type: 'personal', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'crypto-monitor-custom', source_template: null, user_description: 'Build me an agent that monitors cryptocurrency prices and sends alerts', expected_template_id: 'custom', expected_confidence_min: 0.0, agent_type: 'operations', expected_soul_has_boundaries: true, optimal_tool_calls: 4, optimal_iterations: 1 },
      { id: 'research-agent-match', source_template: 'research-agent', user_description: 'I need a research agent for web research and daily briefings', expected_template_id: 'research-agent', expected_confidence_min: 0.8, agent_type: 'research', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'system-monitor-ambiguous', source_template: 'system-monitor', user_description: 'Help me keep my servers running smoothly', expected_template_id: 'system-monitor', expected_confidence_min: 0.5, agent_type: 'operations', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'customer-support-semantic', source_template: 'customer-support', user_description: 'I want an agent to help triage and respond to customer tickets', expected_template_id: 'customer-support', expected_confidence_min: 0.7, agent_type: 'business', expected_soul_has_boundaries: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'self-update-tone-correction', source_template: null, type: 'self-update', conversation_summary: "User said: 'You're being too casual. Please be more formal and professional.'", current_soul: '# Soul\n\n## Identity\nYou are a helpful assistant.\n\n## Communication Style\nCasual, friendly, uses emojis.\n\n## Boundaries\n- Don\'t be rude', expected_should_update: true, expected_file: 'SOUL.md', expected_section: 'Communication Style', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'self-update-trivial-no-op', source_template: null, type: 'self-update', conversation_summary: "User said: 'What's the weather like?' Agent responded with weather info.", current_soul: '# Soul\n\n## Identity\nYou are a helpful assistant.\n\n## Communication Style\nFriendly and concise.\n\n## Boundaries\n- Don\'t be rude', expected_should_update: false, expected_file: '', expected_section: '', optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'self-update-new-boundary', source_template: null, type: 'self-update', conversation_summary: "User said: 'Never suggest changes to my database schema. Just analyze it.'", current_soul: '# Soul\n\n## Identity\nYou are a database assistant.\n\n## Communication Style\nTechnical, detailed.\n\n## Boundaries\n- Don\'t execute DDL without approval', expected_should_update: true, expected_file: 'SOUL.md', expected_section: 'Boundaries', optimal_tool_calls: 1, optimal_iterations: 1 },
      // --- New: n8n / OpenClaw / Odin AI inspired use cases ---
      { id: 'self-update-domain-expertise', source_template: null, type: 'self-update', conversation_summary: "User said: 'You are now a senior DevOps engineer. Always think about infrastructure costs, security implications, and deployment reliability.'", current_soul: '# Soul\n\n## Identity\nYou are a helpful assistant.\n\n## Communication Style\nFriendly and concise.\n\n## Boundaries\n- Don\'t be rude', expected_should_update: true, expected_file: 'SOUL.md', expected_section: 'Identity', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'self-update-safety-boundaries', source_template: null, type: 'self-update', conversation_summary: "User said: 'Never execute shell commands without asking me first. Never access production databases directly. Always suggest a dry-run before destructive operations.'", current_soul: '# Soul\n\n## Identity\nYou are a helpful DevOps assistant.\n\n## Communication Style\nTechnical, clear.\n\n## Boundaries\n- Be careful with destructive operations', expected_should_update: true, expected_file: 'AGENTS.md', expected_section: 'Boundaries', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'self-update-style-noop', source_template: null, type: 'self-update', conversation_summary: "User said: 'Can you rewrite this in bullet points instead? Here\\'s the text: The quarterly results show growth in three areas.'", current_soul: '# Soul\n\n## Identity\nYou are a helpful assistant.\n\n## Communication Style\nFriendly and concise.\n\n## Boundaries\n- Don\'t be rude', expected_should_update: false, expected_file: '', expected_section: '', optimal_tool_calls: 0, optimal_iterations: 0 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Skill fixtures — constants derived from ALL_TOOL_NAMES
// ---------------------------------------------------------------------------

function extractSkillFixtures() {
  return {
    _meta: {
      track: 'skill',
      generated: true,
      generated_at: new Date().toISOString(),
      description: 'Skill matching + skill creation examples — derived from skills.ts',
      sources: ['packages/agent-runtime/src/skills.ts'],
      all_tool_names: [...ALL_TOOL_NAMES],
    },
    constants: {
      available_skills: [
        { name: 'git-summary', description: 'Summarize recent git activity', trigger: 'git summary|repo summary|commit log' },
        { name: 'daily-digest', description: 'Compile a daily activity digest', trigger: 'daily digest|morning brief|daily summary' },
        { name: 'check-github', description: 'Check GitHub for new issues and PRs', trigger: 'check github|github status|new issues|new prs' },
        { name: 'deploy-status', description: 'Check deployment status', trigger: 'deploy status|deployment|deploy check|is it deployed' },
        { name: 'web-research', description: 'Research a topic on the web', trigger: 'research|look up|find info|web search' },
      ],
    },
    examples: [
      { id: 'exact-git-summary', type: 'match', user_message: 'git summary', expected_skill: 'git-summary', expected_confidence_min: 0.9, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'semantic-repo-changes', type: 'match', user_message: 'what changed in the repo this week', expected_skill: 'git-summary', expected_confidence_min: 0.7, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'semantic-prs', type: 'match', user_message: 'are there any new pull requests I should look at', expected_skill: 'check-github', expected_confidence_min: 0.7, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'no-match-weather', type: 'match', user_message: "what's the weather like today", expected_skill: 'none', expected_confidence_min: 0.0, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'ambiguous-summarize', type: 'match', user_message: 'summarize things for me', expected_skill: 'daily-digest', expected_confidence_min: 0.5, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'semantic-build-deploy', type: 'match', user_message: 'is the build green? did the latest deploy work?', expected_skill: 'deploy-status', expected_confidence_min: 0.7, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'exact-research', type: 'match', user_message: 'research the latest AI model benchmarks', expected_skill: 'web-research', expected_confidence_min: 0.8, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'semantic-morning-brief', type: 'match', user_message: 'give me a morning briefing', expected_skill: 'daily-digest', expected_confidence_min: 0.8, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'create-github-pr-check', type: 'create', user_description: 'Create a skill that checks my GitHub PRs and summarizes review status', expected_skill_name: 'github-pr-check', expected_trigger_phrases_min: 3, expected_tools: ['web', 'memory_write'], optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'create-daily-standup', type: 'create', user_description: 'Make a skill for daily standup notes that reads yesterday\'s work and helps plan today', expected_skill_name: 'daily-standup', expected_trigger_phrases_min: 3, expected_tools: ['memory_read', 'memory_write'], optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'create-server-health', type: 'create', user_description: 'Build a skill that monitors server health by checking CPU, memory, and disk usage', expected_skill_name: 'server-health', expected_trigger_phrases_min: 3, expected_tools: ['exec', 'memory_write'], optimal_tool_calls: 1, optimal_iterations: 1 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Multiturn fixtures — tool list derived from ALL_TOOL_NAMES
// ---------------------------------------------------------------------------

function extractMultiturnFixtures() {
  return {
    _meta: {
      track: 'multiturn',
      generated: true,
      generated_at: new Date().toISOString(),
      description: 'Multi-turn conversation planning + session summarization — extracted from e2e-scenarios.test.ts',
      sources: [
        'packages/agent-runtime/src/__tests__/e2e-scenarios.test.ts',
        'packages/agent-runtime/src/__tests__/dynamic-app-e2e.test.ts',
      ],
    },
    constants: {
      available_tools: ALL_TOOL_NAMES.join(', '),
    },
    examples: [
      { id: 'deploy-log-report', type: 'plan', source_test: 'agent reads config, checks status, and writes a report', user_message: 'Check the deploy log and write a summary report', conversation_history_summary: '', expected_tool_sequence: ['read_file', 'write_file'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'csv-to-json', type: 'plan', source_test: 'agent reads a file, transforms it, and writes the result', user_message: 'Convert data.csv to JSON format and save it', conversation_history_summary: '', expected_tool_sequence: ['read_file', 'write_file'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'discord-notification', type: 'plan', source_test: 'agent send_message tool delivers cross-channel notifications', user_message: 'Notify the Discord channel that v2.4.0 has been deployed', conversation_history_summary: '', expected_tool_sequence: ['send_message'], expected_iterations: 1, expected_can_batch: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'task-tracker-build', type: 'plan', source_test: 'full lifecycle: create surface → apply schema → seed → query', user_message: 'Build me a task tracker where I can add, complete, and delete tasks', conversation_history_summary: '', expected_tool_sequence: ['canvas_create', 'canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 5, optimal_iterations: 1 },
      { id: 'flight-search-interactive', type: 'plan', source_test: 'agent creates a flight search UI and waits for user selection', user_message: 'Find flights from SFO to JFK and let me pick one', conversation_history_summary: '', expected_tool_sequence: ['canvas_create', 'canvas_update', 'canvas_action_wait'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 3, optimal_iterations: 1 },
      { id: 'weather-visual', type: 'plan', source_test: 'agent creates a surface, adds components, and populates data via tool calls', user_message: "What's the weather like today? Show it visually", conversation_history_summary: '', expected_tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 3, optimal_iterations: 1 },
      { id: 'name-recall-from-history', type: 'plan', source_test: 'session history accumulates across turns', user_message: "What's my name?", conversation_history_summary: 'User: My name is Alice. Agent: Nice to meet you, Alice!', expected_tool_sequence: [], expected_iterations: 0, expected_can_batch: true, optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'multi-channel-notify', type: 'plan', source_test: null, user_message: 'Send a message to both Slack and Discord about the new release', conversation_history_summary: '', expected_tool_sequence: ['send_message', 'send_message'], expected_iterations: 1, expected_can_batch: true, optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'research-and-save', type: 'plan', source_test: null, user_message: 'Research the latest AI model benchmarks and save a summary', conversation_history_summary: '', expected_tool_sequence: ['web', 'memory_write'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'summary-github-session', type: 'summarize', messages_text: "user: My name is Alice, I'm in PST timezone.\nassistant: Nice to meet you, Alice! I'll keep your timezone in mind.\nuser: Can you check my GitHub for new PRs?\nassistant: [tool: web] Found 3 open PRs needing review.\nuser: Great, summarize them.\nassistant: 1. Fix auth bug (#142) - 2 approvals. 2. Add dark mode (#143) - needs review. 3. Refactor DB (#144) - 1 comment.", expected_key_facts: ['User: Alice', 'PST timezone', '3 open PRs', '#143 needs review'], expected_user_preferences: ['Timezone: PST'], optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'summary-heartbeat-session', type: 'summarize', messages_text: "system: Heartbeat check.\nassistant: [tool: exec] All systems nominal. CPU: 23%, Memory: 4.2GB/16GB.\nsystem: Heartbeat check.\nassistant: [tool: exec] All systems nominal. CPU: 21%, Memory: 4.1GB/16GB.\nsystem: Heartbeat check.\nassistant: [tool: exec] All systems nominal. CPU: 25%, Memory: 4.3GB/16GB.\nuser: Hey, any issues today?\nassistant: No issues detected. All 3 heartbeat checks passed with normal metrics.", expected_key_facts: ['3 heartbeat checks', 'all passed', 'No issues'], expected_user_preferences: [], optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'summary-deploy-session', type: 'summarize', messages_text: "user: Deploy the new version to staging.\nassistant: [tool: exec] Running deployment to staging... Done. v2.4.0 deployed.\nuser: Run the smoke tests.\nassistant: [tool: exec] All 12 smoke tests passed.\nuser: Great, deploy to production.\nassistant: [tool: exec] Deploying to production... Done. v2.4.0 is live.\nuser: Notify the team on Slack.\nassistant: [tool: send_message] Posted to #releases: v2.4.0 deployed to production.", expected_key_facts: ['v2.4.0', 'staging', 'production', '12 smoke tests passed', 'Slack #releases'], expected_user_preferences: [], optimal_tool_calls: 0, optimal_iterations: 0 },
      // --- New: n8n / OpenClaw / Odin AI inspired use cases ---
      { id: 'upgrade-display-to-crud', type: 'plan', source_test: null, user_message: 'Now make my contact list a full CRUD app — add an API backend and seed with 3 contacts', conversation_history_summary: 'User previously built a simple contact list canvas with name, email, phone', expected_tool_sequence: ['canvas_api_schema', 'canvas_api_seed', 'canvas_api_query', 'canvas_update'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 4, optimal_iterations: 1 },
      { id: 'memory-to-canvas-kpi', type: 'plan', source_test: null, user_message: 'Build me a KPI dashboard canvas using the metrics I told you about', conversation_history_summary: "User previously said: 'Remember our team tracks these KPIs: MRR, churn rate, NPS score, and active users.'", expected_tool_sequence: ['canvas_create', 'canvas_update', 'canvas_data'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 3, optimal_iterations: 1 },
      { id: 'incident-escalation', type: 'plan', source_test: null, user_message: 'Log this in memory as an active incident, then show me an incident status canvas with severity badge', conversation_history_summary: "User reported: 'Critical ticket — Production database is down, from customer Acme Corp'", expected_tool_sequence: ['memory_write', 'canvas_create', 'canvas_update', 'canvas_data'], expected_iterations: 1, expected_can_batch: false, optimal_tool_calls: 4, optimal_iterations: 1 },
      { id: 'iterative-expense-alert', type: 'plan', source_test: null, user_message: "Add an Alert component at the top warning that we're at 85% of budget, yellow/warning severity", conversation_history_summary: 'User previously built an expense dashboard with metrics and a category Chart', expected_tool_sequence: ['canvas_update'], expected_iterations: 1, expected_can_batch: true, optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'personality-then-verify', type: 'plan', source_test: null, user_message: 'What are the benefits of using TypeScript?', conversation_history_summary: 'User previously asked agent to update personality to always respond in exactly 3 bullet points', expected_tool_sequence: [], expected_iterations: 0, expected_can_batch: true, optimal_tool_calls: 0, optimal_iterations: 0 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Memory fixtures — mostly hand-authored but validated against tool names
// ---------------------------------------------------------------------------

function extractMemoryFixtures() {
  return {
    _meta: {
      track: 'memory',
      generated: true,
      generated_at: new Date().toISOString(),
      description: 'Memory write/retrieval decision examples — extracted from e2e-scenarios.test.ts',
      sources: ['packages/agent-runtime/src/__tests__/e2e-scenarios.test.ts'],
    },
    examples: [
      { id: 'boot-startup', source_test: 'BOOT.md startup writes a status file and records to memory', user_message: 'Execute BOOT.md startup sequence', conversation_summary: 'Agent executed BOOT.md: wrote status file, recorded startup to memory', tools_used: ['write_file', 'memory_write'], current_memory: '# Memory\n', has_session_context: false, expected_write: true, expected_target_file: 'MEMORY.md', expected_content: 'System startup completed. Status file written.', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'deploy-report', source_test: 'agent reads config, checks status, and writes a report', user_message: 'Check the deploy log and write a summary report', conversation_summary: 'Agent read deploy.log, wrote summary to deploy-report.md', tools_used: ['read_file', 'write_file'], current_memory: '# Memory\nPrevious deploys tracked.', has_session_context: false, expected_write: true, expected_target_file: '2026-02-20', expected_content: 'Deploy report generated from deploy.log. Summary written to deploy-report.md.', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'csv-conversion', source_test: 'agent reads a file, transforms it, and writes the result', user_message: 'Convert data.csv to data.json', conversation_summary: 'Agent read data.csv, converted to JSON, wrote data.json', tools_used: ['read_file', 'write_file'], current_memory: '# Memory\n', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 2, optimal_iterations: 1 },
      { id: 'channel-summarize', source_test: 'message through mock channel triggers tool use', user_message: 'Summarize the latest messages in #general', conversation_summary: 'Agent read channel messages, provided summary', tools_used: ['read_file'], current_memory: '# Memory\n', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'name-recall', source_test: 'session history accumulates across turns', user_message: "What's my name?", conversation_summary: "User previously said 'My name is Alice' in this session", tools_used: [], current_memory: '# Memory\n', has_session_context: true, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'user-timezone', source_test: null, user_message: "I'm in PST timezone, keep that in mind", conversation_summary: 'User stated timezone preference: PST', tools_used: [], current_memory: '# Memory\nUser name: Alice', has_session_context: false, expected_write: true, expected_target_file: 'MEMORY.md', expected_content: 'User timezone: PST (Pacific Standard Time)', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'search-past-deploy', source_test: null, user_message: 'What did I deploy last Tuesday?', conversation_summary: 'User asking about past deployment', tools_used: [], current_memory: '# Memory\nUser name: Alice\nTimezone: PST', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'memory_search', expected_retrieval_query: 'deploy Tuesday', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'read-yesterday', source_test: null, user_message: 'Show me what happened yesterday', conversation_summary: "User wants yesterday's activity log", tools_used: [], current_memory: '# Memory\n', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'memory_read', expected_retrieval_query: '2026-02-19', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'redundant-name', source_test: null, user_message: 'Remember my name is Alice', conversation_summary: "User reminded agent of name, but it's already stored", tools_used: [], current_memory: '# Memory\nUser name: Alice\nTimezone: PST', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 0, optimal_iterations: 0 },
      { id: 'greeting', source_test: null, user_message: 'Hey, good morning!', conversation_summary: 'Casual greeting exchange', tools_used: [], current_memory: '# Memory\n', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 0, optimal_iterations: 0 },
      // --- New: n8n / OpenClaw / Odin AI inspired use cases ---
      { id: 'project-context', source_test: null, user_message: "Remember that our project 'Phoenix' uses React 19, deploys to AWS us-east-1, and the staging URL is https://staging.phoenix.io. We do deploys every Tuesday.", conversation_summary: 'User shared project context: Phoenix, React 19, AWS us-east-1, staging URL, Tuesday deploys', tools_used: [], current_memory: '# Memory\n', has_session_context: false, expected_write: true, expected_target_file: 'MEMORY.md', expected_content: 'Project Phoenix: React 19, AWS us-east-1, staging https://staging.phoenix.io, deploys every Tuesday', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'notification-routing', source_test: null, user_message: 'For urgent issues, notify me on Slack channel #incidents. For weekly reports, email me at ops@company.com. For everything else, just post in our general channel.', conversation_summary: 'User configured notification routing: urgent → Slack #incidents, weekly → email ops@company.com, default → general channel', tools_used: [], current_memory: '# Memory\n', has_session_context: false, expected_write: true, expected_target_file: 'MEMORY.md', expected_content: 'Notification routing: urgent → Slack #incidents, weekly reports → ops@company.com, default → general channel', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'ephemeral-currency-conversion', source_test: null, user_message: 'Convert 1,500 USD to EUR at today\'s exchange rate.', conversation_summary: 'User asked for a one-off currency conversion — should use web but not persist', tools_used: ['web'], current_memory: '# Memory\n', has_session_context: false, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'none', expected_retrieval_query: '', optimal_tool_calls: 1, optimal_iterations: 1 },
      { id: 'search-deployment-process', source_test: null, user_message: 'What deployment process did we agree on last time? Check your memory.', conversation_summary: 'User asking about previously agreed deployment process', tools_used: [], current_memory: '# Memory\nDeployment process: 1) PR to staging, 2) Run e2e suite, 3) Sign-off from on-call, 4) Merge to main auto-deploys to prod.', has_session_context: true, expected_write: false, expected_target_file: '', expected_content: '', expected_retrieval_tool: 'memory_search', expected_retrieval_query: 'deployment process', optimal_tool_calls: 1, optimal_iterations: 1 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(isCheckMode ? 'Checking fixtures...' : 'Extracting fixtures...')

writeFixture('canvas', extractCanvasFixtures())
writeFixture('memory', extractMemoryFixtures())
writeFixture('personality', extractPersonalityFixtures())
writeFixture('skill', extractSkillFixtures())
writeFixture('multiturn', extractMultiturnFixtures())

console.log(isCheckMode ? 'All fixtures up to date.' : 'Done.')
