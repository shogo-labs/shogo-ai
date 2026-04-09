/**
 * Converts canvas v2 templates (JSX fragments + data.json) into proper
 * React components that work in the Vite + shadcn runtime template.
 *
 * Usage: bun run scripts/convert-canvas-v2.ts
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES_BASE = join(__dirname, '..', 'templates')

const CANVAS_TEMPLATES = [
  'devops-hub',
  'hr-recruiting',
  'marketing-command-center',
  'operations-monitor',
  'personal-assistant',
  'project-manager',
  'research-analyst',
  'sales-revenue',
  'support-ops',
]

const GAP_MAP: Record<string, string> = { sm: '2', md: '4', lg: '6' }

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
}

interface SurfaceInfo {
  id: string
  title: string
  componentName: string
}

function getSurfaceInfo(templateId: string): SurfaceInfo[] {
  const stateFile = join(TEMPLATES_BASE, templateId, '.canvas-state.json')
  if (!existsSync(stateFile)) return []
  const state = JSON.parse(readFileSync(stateFile, 'utf-8'))
  return Object.keys(state.surfaces).map((id) => ({
    id,
    title: state.surfaces[id].title,
    componentName: snakeToPascal(id),
  }))
}

// ---------------------------------------------------------------------------
// JSX Normalization & Transformation
// ---------------------------------------------------------------------------

/**
 * Collapse multi-line component tags (uppercase names) into single lines
 * so downstream regex can match attributes reliably.
 */
function normalizeMultiLineTags(content: string): string {
  const lines = content.split('\n')
  const result: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (
      /^<[A-Z]\w*/.test(trimmed) &&
      !trimmed.endsWith('>') &&
      !trimmed.endsWith('/>')
    ) {
      const indent = (line.match(/^(\s*)/) || ['', ''])[1]
      let collected = trimmed
      i++
      while (i < lines.length) {
        const next = lines[i].trim()
        collected += ' ' + next
        i++
        if (next.endsWith('>') || next.endsWith('/>')) break
      }
      // Clean up any trailing space before > that the join introduced
      collected = collected.replace(/\s+>/g, '>').replace(/\s+\/>/g, ' />')
      result.push(indent + collected)
    } else {
      result.push(line)
      i++
    }
  }

  return result.join('\n')
}

