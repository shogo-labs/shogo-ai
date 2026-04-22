import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_TEMPLATES, getAgentTemplateById, getTemplateSummaries, getTemplatesByCategory } from '../agent-templates'
import { getTemplateShogoDir, getTemplateSrcDir, getTemplatePrismaDir } from '../template-loader'
import { seedWorkspaceFromTemplate } from '../workspace-defaults'

const ALL_TEMPLATE_IDS = [
  'marketing-command-center', 'devops-hub', 'project-manager', 'sales-revenue',
  'support-ops', 'research-analyst', 'hr-recruiting', 'personal-assistant',
  'operations-monitor',
  // directory-based originals
  'code-quality', 'comms-monitoring', 'engineering-pulse', 'incident-response',
  'meeting-intelligence', 'research-tracking', 'revenue-finance', 'standup-automation',
  'self-evolving', 'yc-founder-operating-system',
]

const EXPECTED_TEMPLATE_COUNT = ALL_TEMPLATE_IDS.length
const WORKSPACE_FILES = ['AGENTS.md', 'HEARTBEAT.md', 'config.json']

// Subset of templates that ship with a canvas `src/` directory (generated React surfaces)
// whose data is represented by per-surface `.data.json` files inside src/surfaces/.
// Newer templates (see TEMPLATES_WITH_PRISMA_SCHEMA) instead persist through an
// auto-generated Prisma/Hono CRUD server and do not ship `.data.json` files.
const TEMPLATES_WITH_CANVAS_SRC = [
  'marketing-command-center', 'devops-hub', 'project-manager', 'sales-revenue',
  'support-ops', 'research-analyst', 'hr-recruiting', 'personal-assistant',
  'operations-monitor',
]

// Templates that ship a real `prisma/schema.prisma` and a `src/` whose surfaces
// fetch from the auto-generated `/api/*` CRUD routes (no `.data.json` mocks).
const TEMPLATES_WITH_PRISMA_SCHEMA = [
  'yc-founder-operating-system',
]

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'template-test-'))
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('template loading', () => {
  test(`loads all ${EXPECTED_TEMPLATE_COUNT} templates`, () => {
    expect(AGENT_TEMPLATES.length).toBe(EXPECTED_TEMPLATE_COUNT)
  })

  test('every expected template ID is present', () => {
    const ids = new Set(AGENT_TEMPLATES.map(t => t.id))
    for (const id of ALL_TEMPLATE_IDS) {
      expect(ids.has(id)).toBe(true)
    }
  })

  test('getAgentTemplateById returns correct templates', () => {
    for (const id of ALL_TEMPLATE_IDS) {
      const t = getAgentTemplateById(id)
      expect(t).toBeDefined()
      expect(t!.id).toBe(id)
    }
  })

  test('getAgentTemplateById returns undefined for unknown', () => {
    expect(getAgentTemplateById('nonexistent')).toBeUndefined()
  })

  test('getTemplateSummaries omits files field', () => {
    const summaries = getTemplateSummaries()
    expect(summaries.length).toBe(EXPECTED_TEMPLATE_COUNT)
    for (const s of summaries) {
      expect(s).not.toHaveProperty('files')
      expect(s.id).toBeTruthy()
      expect(s.name).toBeTruthy()
      expect(s.description).toBeTruthy()
      expect(s.category).toBeTruthy()
      expect(s.icon).toBeTruthy()
    }
  })

  test('getTemplatesByCategory returns non-empty for known categories', () => {
    const categories = ['personal', 'development', 'operations', 'marketing', 'sales', 'research', 'business'] as const
    for (const cat of categories) {
      const templates = getTemplatesByCategory(cat)
      expect(templates.length).toBeGreaterThan(0)
    }
  })

  test('each template has required fields', () => {
    for (const t of AGENT_TEMPLATES) {
      expect(t.id).toBeTruthy()
      expect(t.name).toBeTruthy()
      expect(t.description).toBeTruthy()
      expect(t.category).toBeTruthy()
      expect(t.icon).toBeTruthy()
      expect(Array.isArray(t.tags)).toBe(true)
      expect(t.settings).toBeDefined()
      expect(t.settings.heartbeatInterval).toBeGreaterThan(0)
      expect(typeof t.settings.heartbeatEnabled).toBe('boolean')
      expect(t.settings.modelProvider).toBeTruthy()
      expect(t.settings.modelName).toBeTruthy()
      expect(Array.isArray(t.skills)).toBe(true)
      expect(typeof t.files).toBe('object')
    }
  })

  test('each template has the required workspace files', () => {
    for (const t of AGENT_TEMPLATES) {
      for (const fname of WORKSPACE_FILES) {
        expect(t.files[fname]).toBeDefined()
        expect(t.files[fname].length).toBeGreaterThan(0)
      }
    }
  })
})

