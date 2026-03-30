#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Canvas JSON → Code Migration
 *
 * Converts a workspace's .canvas-state.json (v1 declarative JSON surfaces)
 * into canvas/<surfaceId>.tsx + canvas/<surfaceId>.data.json (v2 code mode).
 *
 * Usage:
 *   npx tsx migrate-canvas-to-code.ts <workspace-dir>
 *   npx tsx migrate-canvas-to-code.ts --all <parent-dir>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ComponentDef {
  id: string
  component: string
  child?: string
  children?: string[] | { path: string; templateId: string }
  [key: string]: unknown
}

interface SurfaceState {
  surfaceId: string
  title?: string
  theme?: Record<string, string>
  components: Record<string, ComponentDef>
  dataModel: Record<string, unknown>
  apiModels?: Array<{ name: string; fields: Array<{ name: string; type: string }> }>
  hookDefinitions?: Record<string, unknown>
  createdAt?: string
  updatedAt?: string
}

interface CanvasState {
  surfaces: Record<string, SurfaceState>
}

export interface MigrationResult {
  surfaceCount: number
  warnings: string[]
  files: string[]
}

// ---------------------------------------------------------------------------
// Component type → JSX tag name
// ---------------------------------------------------------------------------

const TAG_MAP: Record<string, string> = {
  Row: 'Row',
  Column: 'Column',
  Grid: 'Grid',
  Card: 'CanvasCard',
  ScrollArea: 'CanvasScrollArea',
  Text: 'DynText',
  Badge: 'DynBadge',
  Image: 'DynImage',
  Icon: 'DynIcon',
  Separator: 'DynSeparator',
  Progress: 'DynProgress',
  Skeleton: 'DynSkeleton',
  Alert: 'DynAlert',
  Metric: 'Metric',
  Table: 'DynTable',
  Chart: 'DynChart',
  Tabs: 'DynTabs',
  TabPanel: 'DynTabPanel',
  Accordion: 'DynAccordion',
  AccordionItem: 'DynAccordionItem',
  Button: 'Button',
  Checkbox: 'Checkbox',
  DataList: 'DataList',
  Select: 'Select',
  TextField: 'Input',
  ChoicePicker: 'Select',
}

const STRUCTURAL_KEYS = new Set(['id', 'component', 'children', 'child'])

// ---------------------------------------------------------------------------
// Path / value helpers
// ---------------------------------------------------------------------------

function jsonPointerToJs(pointer: string, prefix: string): string {
  const segments = pointer.split('/').filter(Boolean)
  let expr = prefix
  for (const seg of segments) {
    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(seg)) {
      expr += `.${seg}`
    } else {
      expr += `[${JSON.stringify(seg)}]`
    }
  }
  return expr
}

function isPathBinding(val: unknown): val is { path: string } {
  return (
    typeof val === 'object' &&
    val !== null &&
    'path' in val &&
    typeof (val as Record<string, unknown>).path === 'string' &&
    !('api' in val) &&
    !('templateId' in val)
  )
}

function isApiBinding(val: unknown): val is { api: string } {
  return typeof val === 'object' && val !== null && 'api' in val
}

function isDataListBinding(
  children: unknown,
): children is { path: string; templateId: string } {
  return (
    typeof children === 'object' &&
    children !== null &&
    !Array.isArray(children) &&
    'path' in children &&
    'templateId' in children
  )
}

function escapeJsx(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\{/g, '&#123;')
    .replace(/\}/g, '&#125;')
}

function escapeJsString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function needsJsxEscape(s: string): boolean {
  return /[{}<>]/.test(s)
}

function indent(depth: number): string {
  return '  '.repeat(depth)
}

// ---------------------------------------------------------------------------
// Prop serialization
// ---------------------------------------------------------------------------

