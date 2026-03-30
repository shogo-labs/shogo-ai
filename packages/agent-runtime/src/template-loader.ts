// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Directory-based Template Loader
 *
 * Reads templates from templates/<id>/ directories where each contains
 * a template.json (metadata) and .shogo/ (workspace files).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentTemplate } from './agent-templates'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TEMPLATES_BASE = join(__dirname, '..', 'templates')

const WORKSPACE_FILES = [
  'IDENTITY.md',
  'SOUL.md',
  'AGENTS.md',
  'HEARTBEAT.md',
  'USER.md',
  'config.json',
]

/** Load all directory-based templates. Each must contain template.json and .shogo/ */
export function loadDirTemplates(): AgentTemplate[] {
  if (!existsSync(TEMPLATES_BASE)) return []

  return readdirSync(TEMPLATES_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(TEMPLATES_BASE, d.name, 'template.json')))
    .map(d => {
      const templateDir = join(TEMPLATES_BASE, d.name)
      const meta = JSON.parse(readFileSync(join(templateDir, 'template.json'), 'utf-8'))
      const shogoDir = join(templateDir, '.shogo')

      const files: Record<string, string> = {}
      if (existsSync(shogoDir)) {
        for (const fname of WORKSPACE_FILES) {
          const fp = join(shogoDir, fname)
          if (existsSync(fp)) files[fname] = readFileSync(fp, 'utf-8')
        }
      }

      const skillsDir = join(shogoDir, 'skills')
      const skills = existsSync(skillsDir)
        ? readdirSync(skillsDir, { withFileTypes: true })
            .filter(s => s.isDirectory() && existsSync(join(skillsDir, s.name, 'SKILL.md')))
            .map(s => s.name)
        : []

      return {
        id: meta.id ?? d.name,
        name: meta.name,
        description: meta.description,
        category: meta.category,
        icon: meta.icon,
        tags: meta.tags ?? [],
        settings: meta.settings ?? {
          heartbeatInterval: 3600,
          heartbeatEnabled: true,
          modelProvider: 'anthropic',
          modelName: 'claude-sonnet-4-5',
        },
        skills,
        files,
        integrations: meta.integrations,
      } satisfies AgentTemplate
    })
}

/**
 * Get the path to a template's .shogo directory for direct copying.
 */
export function getTemplateShogoDir(templateId: string): string | null {
  const dir = join(TEMPLATES_BASE, templateId, '.shogo')
  return existsSync(dir) ? dir : null
}

/**
 * Get the path to a template's .canvas-state.json for direct copying.
 * Returns null if the template has no canvas state.
 */
export function getTemplateCanvasStatePath(templateId: string): string | null {
  const fp = join(TEMPLATES_BASE, templateId, '.canvas-state.json')
  return existsSync(fp) ? fp : null
}

/**
 * Get the path to a template's canvas/ code directory for direct copying.
 * Returns null if the template has no canvas code directory.
 */
export function getTemplateCanvasCodeDir(templateId: string): string | null {
  const dir = join(TEMPLATES_BASE, templateId, 'canvas')
  return existsSync(dir) ? dir : null
}
