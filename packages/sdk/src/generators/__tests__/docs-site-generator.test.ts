// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import {
  generateDocsSiteScaffold,
  generateDocsTsConfig,
} from '../docs-site-generator'

describe('generateDocsSiteScaffold', () => {
  test('generates the full Docusaurus scaffold with defaults', () => {
    const files = generateDocsSiteScaffold()

    expect(files.map((file) => file.path)).toEqual([
      'package.json',
      'docusaurus.config.ts',
      'sidebars.ts',
      'docs/intro.md',
      'src/css/custom.css',
    ])
    expect(files.every((file) => file.skipIfExists)).toBe(true)
    expect(files.find((file) => file.path === 'docusaurus.config.ts')!.content)
      .toContain('My App Developer Docs')
    expect(files.find((file) => file.path === 'docs/intro.md')!.content)
      .toContain('# My App Developer Docs')
  })

  test('threads project metadata through package, config, and intro files', () => {
    const files = generateDocsSiteScaffold({
      projectName: 'Acme CRM',
      tagline: 'Internal operator guide',
      baseUrl: '/crm/',
      url: 'https://docs.example.com',
    })

    const pkg = JSON.parse(files.find((file) => file.path === 'package.json')!.content)
    expect(pkg.name).toBe('acme-crm-dev-docs')
    expect(pkg.scripts.build).toBe('docusaurus build')
    expect(pkg.dependencies['@docusaurus/core']).toBe('3.9.0')

    const config = files.find((file) => file.path === 'docusaurus.config.ts')!.content
    expect(config).toContain("title: 'Acme CRM Developer Docs'")
    expect(config).toContain("tagline: 'Internal operator guide'")
    expect(config).toContain("url: 'https://docs.example.com'")
    expect(config).toContain("baseUrl: '/crm/'")

    const intro = files.find((file) => file.path === 'docs/intro.md')!.content
    expect(intro).toContain('Welcome to the auto-generated developer documentation for **Acme CRM**.')
  })

  test('generates sidebars with intro, overview, API reference, and model docs', () => {
    const sidebars = generateDocsSiteScaffold()
      .find((file) => file.path === 'sidebars.ts')!
      .content

    expect(sidebars).toContain("'intro'")
    expect(sidebars).toContain("'models-overview'")
    expect(sidebars).toContain("'api-reference'")
    expect(sidebars).toContain("dirName: 'models'")
  })

  test('generates custom CSS landing scaffold', () => {
    const css = generateDocsSiteScaffold()
      .find((file) => file.path === 'src/css/custom.css')!
      .content

    expect(css).toContain('--ifm-color-primary')
    expect(css).toContain("[data-theme='dark']")
  })
})

describe('generateDocsTsConfig', () => {
  test('generates a Docusaurus tsconfig file', () => {
    const file = generateDocsTsConfig()

    expect(file.path).toBe('tsconfig.json')
    expect(file.skipIfExists).toBe(true)
    expect(JSON.parse(file.content)).toEqual({
      extends: '@docusaurus/tsconfig',
      compilerOptions: {
        baseUrl: '.',
      },
    })
  })
})