function serializePropValue(
  key: string,
  val: unknown,
  itemCtx: boolean,
): string {
  if (isPathBinding(val)) {
    const p = val.path
    if (p.startsWith('/')) {
      return `{${jsonPointerToJs(p, 'data')}}`
    }
    return itemCtx ? `{item.${p}}` : `{data.${p}}`
  }

  if (isApiBinding(val)) {
    const apiVal = val as { api: string; params?: unknown; refreshInterval?: number }
    return `{/* TODO: migrate API binding — use fetch("${apiVal.api}") in useEffect */}`
  }

  if (typeof val === 'string') {
    return `"${escapeJsString(val)}"`
  }
  if (typeof val === 'number') return `{${val}}`
  if (typeof val === 'boolean') return val ? '' : `{false}`

  if (Array.isArray(val) && key === 'columns') {
    const normalized = val.map((col: Record<string, unknown>) => {
      const out: Record<string, unknown> = {}
      out.key = col.key ?? col.field
      out.label = col.label ?? col.header
      if (col.align) out.align = col.align
      if (col.width) out.width = col.width
      return out
    })
    return `{${JSON.stringify(normalized)}}`
  }

  if (Array.isArray(val) || (typeof val === 'object' && val !== null)) {
    return `{${JSON.stringify(val)}}`
  }

  return `{${JSON.stringify(val)}}`
}

function buildProps(
  comp: ComponentDef,
  itemCtx: boolean,
  depth: number,
  exclude?: Set<string>,
): string {
  const parts: string[] = []
  const skip = exclude
    ? new Set([...STRUCTURAL_KEYS, ...exclude])
    : STRUCTURAL_KEYS

  for (const [key, val] of Object.entries(comp)) {
    if (skip.has(key)) continue
    if (val === undefined || val === null) continue

    if (typeof val === 'boolean' && val) {
      parts.push(key)
    } else if (typeof val === 'boolean' && !val) {
      parts.push(`${key}={false}`)
    } else {
      const ser = serializePropValue(key, val, itemCtx)
      parts.push(`${key}=${ser}`)
    }
  }

  if (parts.length === 0) return ''
  if (parts.join(' ').length <= 60) return ' ' + parts.join(' ')
  return (
    '\n' +
    parts.map((p) => indent(depth + 1) + p).join('\n') +
    '\n' +
    indent(depth)
  )
}

// ---------------------------------------------------------------------------
// JSX generation — recursive tree walk
// ---------------------------------------------------------------------------

function renderComponent(
  compId: string,
  components: Record<string, ComponentDef>,
  depth: number,
  itemCtx: boolean,
  visited: Set<string>,
): string {
  if (visited.has(compId)) {
    return `${indent(depth)}{/* circular reference: ${compId} */}`
  }
  visited.add(compId)

  const comp = components[compId]
  if (!comp) {
    return `${indent(depth)}{/* missing component: ${compId} */}`
  }

  switch (comp.component) {
    case 'DataList':
      return renderDataList(comp, components, depth, visited)
    case 'Select':
      return renderSelect(comp, depth, itemCtx)
    case 'Button':
      return renderButton(comp, depth, itemCtx)
    default:
      return renderGeneric(comp, components, depth, itemCtx, visited)
  }
}

function renderGeneric(
  comp: ComponentDef,
  components: Record<string, ComponentDef>,
  depth: number,
  itemCtx: boolean,
  visited: Set<string>,
): string {
  const tag = TAG_MAP[comp.component] || comp.component
  const props = buildProps(comp, itemCtx, depth)

  const childIds = getChildIds(comp)
  if (childIds.length === 0) {
    return `${indent(depth)}<${tag}${props} />`
  }

  const childrenJsx = childIds
    .map((id) => renderComponent(id, components, depth + 1, itemCtx, visited))
    .join('\n')

  const multilineProps = props.includes('\n')
  if (multilineProps) {
    return (
      `${indent(depth)}<${tag}${props}>\n` +
      childrenJsx +
      `\n${indent(depth)}</${tag}>`
    )
  }
  return (
    `${indent(depth)}<${tag}${props}>\n` +
    childrenJsx +
    `\n${indent(depth)}</${tag}>`
  )
}

