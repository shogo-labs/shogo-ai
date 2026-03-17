// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * MCP Tool: template.list
 *
 * List and search available starter templates.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { resolve } from "path"
import { readdirSync, readFileSync, existsSync } from "fs"
import { MONOREPO_ROOT } from "./paths"

/**
 * Template metadata from template.json
 */
export interface TemplateMetadata {
  name: string
  description: string
  complexity: "beginner" | "intermediate" | "advanced"
  features: string[]
  models: string[]
  tags: string[]
  useCases: string[]
  techStack: {
    database: string
    orm?: string
    frontend: string
    router?: string
    sdk?: string
    backend?: string
    ai?: string
  }
}

/**
 * Template info with path
 */
export interface TemplateInfo extends TemplateMetadata {
  path: string
  isArchive?: boolean
}

// Embedded template metadata for Docker (where we only have tar.gz archives)
// This allows template.list to work without needing to extract archives
const EMBEDDED_TEMPLATES: TemplateInfo[] = [
  // Agentic templates (connect to agent runtime via @shogo-ai/sdk/agent)
  { name: 'agent-dashboard', description: 'All-in-one control panel for viewing and managing your AI agent', path: 'agent-dashboard', complexity: 'beginner', tags: ['agent', 'dashboard', 'control-panel', 'monitoring', 'agentic'], features: ['agent-status', 'chat', 'canvas-viewer', 'workspace-browser'], useCases: ['agent dashboard', 'agent control panel', 'agent monitor', 'agent management', 'agent interface'], models: ['User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'approval-workflow', description: 'Review and approve your agent\'s work with a human-in-the-loop interface', path: 'approval-workflow', complexity: 'intermediate', tags: ['agent', 'workflow', 'approval', 'review', 'human-in-the-loop', 'agentic'], features: ['review-queue', 'approve-reject', 'agent-communication', 'real-time-updates'], useCases: ['approval workflow', 'review queue', 'human-in-the-loop', 'agent work review', 'content approval'], models: ['ReviewItem', 'Decision', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'data-explorer', description: 'Explore and visualize data your agent has collected and processed', path: 'data-explorer', complexity: 'intermediate', tags: ['agent', 'data', 'explorer', 'analytics', 'visualization', 'agentic'], features: ['data-table', 'charts', 'filtering', 'agent-chat', 'real-time-updates'], useCases: ['data pipeline UI', 'agent data explorer', 'collected data browser', 'analytics dashboard', 'data visualization'], models: ['DataRecord', 'Collection', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  // General-purpose templates
  { name: 'todo-app', description: 'Simple task management with lists', path: 'todo-app', complexity: 'beginner', tags: ['productivity', 'tasks'], features: ['CRUD', 'lists'], useCases: ['personal task tracking'], models: ['Todo', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'expense-tracker', description: 'Personal finance with categories', path: 'expense-tracker', complexity: 'beginner', tags: ['finance', 'budgeting'], features: ['categories', 'charts'], useCases: ['expense tracking'], models: ['Expense', 'Category', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'crm', description: 'Customer relationship management', path: 'crm', complexity: 'intermediate', tags: ['business', 'sales'], features: ['contacts', 'deals', 'pipeline'], useCases: ['sales management'], models: ['Contact', 'Deal', 'Company', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'inventory', description: 'Stock and product management', path: 'inventory', complexity: 'intermediate', tags: ['business', 'warehouse'], features: ['products', 'stock', 'suppliers'], useCases: ['inventory management'], models: ['Product', 'Supplier', 'StockMovement', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'kanban', description: 'Project boards with drag-and-drop', path: 'kanban', complexity: 'intermediate', tags: ['productivity', 'project-management'], features: ['boards', 'columns', 'cards', 'drag-drop'], useCases: ['project management'], models: ['Board', 'Column', 'Card', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'ai-chat', description: 'AI chatbot with conversation history', path: 'ai-chat', complexity: 'intermediate', tags: ['ai', 'chatbot'], features: ['chat', 'ai-responses', 'history'], useCases: ['ai assistant'], models: ['Conversation', 'Message', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite', ai: 'Anthropic Claude' } },
  { name: 'form-builder', description: 'Build custom forms and collect responses', path: 'form-builder', complexity: 'intermediate', tags: ['forms', 'surveys'], features: ['form-builder', 'responses'], useCases: ['surveys', 'data collection'], models: ['Form', 'Field', 'Response', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'feedback-form', description: 'Collect user feedback', path: 'feedback-form', complexity: 'beginner', tags: ['feedback', 'forms'], features: ['feedback', 'ratings'], useCases: ['user feedback'], models: ['Feedback', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
  { name: 'booking-app', description: 'Schedule appointments', path: 'booking-app', complexity: 'intermediate', tags: ['scheduling', 'appointments'], features: ['calendar', 'bookings', 'availability'], useCases: ['appointment scheduling'], models: ['Booking', 'TimeSlot', 'Service', 'User'], techStack: { frontend: 'React', backend: 'Hono', database: 'SQLite' } },
]

// Parameter schema
const Params = t({
  /** Optional search query to filter templates */
  "query?": "string",
  /** Optional complexity filter */
  "complexity?": "'beginner' | 'intermediate' | 'advanced'",
})

type TemplateListParams = typeof Params.infer

/**
 * Get the templates directory paths
 */
function getTemplatesDirs(): { examples: string; archives: string } {
  return {
    examples: resolve(MONOREPO_ROOT, "packages/sdk/examples"),
    archives: resolve(MONOREPO_ROOT, "packages/sdk/templates"),
  }
}

/**
 * Load all available templates
 * Checks both uncompressed examples (local dev) and tar.gz archives (Docker)
 */
export function loadTemplates(): TemplateInfo[] {
  const { examples: templatesDir, archives: archivesDir } = getTemplatesDirs()
  const templates: TemplateInfo[] = []

  // Check for uncompressed templates first (local development)
  if (existsSync(templatesDir)) {
    const entries = readdirSync(templatesDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const templateJsonPath = resolve(templatesDir, entry.name, "template.json")
      if (!existsSync(templateJsonPath)) continue

      try {
        const content = readFileSync(templateJsonPath, "utf-8")
        const metadata: TemplateMetadata = JSON.parse(content)
        templates.push({
          ...metadata,
          path: resolve(templatesDir, entry.name),
          isArchive: false,
        })
      } catch {
        // Skip invalid template.json files
      }
    }
    
    if (templates.length > 0) {
      return templates
    }
  }

  // Check for archived templates (Docker production mode)
  if (existsSync(archivesDir)) {
    const entries = readdirSync(archivesDir)
    const archiveNames = entries
      .filter(f => f.endsWith('.tar.gz'))
      .map(f => f.replace('.tar.gz', ''))
    
    // Return embedded metadata for available archives
    return EMBEDDED_TEMPLATES
      .filter(t => archiveNames.includes(t.name))
      .map(t => ({
        ...t,
        path: resolve(archivesDir, `${t.name}.tar.gz`),
        isArchive: true,
      }))
  }

  console.warn(`[template.list] No templates found in ${templatesDir} or ${archivesDir}`)
  return []
}

/**
 * Search templates by query string
 * Matches against name, description, tags, and useCases
 */
function searchTemplates(templates: TemplateInfo[], query: string): TemplateInfo[] {
  const queryLower = query.toLowerCase()
  const queryWords = queryLower.split(/\s+/)

  return templates
    .map((template) => {
      // Build searchable text
      const searchableText = [
        template.name,
        template.description,
        ...template.tags,
        ...template.useCases,
        ...template.models,
        ...template.features,
      ]
        .join(" ")
        .toLowerCase()

      // Score based on word matches
      let score = 0
      for (const word of queryWords) {
        if (searchableText.includes(word)) {
          score++
          // Bonus for exact tag/useCase match
          if (template.tags.some((t) => t.toLowerCase() === word)) score += 2
          if (template.useCases.some((u) => u.toLowerCase().includes(word))) score += 2
          if (template.name.toLowerCase().includes(word)) score += 3
        }
      }

      return { template, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ template }) => template)
}

/**
 * Execute template.list
 */
export async function executeTemplateList(
  args: TemplateListParams
): Promise<{ ok: boolean; templates?: TemplateInfo[]; error?: any }> {
  try {
    let templates = loadTemplates()

    // Filter by complexity if specified
    if (args.complexity) {
      templates = templates.filter((t) => t.complexity === args.complexity)
    }

    // Search if query provided
    if (args.query) {
      templates = searchTemplates(templates, args.query)
    }

    return {
      ok: true,
      templates,
    }
  } catch (error: any) {
    return {
      ok: false,
      error: {
        code: "LIST_ERROR",
        message: error.message || "Failed to list templates",
      },
    }
  }
}

/**
 * Register template.list tool
 */
export function registerTemplateList(server: FastMCP) {
  server.addTool({
    name: "template.list",
    description: `List and search available starter templates. Returns templates with metadata including name, description, complexity, features, models, and tags.

Examples:
- template.list() - List all templates
- template.list({ query: "expense" }) - Search for expense-related templates
- template.list({ query: "crm sales" }) - Search for CRM/sales templates
- template.list({ complexity: "beginner" }) - Only beginner templates
- template.list({ query: "todo", complexity: "beginner" }) - Search + filter`,
    parameters: Params as any,
    execute: async (args: any) => {
      const result = await executeTemplateList(args)
      return JSON.stringify(result, null, 2)
    },
  })
}