describe('template directory structure', () => {
  test('every template has a .shogo directory', () => {
    for (const id of ALL_TEMPLATE_IDS) {
      const dir = getTemplateShogoDir(id)
      expect(dir).not.toBeNull()
      expect(existsSync(dir!)).toBe(true)
    }
  })

  test('canvas-enabled templates ship a src/surfaces directory with .tsx + .data.json files', () => {
    for (const id of TEMPLATES_WITH_CANVAS_SRC) {
      const srcDir = getTemplateSrcDir(id)
      expect(srcDir).not.toBeNull()
      expect(existsSync(srcDir!)).toBe(true)

      const surfacesDir = join(srcDir!, 'surfaces')
      expect(existsSync(surfacesDir)).toBe(true)

      const files = readdirSync(surfacesDir)
      const tsxFiles = files.filter(f => f.endsWith('.tsx'))
      const dataFiles = files.filter(f => f.endsWith('.data.json'))
      expect(tsxFiles.length).toBeGreaterThan(0)
      expect(dataFiles.length).toBeGreaterThan(0)
    }
  })

  test('canvas-enabled templates have canvasMode: code in .shogo/config.json', () => {
    for (const id of TEMPLATES_WITH_CANVAS_SRC) {
      const shogoDir = getTemplateShogoDir(id)
      expect(shogoDir).not.toBeNull()
      const config = JSON.parse(readFileSync(join(shogoDir!, 'config.json'), 'utf-8'))
      expect(config.canvasMode).toBe('code')
    }
  })

  test('each per-surface .data.json is valid JSON', () => {
    for (const id of TEMPLATES_WITH_CANVAS_SRC) {
      const srcDir = getTemplateSrcDir(id)!
      const surfacesDir = join(srcDir, 'surfaces')
      const files = readdirSync(surfacesDir).filter(f => f.endsWith('.data.json'))
      expect(files.length).toBeGreaterThan(0)
      for (const file of files) {
        // Data shapes are freeform (driven by the surface's component tree), so
        // we only assert each payload is valid JSON and non-empty.
        const raw = readFileSync(join(surfacesDir, file), 'utf-8')
        expect(raw.length).toBeGreaterThan(0)
        const data = JSON.parse(raw)
        expect(data).toBeDefined()
      }
    }
  })

  test('schema-backed templates ship a prisma/schema.prisma and no .data.json mocks', () => {
    for (const id of TEMPLATES_WITH_PRISMA_SCHEMA) {
      const prismaDir = getTemplatePrismaDir(id)
      expect(prismaDir).not.toBeNull()
      const schemaPath = join(prismaDir!, 'schema.prisma')
      expect(existsSync(schemaPath)).toBe(true)
      const schema = readFileSync(schemaPath, 'utf-8')
      expect(schema).toContain('generator client')
      expect(schema).toContain('datasource db')
      expect(schema).toContain('provider = "sqlite"')
      // The feedback explicitly says no `.data.json` mocks — enforce it.
      const surfacesDir = join(getTemplateSrcDir(id)!, 'surfaces')
      const dataFiles = readdirSync(surfacesDir).filter(f => f.endsWith('.data.json'))
      expect(dataFiles).toEqual([])

      const migrationsRoot = join(prismaDir!, 'migrations')
      expect(existsSync(migrationsRoot)).toBe(true)
      expect(existsSync(join(migrationsRoot, 'migration_lock.toml'))).toBe(true)
      const migrationDirs = readdirSync(migrationsRoot, { withFileTypes: true })
        .filter(e => e.isDirectory())
      expect(migrationDirs.length).toBeGreaterThan(0)
      for (const d of migrationDirs) {
        const sqlPath = join(migrationsRoot, d.name, 'migration.sql')
        expect(existsSync(sqlPath)).toBe(true)
        expect(readFileSync(sqlPath, 'utf-8').length).toBeGreaterThan(0)
      }
    }
  })
})

