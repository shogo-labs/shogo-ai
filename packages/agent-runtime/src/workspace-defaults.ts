// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentTemplateById } from './agent-templates'
import { getTemplateShogoDir, getTemplateCanvasStatePath } from './template-loader'

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
      activeMode: 'canvas',
      canvasMode: 'code',
      model: {
        provider: 'anthropic',
        name: 'claude-sonnet-4-6',
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
/**
 * Resolve a canonical workspace config/markdown file path.
 * Root is preferred (existing behavior); `.shogo/` is used when the workspace was
 * seeded from a template (see `seedWorkspaceFromTemplate`), which only copies into `.shogo/`.
 */
export function resolveWorkspaceConfigFilePath(dir: string, filename: string): string | null {
  const rootPath = join(dir, filename)
  if (existsSync(rootPath)) return rootPath
  const shogoPath = join(dir, '.shogo', filename)
  if (existsSync(shogoPath)) return shogoPath
  return null
}

export function seedWorkspaceDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })
  mkdirSync(join(dir, '.shogo', 'plans'), { recursive: true })

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
  mkdirSync(join(dir, '.shogo', 'skills'), { recursive: true })

  for (const [filename, content] of Object.entries(DEFAULT_WORKSPACE_FILES)) {
    writeFileSync(join(dir, filename), content, 'utf-8')
  }
}

/**
 * Seed workspace from a template. Copies the template's .shogo/ directory
 * and .canvas-state.json into the workspace.
 * Only writes files that don't already exist (preserves customizations).
 * Also writes a .template marker file so the runtime knows which template was used.
 */
export function seedWorkspaceFromTemplate(dir: string, templateId: string, agentName?: string): boolean {
  const template = getAgentTemplateById(templateId)
  if (!template) return false

  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, 'memory'), { recursive: true })

  const shogoSrc = getTemplateShogoDir(templateId)
  if (shogoSrc) {
    const destShogo = join(dir, '.shogo')
    if (!existsSync(destShogo)) {
      cpSync(shogoSrc, destShogo, { recursive: true })
      if (agentName) {
        for (const fname of ['IDENTITY.md', 'SOUL.md', 'AGENTS.md', 'USER.md']) {
          const fp = join(destShogo, fname)
          if (existsSync(fp)) {
            const content = readFileSync(fp, 'utf-8')
            if (content.includes('{{AGENT_NAME}}')) {
              writeFileSync(fp, content.replace(/\{\{AGENT_NAME\}\}/g, agentName), 'utf-8')
            }
          }
        }
      }
    }
  }

  const canvasSrc = getTemplateCanvasStatePath(templateId)
  if (canvasSrc) {
    const canvasDest = join(dir, '.canvas-state.json')
    if (!existsSync(canvasDest)) {
      cpSync(canvasSrc, canvasDest)
    }
  }

  writeFileSync(join(dir, '.template'), templateId, 'utf-8')
  return true
}

// ---------------------------------------------------------------------------
// Skill Server Seed
// ---------------------------------------------------------------------------

const SKILL_SERVER_SCHEMA = `datasource db {
  provider = "sqlite"
}

generator client {
  provider = "prisma-client"
  output   = "./generated/prisma"
}

// Add your models below. Each model gets CRUD routes at /api/{model-name-plural}.
// The skill server auto-regenerates when you save this file.
`

const SKILL_SERVER_PRISMA_CONFIG = `import { defineConfig } from 'prisma/config'

export default defineConfig({
  schema: './schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:./skill.db',
  },
})
`

const SKILL_SERVER_CONFIG = JSON.stringify(
  {
    schema: './schema.prisma',
    outputs: [
      {
        dir: './generated',
        generate: ['routes', 'hooks', 'types'],
      },
      {
        dir: '.',
        generate: ['server'],
        serverConfig: {
          routesPath: './generated',
          dbPath: './db',
          port: 4100,
          skipStatic: true,
        },
      },
      {
        dir: '.',
        generate: ['db'],
        dbProvider: 'sqlite',
      },
    ],
  },
  null,
  2,
)

/**
 * Seed the skill server skeleton in .shogo/server/.
 * Creates schema.prisma, shogo.config.json, and necessary directories.
 * Only writes files that don't already exist.
 */
export function seedSkillServer(workspaceDir: string): { created: boolean; serverDir: string } {
  const serverDir = join(workspaceDir, '.shogo', 'server')
  const schemaPath = join(serverDir, 'schema.prisma')

  if (existsSync(schemaPath)) {
    return { created: false, serverDir }
  }

  mkdirSync(serverDir, { recursive: true })
  mkdirSync(join(serverDir, 'generated'), { recursive: true })
  mkdirSync(join(serverDir, 'hooks'), { recursive: true })

  writeFileSync(schemaPath, SKILL_SERVER_SCHEMA, 'utf-8')
  writeFileSync(join(serverDir, 'shogo.config.json'), SKILL_SERVER_CONFIG, 'utf-8')
  writeFileSync(join(serverDir, 'prisma.config.ts'), SKILL_SERVER_PRISMA_CONFIG, 'utf-8')

  return { created: true, serverDir }
}
