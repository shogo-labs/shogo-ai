// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Writes the board, department and company templates under `templates/`
 * from `work-templates.ts`.
 *
 *   bun run packages/agent-runtime/src/work-templates-gen.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderAllTemplateFiles } from './work-templates'

export const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates')

if (import.meta.main) {
  const files = renderAllTemplateFiles()
  for (const [rel, content] of Object.entries(files)) {
    const out = join(TEMPLATES_DIR, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, content, 'utf-8')
  }
  console.log(`Wrote ${Object.keys(files).length} templates to ${TEMPLATES_DIR}`)
}