function renderDataList(
  comp: ComponentDef,
  components: Record<string, ComponentDef>,
  depth: number,
  visited: Set<string>,
): string {
  if (!isDataListBinding(comp.children)) {
    return renderGeneric(comp, components, depth, false, visited)
  }

  const binding = comp.children
  const dataExpr = jsonPointerToJs(binding.path, 'data')
  const templateId = binding.templateId

  const where = comp.where as Record<string, unknown> | undefined
  const filterExpr = where
    ? `.filter((item) => ${Object.entries(where).map(([k, v]) => `item.${k} === ${JSON.stringify(v)}`).join(' && ')})`
    : ''

  const emptyText = comp.emptyText as string | undefined

  const templateJsx = renderComponent(
    templateId,
    components,
    depth + 3,
    true,
    new Set(visited),
  )

  const lines: string[] = []
  lines.push(`${indent(depth)}<Column>`)

  if (emptyText) {
    lines.push(
      `${indent(depth + 1)}{(!${dataExpr} || ${dataExpr}.length === 0) && (`,
    )
    lines.push(
      `${indent(depth + 2)}<DynText text="${escapeJsString(emptyText)}" variant="muted" />`,
    )
    lines.push(`${indent(depth + 1)})}`)
  }

  lines.push(
    `${indent(depth + 1)}{(${dataExpr} || [])${filterExpr}.map((item, i) => (`,
  )
  lines.push(`${indent(depth + 2)}<React.Fragment key={item.id || i}>`)
  lines.push(templateJsx)
  lines.push(`${indent(depth + 2)}</React.Fragment>`)
  lines.push(`${indent(depth + 1)}))}`)
  lines.push(`${indent(depth)}</Column>`)

  return lines.join('\n')
}

function renderSelect(
  comp: ComponentDef,
  depth: number,
  itemCtx: boolean,
): string {
  const options = (comp.options || []) as Array<{ label: string; value: string }>
  const valueProp = comp.value
  const placeholder = (comp.placeholder as string) || 'Select...'
  const label = comp.label as string | undefined

  let valueExpr: string
  if (isPathBinding(valueProp)) {
    const p = valueProp.path
    valueExpr = p.startsWith('/') ? jsonPointerToJs(p, 'data') : itemCtx ? `item.${p}` : `data.${p}`
  } else if (typeof valueProp === 'string') {
    valueExpr = `"${escapeJsString(valueProp)}"`
  } else {
    valueExpr = 'undefined'
  }

  const lines: string[] = []
  if (label) {
    lines.push(`${indent(depth)}<Column gap="xs">`)
    lines.push(`${indent(depth + 1)}<DynText text="${escapeJsString(label)}" variant="caption" />`)
    depth += 1
  }
  lines.push(`${indent(depth)}<Select value={${valueExpr}}>`)
  lines.push(`${indent(depth + 1)}<SelectTrigger>`)
  lines.push(`${indent(depth + 2)}<SelectValue placeholder="${escapeJsString(placeholder)}" />`)
  lines.push(`${indent(depth + 1)}</SelectTrigger>`)
  lines.push(`${indent(depth + 1)}<SelectContent>`)
  for (const opt of options) {
    lines.push(
      `${indent(depth + 2)}<SelectItem value="${escapeJsString(opt.value)}">${escapeJsx(opt.label)}</SelectItem>`,
    )
  }
  lines.push(`${indent(depth + 1)}</SelectContent>`)
  lines.push(`${indent(depth)}</Select>`)
  if (label) {
    lines.push(`${indent(depth - 1)}</Column>`)
  }
  return lines.join('\n')
}

function renderButton(
  comp: ComponentDef,
  depth: number,
  itemCtx: boolean,
): string {
  const label = (comp.label || comp.text || 'Button') as string
  const action = comp.action as Record<string, unknown> | undefined
  const variant = comp.variant as string | undefined
  const size = comp.size as string | undefined
  const disabled = comp.disabled as boolean | undefined

  const propParts: string[] = []
  if (variant) propParts.push(`variant="${variant}"`)
  if (size) propParts.push(`size="${size}"`)
  if (disabled) propParts.push('disabled')

  if (action) {
    const mutation = action.mutation as Record<string, unknown> | undefined
    if (mutation?.method === 'OPEN') {
      const endpoint = mutation.endpoint
      if (isPathBinding(endpoint)) {
        const p = endpoint.path
        const expr = p.startsWith('/') ? jsonPointerToJs(p, 'data') : itemCtx ? `item.${p}` : `data.${p}`
        propParts.push(`onClick={() => window.open(${expr}, "_blank")}`)
      } else if (typeof endpoint === 'string') {
        propParts.push(`onClick={() => window.open("${escapeJsString(endpoint)}", "_blank")}`)
      }
    } else if (action.sendToAgent) {
      const name = (action.name || 'action') as string
      const ctx = action.context ? `, ${JSON.stringify(action.context)}` : ''
      propParts.push(`onClick={() => onAction("${escapeJsString(name)}"${ctx})}`)
    } else if (mutation) {
      propParts.push(`onClick={() => { /* TODO: migrate mutation ${JSON.stringify(mutation)} */ }}`)
    }
  }

  if (comp.deleteAction) {
    propParts.push('onClick={() => { /* TODO: migrate delete action */ }}')
    if (!variant) propParts.unshift('variant="destructive"')
  }

  const propsStr = propParts.length ? ' ' + propParts.join(' ') : ''
  if (needsJsxEscape(label)) {
    return `${indent(depth)}<Button${propsStr}>{"${escapeJsString(label)}"}</Button>`
  }
  return `${indent(depth)}<Button${propsStr}>${escapeJsx(label)}</Button>`
}

