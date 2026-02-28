import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAgentTemplateById } from './agent-templates'
import { TEMPLATE_CANVAS_STATES } from './template-canvas-states'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export const DEFAULT_WORKSPACE_FILES: Record<string, string> = {
  'AGENTS.md': `# Operating Instructions

## Approach
- **Plan before you build.** For any canvas or multi-step task, first write a brief plan covering what you'll build, the data model, component layout, and test plan. Then execute.
- Use canvas tools to build interactive UIs when the user asks for dashboards, apps, or visual displays
- Use memory tools to persist important facts the user shares
- Prefer action over clarification — make reasonable assumptions and explain what you did

## Canvas Best Practices
- Always set up a CRUD API (canvas_api_schema + canvas_api_seed) when building data-driven apps
- Use mutation actions on buttons so interactions work without agent round-trips
- After building interactive UIs, verify they work using canvas_trigger_action and canvas_inspect
- Never delete and recreate a surface — use canvas_update to fix issues in place

## Priorities
1. User requests — respond promptly and take action
2. Urgent alerts — surface immediately via channels
3. Scheduled checks — run on heartbeat cadence
4. Proactive suggestions — offer when relevant context is available
`,
  'SOUL.md': `# Soul

You are a capable, proactive AI agent. You communicate clearly and get things done efficiently.
You explain what you're about to do, then do it. You prefer showing over telling.

## Tone
- Direct and helpful, not verbose
- Confident but not presumptuous
- Celebrate completions briefly, then move on

## Boundaries
- Never execute destructive commands without explicit confirmation
- Never share credentials in channel messages
- Respect quiet hours for non-urgent notifications
`,
  'IDENTITY.md': `# Identity

- **Name:** Shogo
- **Emoji:** ⚡
- **Tagline:** Your AI agent — ready to build
`,
  'USER.md': `# User

- **Name:** (not set)
- **Timezone:** UTC
`,
  'HEARTBEAT.md': '',
  'TOOLS.md': `# Tools

Notes about available tools and conventions for this agent.
`,
  'MEMORY.md': `# Memory

Long-lived facts and learnings are stored here.
`,
  'config.json': JSON.stringify(
    {
      heartbeatInterval: 1800,
      heartbeatEnabled: false,
      quietHours: { start: '23:00', end: '07:00', timezone: 'UTC' },
      channels: [],
      model: {
        provider: 'anthropic',
        name: 'claude-sonnet-4-5',
      },
    },
    null,
    2
  ),
}

/**
 * Write default workspace files into a directory, creating subdirectories as needed.
 * Only writes files that don't already exist (won't overwrite user customizations).
 */
export function seedWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    const filepath = join(dir, filename)
    if (!existsSync(filepath)) {
      writeFileSync(filepath, content, 'utf-8')
    }
  }
}

/**
 * Force-write all default workspace files (overwrites existing).
 * Used by eval runner to reset workspace between tests.
 */
export function resetWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    writeFileSync(join(dir, filename), content, 'utf-8')
  }
}

/**
 * Seed workspace from a template. Writes template-specific files and
 * copies referenced bundled skills into the workspace skills/ directory.
 * Only writes files that don't already exist (preserves customizations).
 * Also writes a .template marker file so the runtime knows which template was used.
 */
export function seedWorkspaceFromTemplate(dir: string, templateId: string, agentName?: string): boolean {
  const template = getAgentTemplateById(templateId)
  if (!template) return false

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, 'skills'), { recursive: true })

  for (const [filename, rawContent] of Object.entries(template.files)) {
    const filepath = join(dir, filename)
    if (!existsSync(filepath)) {
      const parentDir = dirname(filepath)
      if (parentDir !== dir) mkdirSync(parentDir, { recursive: true })
      const content = agentName ? rawContent.replace(/\{\{AGENT_NAME\}\}/g, agentName) : rawContent
      writeFileSync(filepath, content, 'utf-8')
    }
  }

  const bundledDir = join(__dirname, 'bundled-skills')
  if (existsSync(bundledDir)) {
    for (const skillName of template.skills) {
      const src = join(bundledDir, `${skillName}.md`)
      const dest = join(dir, 'skills', `${skillName}.md`)
      if (existsSync(src) && !existsSync(dest)) {
        copyFileSync(src, dest)
      }
    }
  }

  const canvasState = TEMPLATE_CANVAS_STATES[templateId]
  if (canvasState) {
    const canvasPath = join(dir, '.canvas-state.json')
    if (!existsSync(canvasPath)) {
      writeFileSync(canvasPath, JSON.stringify(canvasState, null, 2), 'utf-8')
    }
  }

  writeFileSync(join(dir, '.template'), templateId, 'utf-8')

  return true
}
