// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import { describe, test, expect } from 'bun:test'
import { existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDirTemplates, getTemplateDistDir } from '../template-loader'

const __filename = fileURLToPath(import.meta.url)
const TEMPLATES_BASE = join(dirname(__filename), '..', '..', 'templates')

describe('template-loader', () => {
  test('loadDirTemplates returns templates from disk', () => {
    const templates = loadDirTemplates()
    expect(Array.isArray(templates)).toBe(true)
    // If any template dir has a template.json, we should pick it up.
    const onDisk = existsSync(TEMPLATES_BASE)
      ? readdirSync(TEMPLATES_BASE, { withFileTypes: true })
          .filter((d) => d.isDirectory() && existsSync(join(TEMPLATES_BASE, d.name, 'template.json')))
          .map((d) => d.name)
      : []
    expect(templates.length).toBe(onDisk.length)
    for (const t of templates) {
      expect(typeof t.id).toBe('string')
      expect(typeof t.name).toBe('string')
    }
  })

  test('getTemplateDistDir returns the dist path for a template with a built index.html', () => {
    // Find any template that has a real dist/index.html on disk.
    const withDist = readdirSync(TEMPLATES_BASE, { withFileTypes: true })
      .filter(
        (d) => d.isDirectory() && existsSync(join(TEMPLATES_BASE, d.name, 'dist', 'index.html')),
      )
      .map((d) => d.name)

    if (withDist.length === 0) {
      // No templates pre-built in this checkout; nothing to assert beyond the null path.
      return
    }
    const id = withDist[0]
    const dir = getTemplateDistDir(id)
    expect(dir).not.toBeNull()
    expect(dir).toContain(join('templates', id, 'dist'))
  })

  test('getTemplateDistDir returns null when the dist has not been built', () => {
    expect(getTemplateDistDir('___this-template-does-not-exist___')).toBeNull()
  })
})