describe('workspace seeding', () => {
  test('seeds workspace for each template', () => {
    for (const id of ALL_TEMPLATE_IDS) {
      const dir = join(tempRoot, `seed-${id}`)
      const result = seedWorkspaceFromTemplate(dir, id, 'TestAgent')
      expect(result).toBe(true)

      // .template marker
      expect(existsSync(join(dir, '.template'))).toBe(true)
      expect(readFileSync(join(dir, '.template'), 'utf-8')).toBe(id)

      // .shogo/ directory with workspace files
      const shogo = join(dir, '.shogo')
      expect(existsSync(shogo)).toBe(true)
      for (const fname of WORKSPACE_FILES) {
        const fp = join(shogo, fname)
        expect(existsSync(fp)).toBe(true)
        expect(readFileSync(fp, 'utf-8').length).toBeGreaterThan(0)
      }
    }
  })

  test('applies {{AGENT_NAME}} replacement', () => {
    const dir = join(tempRoot, 'seed-name-replace')
    seedWorkspaceFromTemplate(dir, 'marketing-command-center', 'MyMarketer')

    const agents = readFileSync(join(dir, '.shogo', 'AGENTS.md'), 'utf-8')
    expect(agents).toContain('MyMarketer')
    expect(agents).not.toContain('{{AGENT_NAME}}')
  })

  test('copies canvas src/ directory when available', () => {
    // The legacy `.canvas-state.json` + `canvas/` pair was replaced by a single
    // `src/` directory that contains both React surface components and
    // per-surface `.data.json` files.
    for (const id of TEMPLATES_WITH_CANVAS_SRC) {
      const dir = join(tempRoot, `seed-${id}`)
      const srcDir = join(dir, 'src')
      expect(existsSync(srcDir)).toBe(true)

      const surfacesDir = join(srcDir, 'surfaces')
      expect(existsSync(surfacesDir)).toBe(true)

      const files = readdirSync(surfacesDir)
      const tsxFiles = files.filter(f => f.endsWith('.tsx'))
      const dataFiles = files.filter(f => f.endsWith('.data.json'))
      expect(tsxFiles.length).toBeGreaterThan(0)
      expect(dataFiles.length).toBeGreaterThan(0)
    }
  })

  test('copies prisma/ directory for schema-backed templates', () => {
    for (const id of TEMPLATES_WITH_PRISMA_SCHEMA) {
      const dir = join(tempRoot, `seed-${id}`)
      const schemaPath = join(dir, 'prisma', 'schema.prisma')
      expect(existsSync(schemaPath)).toBe(true)
      const schema = readFileSync(schemaPath, 'utf-8')
      // Sanity-check a couple of the expected models are present.
      expect(schema).toContain('model Decision')
      expect(schema).toContain('model Review')
      expect(schema).toContain('model Priority')

      const migRoot = join(dir, 'prisma', 'migrations')
      expect(existsSync(join(migRoot, 'migration_lock.toml'))).toBe(true)
      const migDirs = readdirSync(migRoot, { withFileTypes: true }).filter(e => e.isDirectory())
      expect(migDirs.length).toBeGreaterThan(0)
      expect(migDirs.some(d => existsSync(join(migRoot, d.name, 'migration.sql')))).toBe(true)
    }
  })

  test('copies skills into .shogo/skills/', () => {
    const templates = [
      { id: 'marketing-command-center', skills: ['research-deep', 'topic-tracker'] },
      { id: 'devops-hub', skills: ['github-ops', 'pr-review', 'commit-insights', 'dev-activity-track', 'standup-auto-generate', 'standup-collect'] },
      { id: 'support-ops', skills: ['ticket-triage', 'incident-triage', 'escalation-alert', 'email-monitor', 'slack-forward'] },
    ]
    for (const { id, skills } of templates) {
      const dir = join(tempRoot, `seed-${id}`)
      const skillsDir = join(dir, '.shogo', 'skills')
      expect(existsSync(skillsDir)).toBe(true)
      for (const skill of skills) {
        const skillMd = join(skillsDir, skill, 'SKILL.md')
        expect(existsSync(skillMd)).toBe(true)
        expect(readFileSync(skillMd, 'utf-8').length).toBeGreaterThan(0)
      }
    }
  })

  test('returns false for unknown template', () => {
    const dir = join(tempRoot, 'seed-unknown')
    expect(seedWorkspaceFromTemplate(dir, 'nonexistent')).toBe(false)
  })

  test('config.json is valid JSON', () => {
    for (const id of ALL_TEMPLATE_IDS) {
      const dir = join(tempRoot, `seed-${id}`)
      const config = readFileSync(join(dir, '.shogo', 'config.json'), 'utf-8')
      const parsed = JSON.parse(config)
      expect(parsed.heartbeatInterval).toBeDefined()
      expect(parsed.model).toBeDefined()
    }
  })
})