function transformCanvasJsx(raw: string): string {
  // Strip leading comment and return() wrapper
  let jsx = raw.replace(/^\/\/.*\n\n?/, '')
  jsx = jsx.replace(/^\s*return\s*\(\s*\n?/, '')
  jsx = jsx.replace(/\n?\s*\)\s*$/, '')

  jsx = normalizeMultiLineTags(jsx)

  // --- Opening tags ---

  jsx = jsx.replace(
    /<Column\s+gap="(\w+)">/g,
    (_, gap) => `<div className="flex flex-col gap-${GAP_MAP[gap] || '4'}">`,
  )

  jsx = jsx.replace(/<Row\s+([^>]+)>/g, (_, attrs: string) => {
    const cls = ['flex']
    if (attrs.includes('align="center"')) cls.push('items-center')
    if (attrs.includes('justify="between"')) cls.push('justify-between')
    const gm = attrs.match(/gap="(\w+)"/)
    if (gm) cls.push(`gap-${GAP_MAP[gm[1]] || '4'}`)
    return `<div className="${cls.join(' ')}">`
  })

  jsx = jsx.replace(/<Grid\s+([^>]+)>/g, (_, attrs: string) => {
    const cm = attrs.match(/columns=\{(\d+)\}/)
    const cols = cm ? cm[1] : '3'
    const gm = attrs.match(/gap="(\w+)"/)
    const gap = gm ? GAP_MAP[gm[1]] || '4' : '4'
    return `<div className="grid grid-cols-${cols} gap-${gap}">`
  })

  // CanvasCard with title + description (must come before title-only)
  jsx = jsx.replace(
    /^(\s*)<CanvasCard\s+title="([^"]+)"\s+description="([^"]+)">/gm,
    (_, indent, title, desc) =>
      [
        `${indent}<Card>`,
        `${indent}  <CardHeader>`,
        `${indent}    <CardTitle>${title}</CardTitle>`,
        `${indent}    <CardDescription>${desc}</CardDescription>`,
        `${indent}  </CardHeader>`,
        `${indent}  <CardContent>`,
      ].join('\n'),
  )

  // CanvasCard with title only
  jsx = jsx.replace(
    /^(\s*)<CanvasCard\s+title="([^"]+)">/gm,
    (_, indent, title) =>
      [
        `${indent}<Card>`,
        `${indent}  <CardHeader>`,
        `${indent}    <CardTitle>${title}</CardTitle>`,
        `${indent}  </CardHeader>`,
        `${indent}  <CardContent>`,
      ].join('\n'),
  )

  // --- Closing tags ---

  jsx = jsx.replace(/<\/Column>/g, '</div>')
  jsx = jsx.replace(/<\/Row>/g, '</div>')
  jsx = jsx.replace(/<\/Grid>/g, '</div>')
  jsx = jsx.replace(
    /^(\s*)<\/CanvasCard>/gm,
    (_, indent) => `${indent}  </CardContent>\n${indent}</Card>`,
  )

  // --- Self-closing tags ---

  // Metric → MetricCard (rename tag, preserve all attributes)
  jsx = jsx.replace(/<Metric\s+/g, '<MetricCard ')

  // DynText variant="h2"
  jsx = jsx.replace(
    /<DynText\s+text="([^"]*)"\s+variant="h2"\s*\/>/g,
    (_, t) => `<h2 className="text-2xl font-semibold tracking-tight">${t}</h2>`,
  )

  // DynText variant="muted" — string text
  jsx = jsx.replace(
    /<DynText\s+text="([^"]*)"\s+variant="muted"\s*\/>/g,
    (_, t) => `<p className="text-sm text-muted-foreground">${t}</p>`,
  )

  // DynText variant="muted" — expression text
  jsx = jsx.replace(
    /<DynText\s+text=\{([^}]+)\}\s+variant="muted"\s*\/>/g,
    (_, e) => `<p className="text-sm text-muted-foreground">{${e}}</p>`,
  )

  // DynText no variant — string text
  jsx = jsx.replace(
    /<DynText\s+text="([^"]*)"\s*\/>/g,
    (_, t) => `<p>${t}</p>`,
  )

  // DynText no variant — expression text
  jsx = jsx.replace(
    /<DynText\s+text=\{([^}]+)\}\s*\/>/g,
    (_, e) => `<p>{${e}}</p>`,
  )

  // DynBadge
  jsx = jsx.replace(
    /<DynBadge\s+text="([^"]*)"\s+variant="(\w+)"\s*\/>/g,
    (_, t, v) => `<Badge variant="${v}">${t}</Badge>`,
  )

  return jsx
}

// ---------------------------------------------------------------------------
// Code Generation
// ---------------------------------------------------------------------------

function reindent(jsx: string, baseIndent: number): string {
  const lines = jsx.split('\n')
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length === 0) return ''
  const minIndent = Math.min(
    ...nonEmpty.map((l) => (l.match(/^(\s*)/) || ['', ''])[1].length),
  )
  return lines
    .map((l) => {
      if (l.trim().length === 0) return ''
      return ' '.repeat(baseIndent) + l.slice(minIndent)
    })
    .join('\n')
}

function buildImports(jsx: string, componentName: string): string {
  const lines: string[] = ["import { useState } from 'react'"]

  if (jsx.includes('<Card')) {
    const parts = ['Card', 'CardContent', 'CardHeader', 'CardTitle']
    if (jsx.includes('CardDescription')) parts.push('CardDescription')
    lines.push(
      `import { ${parts.join(', ')} } from '@/components/ui/card'`,
    )
  }

  if (jsx.includes('<Badge')) {
    lines.push("import { Badge } from '@/components/ui/badge'")
  }

  if (jsx.includes('<MetricCard')) {
    lines.push("import { MetricCard } from '@/components/MetricCard'")
  }

  lines.push(`import initialData from './${componentName}.data.json'`)

  return lines.join('\n')
}