// ---------------------------------------------------------------------------
// Child resolution
// ---------------------------------------------------------------------------

function getChildIds(comp: ComponentDef): string[] {
  if (typeof comp.child === 'string') return [comp.child]
  if (Array.isArray(comp.children)) return comp.children
  return []
}

// ---------------------------------------------------------------------------
// Surface → .tsx code
// ---------------------------------------------------------------------------

function generateSurfaceCode(surface: SurfaceState): string {
  const root = surface.components.root
  if (!root) return ''

  const jsxBody = renderComponent(
    'root',
    surface.components,
    1,
    false,
    new Set(),
  )

  const headerLines: string[] = []
  if (surface.title) {
    headerLines.push(`// ${surface.title}`)
  }
  if (surface.apiModels?.length) {
    headerLines.push(
      '// NOTE: This surface had managed API models (apiModels) in JSON mode.',
    )
    headerLines.push(
      '// Use fetch() with a skill server or external API to restore data operations.',
    )
  }
  if (surface.hookDefinitions && Object.keys(surface.hookDefinitions).length > 0) {
    headerLines.push(
      '// NOTE: This surface had hookDefinitions which are not supported in code mode.',
    )
  }

  const header = headerLines.length ? headerLines.join('\n') + '\n\n' : ''

  return `${header}return (\n${jsxBody}\n)\n`
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function migrateCanvasToCode(workspaceDir: string): MigrationResult {
  const warnings: string[] = []
  const files: string[] = []
  const absDir = resolve(workspaceDir)

  const canvasStatePath = join(absDir, '.canvas-state.json')
  if (!existsSync(canvasStatePath)) {
    throw new Error(`No .canvas-state.json found in ${absDir}`)
  }

  const raw = readFileSync(canvasStatePath, 'utf-8')
  let state: CanvasState
  try {
    state = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in ${canvasStatePath}`)
  }

  if (!state.surfaces || Object.keys(state.surfaces).length === 0) {
    throw new Error('No surfaces found in .canvas-state.json')
  }

  const canvasDir = join(absDir, 'canvas')
  if (existsSync(canvasDir)) {
    const existing = readdirSync(canvasDir)
    if (existing.length > 0) {
      warnings.push(
        `canvas/ directory already has ${existing.length} file(s) — they may be overwritten`,
      )
    }
  }
  mkdirSync(canvasDir, { recursive: true })

  let surfaceCount = 0

  for (const [surfaceId, surface] of Object.entries(state.surfaces)) {
    if (!surface.components?.root) {
      warnings.push(`Surface "${surfaceId}" has no root component — skipped`)
      continue
    }

    if (surface.apiModels?.length) {
      warnings.push(
        `Surface "${surfaceId}" has apiModels — managed API runtime cannot be auto-migrated. ` +
        'Data has been embedded in .data.json; restore live data with fetch().',
      )
    }

    if (surface.hookDefinitions && Object.keys(surface.hookDefinitions).length > 0) {
      warnings.push(
        `Surface "${surfaceId}" has hookDefinitions — not supported in code mode`,
      )
    }

    const code = generateSurfaceCode(surface)
    const codePath = join(canvasDir, `${surfaceId}.tsx`)
    writeFileSync(codePath, code)
    files.push(codePath)

    if (surface.dataModel && Object.keys(surface.dataModel).length > 0) {
      const dataPath = join(canvasDir, `${surfaceId}.data.json`)
      writeFileSync(dataPath, JSON.stringify(surface.dataModel, null, 2) + '\n')
      files.push(dataPath)
    }

    surfaceCount++
  }

  const configPath = join(absDir, 'config.json')
  const shogoConfigPath = join(absDir, '.shogo', 'config.json')
  let configUpdated = false

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'))
      config.canvasMode = 'code'
      writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
      files.push(configPath)
      configUpdated = true
    } catch {
      warnings.push('Failed to parse config.json — canvasMode not updated')
    }
  }

  if (existsSync(shogoConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(shogoConfigPath, 'utf-8'))
      config.canvasMode = 'code'
      writeFileSync(shogoConfigPath, JSON.stringify(config, null, 2) + '\n')
      files.push(shogoConfigPath)
      configUpdated = true
    } catch {
      warnings.push('Failed to parse .shogo/config.json — canvasMode not updated')
    }
  }

  if (!configUpdated) {
    warnings.push('No config.json found — canvasMode not updated')
  }

  return { surfaceCount, warnings, files }
}

/**
 * Migrate all workspaces under a parent directory that have a .canvas-state.json
 * and whose config.json (if present) has canvasMode !== 'code'.
 */
export function migrateAll(parentDir: string): void {
  const absDir = resolve(parentDir)
  const entries = readdirSync(absDir, { withFileTypes: true })
  let total = 0
  let migrated = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const wsDir = join(absDir, entry.name)
    const statePath = join(wsDir, '.canvas-state.json')
    if (!existsSync(statePath)) continue

    total++

    const configPaths = [join(wsDir, 'config.json'), join(wsDir, '.shogo', 'config.json')]
    const alreadyCode = configPaths.some(cp => {
      if (!existsSync(cp)) return false
      try {
        return JSON.parse(readFileSync(cp, 'utf-8')).canvasMode === 'code'
      } catch { return false }
    })
    if (alreadyCode) {
      console.log(`  skip  ${entry.name} (already code mode)`)
      continue
    }

    try {
      const result = migrateCanvasToCode(wsDir)
      migrated++
      console.log(`  done  ${entry.name}  (${result.surfaceCount} surface${result.surfaceCount !== 1 ? 's' : ''})`)
      for (const w of result.warnings) {
        console.log(`        warning: ${w}`)
      }
    } catch (err) {
      console.error(`  FAIL  ${entry.name}: ${(err as Error).message}`)
    }
  }

  console.log(`\n${migrated}/${total} workspace(s) migrated`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isCli =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  process.argv[1].replace(/\\/g, '/').includes('migrate-canvas-to-code')

if (isCli) {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.length === 0) {
    console.log(`Canvas JSON → Code Migration

Usage:
  npx tsx migrate-canvas-to-code.ts <workspace-dir>
  npx tsx migrate-canvas-to-code.ts --all <parent-dir>

Options:
  <workspace-dir>   Path to a single workspace directory
  --all <dir>       Migrate all workspaces under the given directory
  --help            Show this help message

Examples:
  npx tsx migrate-canvas-to-code.ts ./workspaces/6fccc9d2-...
  npx tsx migrate-canvas-to-code.ts --all ./workspaces
  npx tsx migrate-canvas-to-code.ts --all ./packages/agent-runtime/templates`)
    process.exit(0)
  }

  const batchMode = args.includes('--all')
  const dir = args.find((a) => !a.startsWith('--'))

  if (!dir) {
    console.error('Error: no directory specified')
    process.exit(1)
  }

  if (!existsSync(dir)) {
    console.error(`Error: directory does not exist: ${dir}`)
    process.exit(1)
  }

  if (batchMode) {
    console.log(`Migrating all workspaces in ${resolve(dir)} ...\n`)
    migrateAll(dir)
  } else {
    try {
      const result = migrateCanvasToCode(dir)
      console.log(`Migrated ${result.surfaceCount} surface(s)`)
      console.log(`Files written:`)
      for (const f of result.files) console.log(`  ${f}`)
      for (const w of result.warnings) console.log(`Warning: ${w}`)
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`)
      process.exit(1)
    }
  }
}
