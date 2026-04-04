// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Composio tool schema fetch
 *
 * Fetches full tool metadata (including input/output JSON schemas) from the
 * Composio REST API. Used by composio integration and evals.
 */

// ---------------------------------------------------------------------------
// Composio REST API types (from GET /api/v3/tools)
// ---------------------------------------------------------------------------

export interface ComposioToolSchema {
  slug: string
  name: string
  description?: string
  input_parameters?: JsonSchemaObject
  output_parameters?: JsonSchemaObject
  tags?: string[]
  toolkit?: { slug: string; name: string; logo?: string }
  no_auth?: boolean
  version?: string
  is_deprecated?: boolean
  scopes?: string[]
}

interface JsonSchemaObject {
  type: 'object'
  properties?: Record<string, JsonSchemaProperty>
  required?: string[]
  additionalProperties?: boolean
}

interface JsonSchemaProperty {
  type?: string
  description?: string
  properties?: Record<string, JsonSchemaProperty>
  items?: JsonSchemaProperty
  required?: string[]
  additionalProperties?: boolean
  nullable?: boolean
  title?: string
  default?: unknown
  anyOf?: JsonSchemaProperty[]
  oneOf?: JsonSchemaProperty[]
  enum?: string[]
}

// ---------------------------------------------------------------------------
// Composio REST API client
// ---------------------------------------------------------------------------

interface ComposioToolsResponse {
  total_items: number
  current_page: number
  total_pages: number
  next_cursor?: string | null
  items: ComposioToolSchema[]
}

/**
 * Fetch tools from the Composio REST API with full schema information.
 */
export async function fetchComposioToolSchemas(
  toolkitSlug: string,
  options?: { apiKey?: string; important?: boolean; limit?: number },
): Promise<ComposioToolSchema[]> {
  const directKey = options?.apiKey || process.env.COMPOSIO_API_KEY
  const proxyUrl = process.env.TOOLS_PROXY_URL
  const proxyToken = process.env.AI_PROXY_TOKEN

  const authKey = directKey || proxyToken
  if (!authKey) throw new Error('COMPOSIO_API_KEY or TOOLS_PROXY_URL + AI_PROXY_TOKEN required')

  const baseUrl = directKey
    ? 'https://backend.composio.dev'
    : `${proxyUrl}/composio`

  const params = new URLSearchParams({
    toolkit_slug: toolkitSlug,
    limit: String(options?.limit || 100),
  })
  if (options?.important) params.set('important', 'true')

  const t0 = performance.now()
  const res = await fetch(`${baseUrl}/api/v3/tools?${params}`, {
    headers: { 'x-api-key': authKey },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    throw new Error(`Composio API error: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as ComposioToolsResponse
  const items = data.items || []
  const elapsed = performance.now() - t0
  console.log(`[Composio] [Timing] fetchSchemas(${toolkitSlug}): ${elapsed.toFixed(0)}ms (${items.length} tools)`)
  return items
}