function generateSurfaceComponent(
  componentName: string,
  rawJsx: string,
): string {
  const transformed = transformCanvasJsx(rawJsx)
  const body = reindent(transformed, 4)
  const imports = buildImports(transformed, componentName)

  return `${imports}

export default function ${componentName}() {
  const [data] = useState(initialData)

  return (
${body}
  )
}
`
}

function generateAppTsx(surfaces: SurfaceInfo[]): string {
  if (surfaces.length === 1) {
    const s = surfaces[0]
    return `import ${s.componentName} from './surfaces/${s.componentName}'

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <${s.componentName} />
    </div>
  )
}
`
  }

  const tabImport =
    "import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'"
  const surfaceImports = surfaces
    .map((s) => `import ${s.componentName} from './surfaces/${s.componentName}'`)
    .join('\n')

  const triggers = surfaces
    .map(
      (s) =>
        `          <TabsTrigger value="${s.id}">${s.title}</TabsTrigger>`,
    )
    .join('\n')

  const contents = surfaces
    .map(
      (s) =>
        `        <TabsContent value="${s.id}"><${s.componentName} /></TabsContent>`,
    )
    .join('\n')

  return `${tabImport}
${surfaceImports}

export default function App() {
  return (
    <div className="min-h-screen bg-background p-6">
      <Tabs defaultValue="${surfaces[0].id}">
        <TabsList>
${triggers}
        </TabsList>
${contents}
      </Tabs>
    </div>
  )
}
`
}

const METRIC_CARD_COMPONENT = `import { Card, CardContent } from '@/components/ui/card'

interface MetricCardProps {
  label: string
  value: string | number
  unit?: string
}

export function MetricCard({ label, value, unit }: MetricCardProps) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold">
          {unit === '$' && '$'}{value}{unit && unit !== '$' && \` \${unit}\`}
        </p>
      </CardContent>
    </Card>
  )
}
`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let totalSurfaces = 0

for (const templateId of CANVAS_TEMPLATES) {
  const templateDir = join(TEMPLATES_BASE, templateId)
  const canvasDir = join(templateDir, 'canvas')
  const srcDir = join(templateDir, 'src')
  const surfacesDir = join(srcDir, 'surfaces')
  const componentsDir = join(srcDir, 'components')

  if (!existsSync(canvasDir)) {
    console.log(`  skip ${templateId}: no canvas/ directory`)
    continue
  }

  const surfaces = getSurfaceInfo(templateId)
  if (surfaces.length === 0) {
    console.log(`  skip ${templateId}: no surfaces in .canvas-state.json`)
    continue
  }

  mkdirSync(surfacesDir, { recursive: true })
  mkdirSync(componentsDir, { recursive: true })

  for (const surface of surfaces) {
    const tsxPath = join(canvasDir, `${surface.id}.tsx`)
    const dataPath = join(canvasDir, `${surface.id}.data.json`)

    if (!existsSync(tsxPath)) {
      console.log(`  skip ${templateId}/${surface.id}: tsx not found`)
      continue
    }

    const rawJsx = readFileSync(tsxPath, 'utf-8')
    const component = generateSurfaceComponent(surface.componentName, rawJsx)
    writeFileSync(join(surfacesDir, `${surface.componentName}.tsx`), component)

    if (existsSync(dataPath)) {
      const data = readFileSync(dataPath, 'utf-8')
      writeFileSync(
        join(surfacesDir, `${surface.componentName}.data.json`),
        data,
      )
    }

    totalSurfaces++
  }

  writeFileSync(join(srcDir, 'App.tsx'), generateAppTsx(surfaces))
  writeFileSync(join(componentsDir, 'MetricCard.tsx'), METRIC_CARD_COMPONENT)

  console.log(`  done ${templateId}: ${surfaces.length} surface(s)`)
}

console.log(
  `\nConverted ${totalSurfaces} surfaces across ${CANVAS_TEMPLATES.length} templates.`,
)
