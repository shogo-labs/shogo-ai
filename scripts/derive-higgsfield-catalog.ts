// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * Derive `docs/vendors/higgsfield/catalog.json` from the committed
 * `llms-full.txt` snapshot.
 *
 * The vendor's docs are the only place the endpoint ids, their parameters and
 * their output shapes are written down, and they are prose with embedded JSON
 * schemas rather than an OpenAPI file. This turns them into something a check
 * can compare against the code, so a model id in our catalog that the vendor
 * has renamed (or dropped) fails CI instead of failing at 3 a.m. in a user's
 * render.
 *
 * Deterministic on purpose: keys are sorted and the output has no timestamps,
 * so `check:higgsfield-docs` can regenerate and diff it byte for byte.
 *
 * Usage:
 *   bun run scripts/derive-higgsfield-catalog.ts [--write]
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'

const REPO_ROOT = resolve(import.meta.dir, '..')
const DOCS_DIR = join(REPO_ROOT, 'docs/vendors/higgsfield')
const SOURCE = join(DOCS_DIR, 'llms-full.txt')
export const CATALOG_PATH = join(DOCS_DIR, 'catalog.json')
export const SOURCE_URL = 'https://docs.higgsfield.ai/llms-full.txt'

export type EndpointKind = 'image' | 'video' | 'edit' | 'other'

export interface CatalogField {
  type: string
  required: boolean
  /** Enum values, when the schema restricts them. */
  enum?: string[]
  /** Array item type, for `type: "array"`. */
  items?: string
}

export interface CatalogEndpoint {
  title: string
  kind: EndpointKind
  fields: Record<string, CatalogField>
  /** Where the output lives in the status response (`images[].url`, `video.url`). */
  outputs: string[]
}

export interface HiggsfieldCatalog {
  generated_from: string
  source_url: string
  endpoints: Record<string, CatalogEndpoint>
}

interface Section {
  title: string
  lines: string[]
}

function splitSections(text: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('# ')) {
      if (current) sections.push(current)
      current = { title: line.slice(2).trim(), lines: [] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) sections.push(current)
  return sections
}

/** The JSON schema fenced block that follows the "Complete JSON schema" heading. */
function extractSchema(lines: string[]): any | null {
  const marker = lines.findIndex((line) => line.includes('Complete JSON schema'))
  if (marker < 0) return null
  let start = -1
  let end = -1
  for (let i = marker; i < lines.length; i++) {
    if (start < 0 && lines[i].trim().startsWith('```json')) start = i + 1
    else if (start >= 0 && lines[i].trim() === '```') {
      end = i
      break
    }
  }
  if (start < 0 || end < 0) return null
  try {
    return JSON.parse(lines.slice(start, end).join('\n'))
  } catch {
    return null
  }
}

export function endpointIdOf(lines: string[]): string | null {
  for (const line of lines) {
    const match = /^\*\*Endpoint ID:\*\*\s*`?([^`\s]+)`?/.exec(line.trim())
    if (match) return match[1]
  }
  return null
}

/** Coarse category, used by the check to confirm a model is wired on the right route. */
export function kindOf(title: string, schema: any): EndpointKind {
  const properties: Record<string, any> = schema?.properties ?? {}
  if (properties.video_url) return 'edit'
  if (title.toLowerCase().includes('genjutsu') || title.toLowerCase().includes('restyle')) return 'edit'
  if (/text to video|image to video/i.test(title)) return 'video'
  if (/text to image|generate|image/i.test(title)) return 'image'
  return 'other'
}

function fieldsOf(schema: any): Record<string, CatalogField> {
  const properties: Record<string, any> = schema?.properties ?? {}
  const required: string[] = Array.isArray(schema?.required) ? schema.required : []
  const fields: Record<string, CatalogField> = {}
  for (const name of Object.keys(properties).sort()) {
    const spec = properties[name] ?? {}
    const field: CatalogField = {
      type: Array.isArray(spec.type) ? spec.type.join('|') : String(spec.type ?? 'any'),
      required: required.includes(name),
    }
    if (Array.isArray(spec.enum)) field.enum = spec.enum.map(String)
    if (field.type === 'array' && spec.items?.type) field.items = Array.isArray(spec.items.type) ? spec.items.type.join('|') : String(spec.items.type)
    fields[name] = field
  }
  return fields
}

function outputsOf(kind: EndpointKind, schema: any): string[] {
  const properties: Record<string, any> = schema?.properties ?? {}
  if (kind === 'image' || properties.images) return ['images[].url']
  if (properties.video || kind === 'video' || kind === 'edit') return ['video.url']
  return []
}

export function deriveCatalog(text: string): HiggsfieldCatalog {
  const endpoints: Record<string, CatalogEndpoint> = {}
  for (const section of splitSections(text)) {
    const id = endpointIdOf(section.lines)
    const schema = extractSchema(section.lines)
    if (!id || !schema) continue
    const kind = kindOf(section.title, schema)
    // A model page can appear twice (request/response walkthrough); keep the
    // richest entry so the output does not depend on document order.
    const candidate: CatalogEndpoint = {
      title: section.title,
      kind,
      fields: fieldsOf(schema),
      outputs: outputsOf(kind, schema),
    }
    const existing = endpoints[id]
    if (!existing || Object.keys(candidate.fields).length > Object.keys(existing.fields).length) {
      endpoints[id] = candidate
    }
  }

  const sorted: Record<string, CatalogEndpoint> = {}
  for (const id of Object.keys(endpoints).sort()) sorted[id] = endpoints[id]

  return {
    generated_from: 'docs/vendors/higgsfield/llms-full.txt',
    source_url: SOURCE_URL,
    endpoints: sorted,
  }
}

export function renderCatalog(catalog: HiggsfieldCatalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`
}

if (import.meta.main) {
  const write = process.argv.includes('--write')
  const catalog = deriveCatalog(readFileSync(SOURCE, 'utf8'))
  const rendered = renderCatalog(catalog)
  const count = Object.keys(catalog.endpoints).length
  if (write) {
    mkdirSync(dirname(CATALOG_PATH), { recursive: true })
    writeFileSync(CATALOG_PATH, rendered)
    console.log(`Wrote ${CATALOG_PATH} (${count} endpoints)`)
  } else {
    console.log(rendered)
  }
}
