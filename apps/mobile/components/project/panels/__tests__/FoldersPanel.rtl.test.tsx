// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/**
 * RTL tests for FoldersPanel — the desktop Workspace/Folders panel.
 *
 * Locks in the bug fixes from the "Trust folder" work:
 *   - The panel reads the local-projects `{ project }` envelope (NOT the
 *     generated `{ ok, data }` shape). An external project must render
 *     the trust toggle, NOT the dead "Managed project" empty state.
 *   - The trust toggle posts `{ trusted: true }` to the /trust route.
 *   - A genuinely managed project still renders the informational state.
 *
 * Dependencies that need a live context / router (`useDomainHttp`,
 * `useOpenLocalFolder`), the API base URL, and the bare `react-native`
 * import are mocked so the panel can render in isolation (react-native ->
 * react-native-web, the same renderer used on web/desktop). Its data
 * fetch is driven via a stubbed global fetch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import * as ReactNativeWeb from 'react-native-web'

// No Metro/webpack alias in the test runtime, so map the bare
// 'react-native' specifier to react-native-web before importing the SUT.
mock.module('react-native', () => ReactNativeWeb)

// lucide-react-native pulls in react-native-svg (which itself imports the
// flow-typed `react-native` entry that bun can't parse). We don't assert
// on icons, so stub the named exports FoldersPanel uses with no-ops.
const StubIcon = () => null
mock.module('lucide-react-native', () => ({
  __esModule: true,
  Folder: StubIcon,
  FolderPlus: StubIcon,
  FolderTree: StubIcon,
  Globe: StubIcon,
  Star: StubIcon,
  StarOff: StubIcon,
  Trash2: StubIcon,
  ShieldAlert: StubIcon,
  ShieldCheck: StubIcon,
  PlaySquare: StubIcon,
}))

// shared-ui primitives only contributes `cn` here.
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(' '),
}))

const httpPost = mock(async () => ({ data: {} }))
const httpDelete = mock(async () => ({ data: {} }))
const httpPatch = mock(async () => ({ data: {} }))

mock.module('../../../../contexts/domain', () => ({
  useDomainHttp: () => ({
    post: httpPost,
    delete: httpDelete,
    patch: httpPatch,
    get: mock(async () => ({ data: {} })),
  }),
}))

mock.module('../../../../lib/api', () => ({
  API_URL: 'http://test.local',
}))

mock.module('../../useOpenLocalFolder', () => ({
  useOpenLocalFolder: () => ({
    openFolder: mock(async () => {}),
    isPicking: false,
    isAvailable: false,
  }),
}))

// Import the SUT AFTER the mocks are registered (top-level await — same
// ordering guarantee the other mobile lib tests rely on).
const { FoldersPanel } = await import('../FoldersPanel')

// The project the stubbed fetch returns for GET /api/local/projects/:id.
let currentProject: any = null
const origFetch = globalThis.fetch

beforeEach(() => {
  httpPost.mockClear()
  httpDelete.mockClear()
  httpPatch.mockClear()
  currentProject = null
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input)
    if (url.includes('/external-preview')) {
      return new Response(JSON.stringify({ savedUrl: null, detectedUrl: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    if (url.includes('/api/local/projects/')) {
      return new Response(JSON.stringify({ project: currentProject }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = origFetch
})

describe('FoldersPanel — envelope parsing + trust toggle', () => {
  test('external + restricted project renders the Trust toggle, not "Managed project"', async () => {
    currentProject = {
      id: 'proj-ext',
      name: 'My Repo',
      workingMode: 'external',
      trustLevel: 'restricted',
      runtimeEnabled: true,
      projectFolders: [{ id: 'f1', path: '/Users/me/repo', isPrimary: true }],
    }

    render(<FoldersPanel projectId="proj-ext" visible />)

    expect(await screen.findByText('Trust folder')).toBeInTheDocument()
    expect(screen.getByText(/Workspace is restricted/i)).toBeInTheDocument()
    // The dead "Managed project" empty state must NOT show for an
    // external project (mis-read envelope -> managed was the bug).
    expect(screen.queryByText('Managed project')).not.toBeInTheDocument()
  })

  test('clicking "Trust folder" posts { trusted: true } to the /trust route', async () => {
    currentProject = {
      id: 'proj-ext',
      name: 'My Repo',
      workingMode: 'external',
      trustLevel: 'restricted',
      runtimeEnabled: true,
      projectFolders: [{ id: 'f1', path: '/Users/me/repo', isPrimary: true }],
    }

    const user = userEvent.setup()
    render(<FoldersPanel projectId="proj-ext" visible />)

    await user.click(await screen.findByText('Trust folder'))

    await waitFor(() => {
      expect(httpPost).toHaveBeenCalled()
    })
    const call = httpPost.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/trust'),
    )
    expect(call).toBeDefined()
    expect(call?.[0]).toContain('/api/local/projects/proj-ext/trust')
    expect(call?.[1]).toEqual({ trusted: true })
  })

  test('trusted project shows the "Restrict" affordance', async () => {
    currentProject = {
      id: 'proj-ext',
      name: 'My Repo',
      workingMode: 'external',
      trustLevel: 'trusted',
      runtimeEnabled: true,
      projectFolders: [{ id: 'f1', path: '/Users/me/repo', isPrimary: true }],
    }

    render(<FoldersPanel projectId="proj-ext" visible />)

    expect(await screen.findByText('Restrict')).toBeInTheDocument()
    expect(screen.getByText(/Workspace trusted/i)).toBeInTheDocument()
  })

  test('managed project renders the informational "Managed project" state', async () => {
    currentProject = {
      id: 'proj-managed',
      name: 'Sandbox',
      workingMode: 'managed',
      trustLevel: 'trusted',
      runtimeEnabled: true,
      projectFolders: [],
    }

    render(<FoldersPanel projectId="proj-managed" visible />)

    expect(await screen.findByText('Managed project')).toBeInTheDocument()
    expect(screen.queryByText('Trust folder')).not.toBeInTheDocument()
  })
})
