// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Non-throwing domain accessors, plus the store/actions the provider exposes
 * without React context.
 *
 * The workspace switcher's invites block renders inside a Gluestack popover
 * portal, whose host is mounted above `SDKDomainProvider`. `useSDKDomain()`
 * there throws (`useAuth must be used within AuthProvider` first, then the
 * domain ones), and in SHO-84 that crash replaced the whole app shell. Those
 * surfaces read the optional accessors and, with no context at all, the
 * provider's module singletons — the same instance, no context needed.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { installHappyDom } from '../../hooks/__tests__/happy-dom-setup.ts'
import {
  SDKDomainProvider,
  getDomainActions,
  getSDKDomainStore,
  getSDKHttpClient,
  resetSDKDomainStore,
  useDomainActionsOptional,
  useSDKDomain,
  useSDKDomainOptional,
  useWorkspaceCollectionOptional,
} from '../SDKDomainProvider'

installHappyDom()

afterEach(() => {
  cleanup()
  resetSDKDomainStore()
})

describe('optional domain accessors', () => {
  it('reports null outside a provider instead of throwing', () => {
    const seen: unknown[] = []
    function Probe() {
      seen.push(useSDKDomainOptional() ? 'store' : null)
      seen.push(useWorkspaceCollectionOptional() ? 'workspaces' : null)
      seen.push(useDomainActionsOptional() ? 'actions' : null)
      seen.push(getSDKDomainStore() ? 'singleton' : null)
      seen.push(getDomainActions() ? 'singleton-actions' : null)
      seen.push(getSDKHttpClient() ? 'http' : null)
      return null
    }
    render(<Probe />)
    expect(seen).toEqual([null, null, null, null, null, null])
  })

  it('keeps useSDKDomain throwing outside a provider', () => {
    function Probe() {
      useSDKDomain()
      return null
    }
    expect(() => render(<Probe />)).toThrow('useSDKDomain must be used within SDKDomainProvider')
  })

  it('exposes the same store and actions through context and the singletons', () => {
    let viaContext: ReturnType<typeof useSDKDomainOptional> = null
    function Probe() {
      viaContext = useSDKDomainOptional()
      return null
    }
    render(
      <SDKDomainProvider apiBaseUrl="https://api.test" userId="user-a">
        <Probe />
      </SDKDomainProvider>,
    )

    expect(viaContext).not.toBeNull()
    expect(getSDKDomainStore()).toBe(viaContext!)
    expect(getSDKHttpClient()).not.toBeNull()
    const actions = getDomainActions()
    expect(typeof actions?.acceptInvitation).toBe('function')
    expect(typeof actions?.declineInvitation).toBe('function')
  })
})
