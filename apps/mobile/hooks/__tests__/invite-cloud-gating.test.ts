// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Desktop = cloud for inviting (SHO-454, plan section C).
 *
 * A local-only workspace has one person in it, so a link minted by the local
 * server is a `localhost` URL nobody else can open and the local app sends no
 * invite emails. The invite UI is therefore offered only for a cloud
 * workspace, and every call for one is routed to `/api/cloud/<id>/…` so it
 * behaves exactly as it does on the web.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetWorkspaceRouteForTests,
  canInviteHere,
  inviteLinkUrl,
  isCloudWorkspace,
  routePath,
  setCloudWorkspacesState,
} from '../../lib/workspace-route'

const CLOUD_ID = 'ws_cloud_1'
const LOCAL_ID = 'ws_local_1'

// `isLocalMode()` reads `window.shogoDesktop`, so flip that flag on the
// happy-dom window the preload installed. Replacing `window` itself would
// break every later test file in the same process (RTL needs it).
function asDesktop() {
  ;(window as any).shogoDesktop = { isDesktop: true }
}

function asWeb() {
  delete (window as any).shogoDesktop
}

function withCloudWorkspace() {
  setCloudWorkspacesState({
    signedIn: true,
    cloudUrl: 'https://shogo.one',
    reachable: true,
    user: { id: 'u1', name: 'Russ', email: 'r@x.com' },
    workspaces: [{ id: CLOUD_ID, name: 'Team', slug: 'team', kind: 'team' }],
  })
}

afterEach(() => {
  // `setCloudWorkspacesState` persists to storage and `_reset…` reloads from
  // it, so clear the cache first or the cloud workspace leaks into the next
  // test file in this process.
  localStorage.removeItem('shogo:cloud-workspaces')
  _resetWorkspaceRouteForTests()
  delete (window as any).shogoDesktop
})

describe('canInviteHere — the invite UI is offered only where it can work', () => {
  test('on the web, the server answer is the answer', () => {
    asWeb()
    withCloudWorkspace()
    expect(canInviteHere(true, LOCAL_ID)).toBe(true)
    expect(canInviteHere(true, CLOUD_ID)).toBe(true)
    expect(canInviteHere(false, CLOUD_ID)).toBe(false)
  })

  test('on the desktop, a local-only workspace offers no invite UI', () => {
    asDesktop()
    withCloudWorkspace()
    expect(canInviteHere(true, LOCAL_ID)).toBe(false)
  })

  test('on the desktop, a cloud workspace does', () => {
    asDesktop()
    withCloudWorkspace()
    expect(canInviteHere(true, CLOUD_ID)).toBe(true)
  })

  test('a server "no" is never overridden', () => {
    asDesktop()
    withCloudWorkspace()
    expect(canInviteHere(false, CLOUD_ID)).toBe(false)
  })
})

describe('routePath — a cloud workspace call goes to the cloud', () => {
  test('an invitation with the workspace in the query is rewritten', () => {
    withCloudWorkspace()
    expect(routePath(`/api/invitations?workspaceId=${CLOUD_ID}`)).toBe(
      `/api/cloud/${CLOUD_ID}/invitations?workspaceId=${CLOUD_ID}`,
    )
  })

  test('an invite link with the workspace in the query is rewritten', () => {
    withCloudWorkspace()
    expect(routePath(`/api/invite-links?workspaceId=${CLOUD_ID}`)).toBe(
      `/api/cloud/${CLOUD_ID}/invite-links?workspaceId=${CLOUD_ID}`,
    )
  })

  test('a resend is rewritten', () => {
    withCloudWorkspace()
    expect(routePath(`/api/invitations/inv_1/resend?workspaceId=${CLOUD_ID}`)).toBe(
      `/api/cloud/${CLOUD_ID}/invitations/inv_1/resend?workspaceId=${CLOUD_ID}`,
    )
  })

  test('a local workspace call stays local', () => {
    withCloudWorkspace()
    expect(routePath(`/api/invitations?workspaceId=${LOCAL_ID}`)).toBe(
      `/api/invitations?workspaceId=${LOCAL_ID}`,
    )
  })
})

describe('inviteLinkUrl — the copied link is the cloud URL', () => {
  test('a cloud workspace copies a shogo.one link, not the desktop origin', () => {
    asDesktop()
    withCloudWorkspace()
    expect(isCloudWorkspace(CLOUD_ID)).toBe(true)
    expect(inviteLinkUrl('tok_1', CLOUD_ID)).toBe('https://shogo.one/invite/tok_1')
  })

  test('a trailing slash on the cloud URL does not double up', () => {
    asDesktop()
    setCloudWorkspacesState({
      signedIn: true,
      cloudUrl: 'https://shogo.one/',
      reachable: true,
      user: null,
      workspaces: [{ id: CLOUD_ID, name: 'Team', slug: 'team', kind: 'team' }],
    })
    expect(inviteLinkUrl('tok_1', CLOUD_ID)).toBe('https://shogo.one/invite/tok_1')
  })
})
