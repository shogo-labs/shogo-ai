// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-211 — "Import .shogo just imports".
 *
 * The import flow has no options step: a picked archive starts importing on
 * the spot, chats always come along, and the user lands on the imported
 * project. The only prompt left is the password for an encrypted archive.
 *
 * These tests drive the real modal under happy-dom with the API seam and the
 * gluestack UI primitives mocked (the RN mock's `Pressable` doesn't forward
 * `onPress` to a DOM click, so buttons would be unclickable otherwise).
 *
 * Run: cd apps/mobile && bun --no-env-file ../../scripts/run-tests-isolated.ts \
 *        . --roots test
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createElement } from 'react'

const streamCalls: any[] = []
let streamImpl: (
  params: any,
  onProgress: (ev: any) => void,
) => Promise<unknown>

mock.module('../../lib/api', () => ({
  api: {
    importProjectStream: (params: any, onProgress: (ev: any) => void) => {
      streamCalls.push(params)
      return streamImpl(params, onProgress)
    },
  },
}))

mock.module('@/components/ui/modal', () => {
  const Box = ({ children, ...rest }: any) =>
    createElement('div', rest, children)
  return {
    Modal: ({ children, isOpen }: any) =>
      isOpen ? createElement('div', { 'data-testid': 'modal' }, children) : null,
    ModalBackdrop: Box,
    ModalContent: Box,
    ModalBody: Box,
    ModalFooter: Box,
    ModalCloseButton: Box,
  }
})
mock.module('@/components/ui/text', () => ({
  Text: ({ children, ...rest }: any) => createElement('span', rest, children),
}))
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onPress, disabled, ...rest }: any) =>
    createElement(
      'button',
      {
        ...rest,
        type: 'button',
        disabled: !!disabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    ),
  ButtonText: ({ children }: any) => createElement('span', null, children),
  ButtonSpinner: () => null,
  ButtonIcon: () => null,
}))
mock.module('@/components/ui/input', () => ({
  Input: ({ children }: any) => createElement('div', null, children),
  InputField: ({ onChangeText, value, placeholder }: any) =>
    createElement('input', {
      value,
      placeholder,
      onChange: (e: any) => onChangeText?.(e.target.value),
    }),
}))
mock.module('@/components/ui/progress', () => ({
  Progress: ({ children }: any) => createElement('div', null, children),
  ProgressFilledTrack: () => null,
}))
mock.module('../../components/project/transfer-modal-parts', () => ({
  TransferModalHeader: ({ title }: any) => createElement('h2', null, title),
  OptionGroup: ({ children }: any) => createElement('div', null, children),
}))

const { ProjectImportModal } = await import(
  '../../components/projects/ProjectImportModal'
)
const { describeArchive } = await import(
  '../../components/projects/usePickShogoArchive'
)

/** A minimal `.shogo` archive: local file header + the ZipCrypto flag bit. */
function archiveBlob(encrypted: boolean): Blob {
  const header = new Uint8Array([
    0x50, 0x4b, 0x03, 0x04, // local file header signature
    20, 0, // version needed
    encrypted ? 1 : 0, 0, // general purpose bit flag
    0, 0, 0, 0,
  ])
  return new Blob([header, new Uint8Array(64)])
}

function doneEvent(overrides: Record<string, unknown> = {}) {
  return {
    phase: 'done',
    project: { id: 'proj-1', name: 'Imported Demo' },
    stats: {
      filesWritten: 3,
      filesSkipped: 0,
      chatsImported: 2,
      chatsSkipped: 0,
    },
    requiredCredentials: [],
    warnings: [],
    ...overrides,
  }
}

function renderModal(props: Record<string, unknown> = {}) {
  const onOpenProject = mock((_project: unknown) => {})
  const onOpenChange = mock((_open: boolean) => {})
  render(
    createElement(ProjectImportModal, {
      open: true,
      onOpenChange,
      workspaceId: 'ws-1',
      onOpenProject,
      ...props,
    }),
  )
  return { onOpenProject, onOpenChange }
}

