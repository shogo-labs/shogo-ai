// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { describe, expect, test } from 'bun:test'
import { workspaceDeleteErrorMessage, workspaceErrorMessage } from '../workspace-errors'

describe('workspaceErrorMessage', () => {
  test("prefers the server's message from a ShogoError details payload", () => {
    const err = Object.assign(new Error('Request failed with status 400'), {
      details: { error: { code: 'invalid_name', message: 'Give your workspace a name.' } },
    })
    expect(workspaceErrorMessage(err)).toBe('Give your workspace a name.')
  })

  test('reads a bare { error } body too', () => {
    expect(workspaceErrorMessage({ error: { code: 'last_workspace', message: 'Create another one first.' } })).toBe(
      'Create another one first.',
    )
  })

  test('falls back for a generic collection error so the user is not left stranded', () => {
    expect(workspaceErrorMessage(new Error('Create failed'))).toBe('Could not create the workspace.')
    expect(workspaceErrorMessage(null)).toBe('Could not create the workspace.')
    expect(workspaceErrorMessage(undefined, 'Custom fallback')).toBe('Custom fallback')
  })

  test('never shows an empty server message', () => {
    expect(workspaceErrorMessage({ error: { code: 'invalid_name', message: '' } })).toBe(
      'Could not create the workspace.',
    )
  })
})

describe('workspaceDeleteErrorMessage', () => {
  test("surfaces the server's guard message", () => {
    const err = Object.assign(new Error('Request failed with status 409'), {
      details: {
        error: {
          code: 'personal_workspace_required',
          message: 'Your personal workspace cannot be deleted.',
        },
      },
    })
    expect(workspaceDeleteErrorMessage(err)).toBe('Your personal workspace cannot be deleted.')
  })

  test('falls back to the delete-specific copy', () => {
    expect(workspaceDeleteErrorMessage(new Error('Delete failed'))).toBe(
      'Could not delete the workspace.',
    )
  })
})
