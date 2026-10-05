// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { createReactNativeMock } from '../../../../test/react-native-mock'

mock.module('react-native', () => createReactNativeMock({ Platform: { OS: 'web', select: (s: any) => s.web ?? s.default } } as any))
mock.module('@shogo/shared-ui/primitives', () => ({ cn: (...a: unknown[]) => a.filter(Boolean).join(' ') }))

const { InlineToolWidget } = await import('../InlineToolWidget')
const { ExecWidget } = await import('../ExecWidget')

afterEach(cleanup)

const base = { id: 't1', category: 'other' as const, state: 'success' as const, timestamp: 0 }

describe('the "as …" label on tool calls', () => {
  test('a GitHub PR opened with the shared account, for someone', () => {
    render(
      <InlineToolWidget
        tool={{
          ...base,
          toolName: 'github_create_pr',
          args: { title: 'Fix' },
          result: { ok: true },
          credential: { source: 'shared', actingAs: 'project account (@acme-shared)', onBehalfOf: 'Gina' },
        }}
      />,
    )
    expect(screen.getByText('project account · for Gina')).toBeTruthy()
    const chip = screen.getByText('project account · for Gina').parentElement!
    expect(chip.getAttribute('accessibilitylabel')).toBe('Ran with the shared project account (@acme-shared) on behalf of Gina')
  })

  test('a shell command run with an approver\'s account', () => {
    render(
      <ExecWidget
        tool={{ ...base, toolName: 'exec', category: 'bash', args: { command: 'gh issue create' }, result: { stdout: '' }, credential: { source: 'approved', actingAs: '@frank-gh' } }}
        isExpanded={false}
        onToggle={() => {}}
      />,
    )
    expect(screen.getByText('as @frank-gh · approved')).toBeTruthy()
  })

  test('tools that touched no integration have no label', () => {
    const { container } = render(<InlineToolWidget tool={{ ...base, toolName: 'read_file', args: { path: 'a.ts' }, result: 'x' }} />)
    expect(container.textContent).not.toMatch(/project account|as @/)
  })
})
