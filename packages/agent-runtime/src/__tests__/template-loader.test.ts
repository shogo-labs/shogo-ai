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

import {
  getTemplateShogoDir,
  getTemplateCanvasStatePath,
  getTemplateCanvasCodeDir,
  getTemplateSrcDir,
  getTemplatePrismaDir,
  getTemplateCustomRoutesPath,
} from '../template-loader'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'

describe('template-loader path helpers', () => {
  const FIXTURE = join(TEMPLATES_BASE, '__test_fixture__')

  const setup = () => {
    mkdirSync(join(FIXTURE, '.shogo'), { recursive: true })
    writeFileSync(join(FIXTURE, '.canvas-state.json'), '{}', 'utf-8')
    mkdirSync(join(FIXTURE, 'canvas'), { recursive: true })
    mkdirSync(join(FIXTURE, 'src'), { recursive: true })
    mkdirSync(join(FIXTURE, 'prisma'), { recursive: true })
  }
  const teardown = () => rmSync(FIXTURE, { recursive: true, force: true })

  test('getTemplateShogoDir returns path when .shogo exists', () => {
    setup()
    try {
      const r = getTemplateShogoDir('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('.shogo')
    } finally { teardown() }
  })

  test('getTemplateShogoDir returns null when template missing', () => {
    expect(getTemplateShogoDir('__nope__')).toBeNull()
  })

  test('getTemplateCanvasStatePath returns path when .canvas-state.json exists', () => {
    setup()
    try {
      const r = getTemplateCanvasStatePath('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('.canvas-state.json')
    } finally { teardown() }
  })

  test('getTemplateCanvasStatePath returns null when missing', () => {
    expect(getTemplateCanvasStatePath('__nope__')).toBeNull()
  })

  test('getTemplateCanvasCodeDir returns path when canvas/ exists', () => {
    setup()
    try {
      const r = getTemplateCanvasCodeDir('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('canvas')
    } finally { teardown() }
  })

  test('getTemplateCanvasCodeDir returns null when missing', () => {
    expect(getTemplateCanvasCodeDir('__nope__')).toBeNull()
  })

  test('getTemplateSrcDir returns path when src/ exists', () => {
    setup()
    try {
      const r = getTemplateSrcDir('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('src')
    } finally { teardown() }
  })

  test('getTemplateSrcDir returns null when missing', () => {
    expect(getTemplateSrcDir('__nope__')).toBeNull()
  })

  test('getTemplatePrismaDir returns path when prisma/ exists', () => {
    setup()
    try {
      const r = getTemplatePrismaDir('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('prisma')
    } finally { teardown() }
  })

  test('getTemplatePrismaDir returns null when missing', () => {
    expect(getTemplatePrismaDir('__nope__')).toBeNull()
  })

  test('getTemplateCustomRoutesPath returns path when custom-routes.ts exists', () => {
    setup()
    try {
      writeFileSync(join(FIXTURE, 'custom-routes.ts'), 'export default {}', 'utf-8')
      const r = getTemplateCustomRoutesPath('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('custom-routes.ts')
    } finally { teardown() }
  })

  test('getTemplateCustomRoutesPath falls back to the .tsx variant', () => {
    setup()
    try {
      writeFileSync(join(FIXTURE, 'custom-routes.tsx'), 'export default {}', 'utf-8')
      const r = getTemplateCustomRoutesPath('__test_fixture__')
      expect(r).not.toBeNull()
      expect(r).toContain('custom-routes.tsx')
    } finally { teardown() }
  })

  test('getTemplateCustomRoutesPath returns null when missing', () => {
    expect(getTemplateCustomRoutesPath('__nope__')).toBeNull()
  })
})
