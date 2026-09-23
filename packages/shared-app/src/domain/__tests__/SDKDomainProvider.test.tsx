// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { useEffect } from 'react'
import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import {
  installHappyDom,
  restoreHappyDom,
} from '../../hooks/__tests__/happy-dom-setup.ts'
import {
  SDKDomainProvider,
  resetSDKDomainStore,
  useSDKDomain,
} from '../SDKDomainProvider'

installHappyDom()

afterEach(() => {
  cleanup()
  resetSDKDomainStore()
})

describe('SDKDomainProvider user changes', () => {
  it('clears the singleton store before mounting children for the next user', () => {
    const events: string[] = []
    let store: ReturnType<typeof useSDKDomain> | null = null

    function Probe({ userId }: { userId: string }) {
      store = useSDKDomain()
      events.push(`render:${userId}`)
      useEffect(() => {
        events.push(`effect:${userId}`)
      }, [userId])
      return null
    }

    const rendered = render(
      <SDKDomainProvider apiBaseUrl="https://api.test" userId="user-a">
        <Probe userId="user-a" />
      </SDKDomainProvider>,
    )
    expect(store).not.toBeNull()
    store!.projectCollection.addItem({
      id: 'project-a',
      name: 'Project A',
      workspaceId: 'workspace-a',
      updatedAt: 0,
    })
    expect(store!.projectCollection.all).toHaveLength(1)

    act(() => {
      rendered.rerender(
        <SDKDomainProvider apiBaseUrl="https://api.test" userId="user-b">
          <Probe userId="user-b" />
        </SDKDomainProvider>,
      )
    })

    expect(events).toContain('render:user-a')
    expect(events).toContain('render:user-b')
    expect(store!.projectCollection.all).toHaveLength(0)
    expect(events.indexOf('render:user-b')).toBeGreaterThan(events.indexOf('effect:user-a'))
  })

  it('does not clear the MST store during render when authentication changes', () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {})

    function Probe() {
      useSDKDomain()
      return null
    }

    const rendered = render(
      <SDKDomainProvider apiBaseUrl="https://api.test" userId="user-a">
        <Probe />
      </SDKDomainProvider>,
    )

    act(() => {
      rendered.rerender(
        <SDKDomainProvider apiBaseUrl="https://api.test" userId="user-b">
          <Probe />
        </SDKDomainProvider>,
      )
    })

    expect(consoleError.mock.calls.some(([message]) =>
      String(message).includes('Cannot update a component while rendering'),
    )).toBe(false)
    consoleError.mockRestore()
  })
})

afterAll(() => {
  restoreHappyDom()
})
