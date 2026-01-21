/**
 * MCP Tool: template.list
 *
 * List and search available starter templates.
 */

import { type as t } from "arktype"
import { FastMCP } from "fastmcp"
import { resolve } from "path"
import { readdirSync, readFileSync, existsSync } from "fs"
import { MONOREPO_ROOT } from "../state"

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
    orm: string
    frontend: string
    router: string
    sdk: string
  }
}

/**
 * Template info with path
 */
export interface TemplateInfo extends TemplateMetadata {
  path: string
}

// Parameter schema
const Params = t({
  /** Optional search query to filter templates */
  "query?": "string",
  /** Optional complexity filter */
  "complexity?": "'beginner' | 'intermediate' | 'advanced'",
})

type TemplateListParams = typeof Params.infer

/**
 * Get the templates directory path
 */
function getTemplatesDir(): string {
  return resolve(MONOREPO_ROOT, "packages/sdk/examples")
}

/**
 * Load all available templates
 */
export function loadTemplates(): TemplateInfo[] {
  const templatesDir = getTemplatesDir()
  const templates: TemplateInfo[] = []

  if (!existsSync(templatesDir)) {
    return templates
  }

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
      })
    } catch {
      // Skip invalid template.json files
    }
  }

  return templates
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
