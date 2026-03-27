import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AGENT_TEMPLATES, getAgentTemplateById, getTemplateSummaries, getTemplatesByCategory } from '../agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath } from '../template-loader'
import { seedWorkspaceFromTemplate } from '../workspace-defaults'

const ALL_TEMPLATE_IDS = [
  'marketing-command-center', 'devops-hub', 'project-manager', 'sales-revenue',
  'support-ops', 'research-analyst', 'hr-recruiting', 'personal-assistant',
  'operations-monitor',
  // directory-based originals
  'code-quality', 'comms-monitoring', 'engineering-pulse', 'incident-response',
  'meeting-intelligence', 'research-tracking', 'revenue-finance', 'standup-automation',
]

const WORKSPACE_FILES = ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'HEARTBEAT.md', 'USER.md', 'config.json']

let tempRoot: string

beforeAll(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'template-test-'))
})

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true })
})

describe('template loading', () => {
  test('loads all 17 templates', () => {
    expect(AGENT_TEMPLATES.length).toBe(17)
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
    expect(summaries.length).toBe(17)
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

  test('each template has all 6 workspace files', () => {
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

  test('migrated templates with canvas state have .canvas-state.json', () => {
    const withCanvas = [
      'marketing-command-center', 'devops-hub', 'project-manager', 'sales-revenue',
      'support-ops', 'research-analyst', 'hr-recruiting', 'personal-assistant',
      'operations-monitor',
    ]
    for (const id of withCanvas) {
      const path = getTemplateCanvasStatePath(id)
      expect(path).not.toBeNull()
      const data = JSON.parse(readFileSync(path!, 'utf-8'))
      expect(data.surfaces).toBeDefined()
      expect(typeof data.surfaces).toBe('object')
      expect(Object.keys(data.surfaces).length).toBeGreaterThan(0)
    }
  })

  test('canvas state surfaces have required fields', () => {
    for (const id of ALL_TEMPLATE_IDS) {
      const path = getTemplateCanvasStatePath(id)
      if (!path) continue
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      for (const [surfaceId, surface] of Object.entries(data.surfaces) as [string, any][]) {
        expect(surface.surfaceId).toBe(surfaceId)
        expect(surface.title).toBeTruthy()
        expect(typeof surface.components).toBe('object')
        expect(typeof surface.dataModel).toBe('object')
        expect(surface.createdAt).toBeTruthy()
        expect(surface.updatedAt).toBeTruthy()
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

    const identity = readFileSync(join(dir, '.shogo', 'IDENTITY.md'), 'utf-8')
    expect(identity).toContain('MyMarketer')
    expect(identity).not.toContain('{{AGENT_NAME}}')
  })

  test('copies canvas state when available', () => {
    const withCanvas = [
      'marketing-command-center', 'devops-hub', 'project-manager', 'sales-revenue',
      'support-ops', 'research-analyst', 'hr-recruiting', 'personal-assistant',
      'operations-monitor',
    ]
    for (const id of withCanvas) {
      const dir = join(tempRoot, `seed-${id}`)
      const canvasPath = join(dir, '.canvas-state.json')
      expect(existsSync(canvasPath)).toBe(true)
      const data = JSON.parse(readFileSync(canvasPath, 'utf-8'))
      expect(data.surfaces).toBeDefined()
      expect(Object.keys(data.surfaces).length).toBeGreaterThan(0)
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
