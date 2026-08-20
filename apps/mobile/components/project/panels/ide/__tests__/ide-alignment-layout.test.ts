// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mobileRoot = resolve(import.meta.dir, '../../../../..')
const read = (path: string) => readFileSync(resolve(mobileRoot, path), 'utf8')

describe('IDE primary sidebar alignment wiring', () => {
  test('defaults project IDE alignment to left through layout and component fallbacks', () => {
    expect(read('app/(app)/projects/[id]/_layout.tsx')).toContain(
      "useState<IdePrimarySideBarPosition>('left')",
    )
    expect(read('components/project/ProjectTopBar.tsx')).toContain(
      "idePrimarySideBarPosition = 'left'",
    )
    expect(read('components/project/panels/IDEPanel.tsx')).toContain(
      "primarySideBarPosition = 'left'",
    )
    expect(read('components/project/panels/ide/Workbench.tsx')).toContain(
      'primarySideBarPosition = "left"',
    )
  })

  test('orders activity bar, sidebar, splitter, and editor explicitly for both alignments', () => {
    const source = read('components/project/panels/ide/Workbench.tsx')

    expect(source).not.toContain('flex-row-reverse')
    expect(source).toContain(
      'primarySideBarPosition === "left" ? "order-1" : "order-4"',
    )
    expect(source).toContain(
      'primarySideBarPosition === "left" ? "order-2" : "order-3"',
    )
    expect(source).toContain(
      'primarySideBarPosition === "left" ? "order-3" : "order-2"',
    )
    expect(source).toContain(
      'primarySideBarPosition === "left" ? "order-4" : "order-1"',
    )
  })

  test('inverts horizontal sidebar resizing when the sidebar is on the right', () => {
    const source = read('components/project/panels/ide/Workbench.tsx')
    const splitter = read('components/project/panels/ide/Splitter.tsx')

    expect(source).toContain('invert: primarySideBarPosition === "right"')
    expect(splitter).toContain('start.current.size + (invert ? -delta : delta)')
    expect(splitter).toContain('[direction, invert, min, max]')
  })
})
