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
  'AGENTS.md',
  'HEARTBEAT.md',
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
        techStack: meta.techStack,
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

/**
 * Get the path to a template's src/ directory for direct copying.
 * Templates with React components store them in src/ which merges
 * on top of the runtime-template during seeding.
 */
export function getTemplateSrcDir(templateId: string): string | null {
  const dir = join(TEMPLATES_BASE, templateId, 'src')
  return existsSync(dir) ? dir : null
}

/**
 * Get the path to a template's prisma/ directory for direct copying.
 * Templates that define their own Prisma schema (models for the auto-
 * generated CRUD server) ship it in prisma/schema.prisma. When present,
 * it overrides the default schema from the runtime-template during seeding.
 */
export function getTemplatePrismaDir(templateId: string): string | null {
  const dir = join(TEMPLATES_BASE, templateId, 'prisma')
  return existsSync(dir) ? dir : null
}

/**
 * Get the path to a template's pre-built dist/ directory for direct copying.
 *
 * Templates whose `src/App.tsx` renders a curated surface ship a
 * pre-built `dist/` produced by `scripts/build-template-dists.ts`. The
 * canvas iframe paints whatever `dist/` is on disk while Vite is still
 * doing its cold rebuild, so without this the user sees the bundled
 * runtime-template's pre-built `Project Ready` page flash for 1-3s
 * before HMR catches up. With it, the canvas paints the template surface
 * from the very first byte.
 *
 * Returns null when the template hasn't been pre-built — in that case
 * callers fall back to the bundled runtime-template's dist (still safe;
 * just slower first paint until Vite produces the real bundle).
 */
export function getTemplateDistDir(templateId: string): string | null {
  const dir = join(TEMPLATES_BASE, templateId, 'dist')
  // We only treat the dist as valid if it has assets — an empty dir from
  // a half-finished build would otherwise overwrite a healthy fallback.
  if (existsSync(join(dir, 'index.html'))) return dir
  return null
}