beforeEach(() => {
  streamCalls.length = 0
  streamImpl = async (_params, onProgress) => {
    onProgress(doneEvent())
    return {}
  }
})

afterEach(() => {
  streamCalls.length = 0
})

describe('ProjectImportModal (SHO-211)', () => {
  test('a picked archive imports immediately, with chats and no options', async () => {
    const file = await describeArchive(archiveBlob(false), 'demo.shogo', 74)
    const { onOpenProject } = renderModal({ initialFile: file })

    await waitFor(() => expect(streamCalls.length).toBe(1))
    expect(streamCalls[0].includeChats).toBe(true)
    expect(streamCalls[0].password).toBeUndefined()
    expect(streamCalls[0].filename).toBe('demo.shogo')

    // None of the removed options surface again.
    expect(screen.queryByText(/start import/i)).toBeNull()
    expect(screen.queryByText(/include chat history/i)).toBeNull()
    expect(screen.queryByText(/password-protected\?/i)).toBeNull()

    // …and it ends on the project, without an extra click.
    await waitFor(() => expect(onOpenProject).toHaveBeenCalledTimes(1))
    expect(onOpenProject).toHaveBeenCalledWith({
      id: 'proj-1',
      name: 'Imported Demo',
    })
  })

  test('a clean import closes the modal so the user lands on the project', async () => {
    const file = await describeArchive(archiveBlob(false), 'demo.shogo', 74)
    const { onOpenChange } = renderModal({ initialFile: file })

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  test('an encrypted archive asks for its password before importing', async () => {
    const file = await describeArchive(archiveBlob(true), 'secret.shogo', 74)
    expect(file.encrypted).toBe(true)
    const { onOpenProject } = renderModal({ initialFile: file })

    const field = screen.getByPlaceholderText(/archive password/i)
    expect(streamCalls.length).toBe(0)
    expect(onOpenProject).not.toHaveBeenCalled()

    await userEvent.type(field, 'hunter2')
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }))

    await waitFor(() => expect(streamCalls.length).toBe(1))
    expect(streamCalls[0].password).toBe('hunter2')
    expect(streamCalls[0].includeChats).toBe(true)
  })

  test('a wrong password keeps the field with an inline error', async () => {
    streamImpl = async () => {
      throw new Error('Incorrect password for this archive.')
    }
    const file = await describeArchive(archiveBlob(true), 'secret.shogo', 74)
    renderModal({ initialFile: file })

    await userEvent.type(
      screen.getByPlaceholderText(/archive password/i),
      'nope',
    )
    await userEvent.click(screen.getByRole('button', { name: /^import$/i }))

    await waitFor(() =>
      expect(screen.getByText(/incorrect password/i)).toBeTruthy(),
    )
    // Still the password step, still retryable.
    expect(screen.getByPlaceholderText(/archive password/i)).toBeTruthy()
    expect(screen.queryByText(/import could not complete/i)).toBeNull()
  })

  test('warnings keep the summary up instead of navigating away', async () => {
    streamImpl = async (_params, onProgress) => {
      onProgress({ phase: 'error', message: '2 files skipped', fatal: false })
      onProgress(doneEvent())
      return {}
    }
    const file = await describeArchive(archiveBlob(false), 'demo.shogo', 74)
    const { onOpenProject, onOpenChange } = renderModal({ initialFile: file })

    await waitFor(() => expect(screen.getByText(/import complete/i)).toBeTruthy())
    expect(screen.getByText(/2 files skipped/)).toBeTruthy()
    expect(screen.getByText(/1 warning/)).toBeTruthy()
    expect(onOpenProject).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)

    // The summary's Open project is what lands the user on the project.
    await userEvent.click(
      screen.getByRole('button', { name: /open project/i }),
    )
    expect(onOpenProject).toHaveBeenCalledTimes(1)
  })
})
