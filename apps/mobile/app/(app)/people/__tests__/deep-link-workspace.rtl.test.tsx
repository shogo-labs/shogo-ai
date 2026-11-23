// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * A profile opened by URL has to survive the workspace list arriving late.
 *
 * QA found this on the SHO-490 acceptance pass: `/(app)/people/[userId]` and
 * `/(app)/agents/[key]` gate on `useActiveWorkspace()`, which reads the
 * workspaces collection. Opened by URL that collection is empty on the first
 * render and fills in once its request lands — but the routes were not
 * `observer`s, and nothing else on them subscribes, so the gate never
 * re-rendered and both spun forever (`AC2` of the card could not be shown on a
 * phone). Every other route that reads a domain store is wrapped in
 * `observer`; these two now are.
 *
 * The test mounts the real routes against a real MST collection, so it fails
 * again the day either one drops its subscription: the profile only appears
 * when the mutation below re-renders the route.
 */
import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { act, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { types, type Instance } from 'mobx-state-tree'

const mobile = resolve(import.meta.dir, '../../../..')

let params: Record<string, string | undefined> = {}

mock.module('expo-router', () => ({
  useLocalSearchParams: () => params,
  useRouter: () => ({
    back: () => undefined,
    push: () => undefined,
    replace: () => undefined,
    setParams: () => undefined,
    canGoBack: () => false,
  }),
}))

/** The shape `useActiveWorkspace` reads: `all` over an observable map, plus `isLoading`. */
const WorkspaceCollection = types
  .model('WorkspaceCollectionFixture', {
    items: types.map(types.frozen<{ id: string; name?: string }>()),
    isLoading: types.optional(types.boolean, false),
  })
  .views((self) => ({
    get all() {
      return Array.from(self.items.values())
    },
  }))
  .actions((self) => ({
    /** What `loadAll()` does when its response lands: fill the map, clear the flag. */
    fill(ids: string[]) {
      for (const id of ids) self.items.set(id, { id })
      self.isLoading = false
    },
  }))

let store: Instance<typeof WorkspaceCollection>

mock.module(resolve(mobile, 'contexts/domain'), () => ({
  useWorkspaceCollection: () => store,
}))

mock.module(resolve(mobile, 'lib/workspace-store'), () => ({
  getActiveWorkspaceId: () => null,
  subscribeActiveWorkspaceId: () => () => undefined,
  resolveActiveWorkspaceId: (ids: readonly string[], candidate?: string | null) =>
    candidate && ids.includes(candidate) ? candidate : (ids[0] ?? null),
}))

mock.module(resolve(mobile, 'components/team-chat/UserProfileScreen'), () => ({
  UserProfileScreen: (props: { workspaceId: string; userId: string }) =>
    createElement('div', { 'data-testid': 'user-profile-screen' }, `${props.workspaceId}:${props.userId}`),
}))

mock.module(resolve(mobile, 'components/team-chat/AgentProfileScreen'), () => ({
  AgentProfileScreen: (props: { workspaceId: string; agentKey?: string }) =>
    createElement('div', { 'data-testid': 'agent-profile-screen' }, `${props.workspaceId}:${props.agentKey}`),
}))

const UserProfileRoute = (await import('../[userId]')).default
const AgentProfileRoute = (await import('../../agents/[key]')).default

/** The workspace list lands after the route's first render, as it does on a cold deep link. */
async function workspaceListArrives(id = 'ws-1') {
  await act(async () => {
    store.fill([id])
  })
}

describe('a profile deep link waits for the workspace list', () => {
  beforeEach(() => {
    store = WorkspaceCollection.create({ isLoading: true })
  })

  test("people/[userId] renders the person's profile once the list lands", async () => {
    params = { userId: 'user-1' }
    render(createElement(UserProfileRoute))

    expect(screen.queryByTestId('user-profile-screen')).toBeNull()

    await workspaceListArrives()

    await waitFor(() => expect(screen.getByTestId('user-profile-screen')).toBeTruthy())
    expect(screen.getByTestId('user-profile-screen').textContent).toBe('ws-1:user-1')
  })

  test("agents/[key] renders the agent's profile once the list lands", async () => {
    params = { key: 'ws' }
    render(createElement(AgentProfileRoute))

    expect(screen.queryByTestId('agent-profile-screen')).toBeNull()

    await workspaceListArrives('ws-2')

    await waitFor(() => expect(screen.getByTestId('agent-profile-screen')).toBeTruthy())
    expect(screen.getByTestId('agent-profile-screen').textContent).toBe('ws-2:ws')
  })

  test('no workspace at all keeps the profile off screen instead of rendering an empty one', async () => {
    params = { userId: 'user-1' }
    render(createElement(UserProfileRoute))

    await act(async () => {
      store.fill([])
    })

    expect(screen.queryByTestId('user-profile-screen')).toBeNull()
  })
})
