// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The profile picture control.
 *
 * The interesting behaviour is the order of operations and what happens when a
 * step fails: the picture must not be uploaded if the picker was cancelled or
 * permission was refused, the signed-in user must not be refreshed if the upload
 * failed, and a failure has to show the server's own sentence — "Images must be
 * 1 MB or smaller" tells someone what to do, "Could not save your photo." does not.
 */

import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createReactNativeMock } from '../../../test/react-native-mock'

const calls: { pick: string[]; prepare: unknown[]; upload: unknown[]; remove: number; refresh: number } = {
  pick: [], prepare: [], upload: [], remove: 0, refresh: 0,
}
let authUser: { name?: string; image?: string | null } | null = { name: 'Ada Lovelace', image: null }
let pickResult: any = { ok: true, photo: { uri: 'file:///picked.jpg', width: 4000, height: 3000 } }
let uploadError: Error | null = null
let removeError: Error | null = null

mock.module('react-native', () =>
  createReactNativeMock({
    Platform: { OS: 'web' },
    Pressable: ({ children, onPress, accessibilityLabel, testID, ...props }: any) =>
      createElement('button', { ...props, 'data-testid': testID, 'aria-label': accessibilityLabel, onClick: onPress }, children),
    Modal: ({ visible, children }: any) => (visible ? createElement('div', { 'data-testid': 'sheet' }, children) : null),
  }),
)
mock.module('@shogo/shared-ui/primitives', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  Avatar: ({ src, fallback }: any) =>
    createElement('span', { 'data-testid': 'avatar', 'data-src': src ?? '', 'data-fallback': fallback }),
  Button: ({ children, onPress, disabled, testID }: any) =>
    createElement('button', { 'data-testid': testID, onClick: onPress, disabled }, children),
}))
mock.module('lucide-react-native', () => ({
  Camera: () => createElement('span'),
  Image: () => createElement('span'),
}))
mock.module(resolve(import.meta.dir, '../../../contexts/auth'), () => ({
  useAuth: () => ({
    user: authUser,
    refreshSession: async () => { calls.refresh += 1 },
  }),
}))
mock.module(resolve(import.meta.dir, '../../../lib/avatar-picker'), () => ({
  pickAvatarPhoto: async (source: string) => { calls.pick.push(source); return pickResult },
}))
mock.module(resolve(import.meta.dir, '../../../lib/avatar-image'), () => ({
  prepareAvatarImage: async (uri: string, source: unknown) => {
    calls.prepare.push({ uri, source })
    return { uri: 'file:///prepared.jpg', width: 512, height: 512 }
  },
  uploadAvatar: async (uri: unknown) => {
    calls.upload.push(uri)
    if (uploadError) throw uploadError
    return '/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig'
  },
  removeAvatar: async () => {
    calls.remove += 1
    if (removeError) throw removeError
  },
}))
mock.module(resolve(import.meta.dir, '../../../lib/chat-attachment-url'), () => ({
  resolveAvatarUrl: (url: string | null | undefined) => (url ? `resolved:${url}` : null),
}))

const { ProfilePhoto } = await import('../ProfilePhoto')

function avatar() {
  return document.querySelector('[data-testid="avatar"]') as HTMLElement
}

/**
 * React Native primitives carry their testID on `data-rn-shim` in the shared
 * mock, not `data-testid` (only the components this test fakes itself use that).
 */
function shim(id: string): HTMLElement | null {
  return document.querySelector(`[data-rn-shim="${id}"]`) as HTMLElement | null
}

async function findShim(id: string): Promise<HTMLElement> {
  const found = await waitFor(() => {
    const el = shim(id)
    if (!el) throw new Error(`No element with data-rn-shim="${id}"`)
    return el
  })
  return found as HTMLElement
}

beforeEach(() => {
  cleanup()
  calls.pick = []
  calls.prepare = []
  calls.upload = []
  calls.remove = 0
  calls.refresh = 0
  authUser = { name: 'Ada Lovelace', image: null }
  pickResult = { ok: true, photo: { uri: 'file:///picked.jpg', width: 4000, height: 3000 } }
  uploadError = null
  removeError = null
})

describe('ProfilePhoto', () => {
  test('offers to add a photo when there is none, and shows initials', () => {
    render(createElement(ProfilePhoto))

    expect(screen.getByTestId('profile-photo-change').textContent).toBe('Add photo')
    expect(screen.queryByTestId('profile-photo-remove')).toBeNull()
    expect(avatar().getAttribute('data-src')).toBe('')
    expect(avatar().getAttribute('data-fallback')).toBe('AL')
  })

  test('resolves a stored photo for display and offers to change it', () => {
    authUser = { name: 'Ada Lovelace', image: '/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig' }
    render(createElement(ProfilePhoto))

    expect(avatar().getAttribute('data-src')).toBe('resolved:/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig')
    expect(screen.getByTestId('profile-photo-change').textContent).toBe('Change photo')
    expect(screen.getByTestId('profile-photo-remove')).toBeTruthy()
  })

  test('picks, resizes and uploads, then refreshes the signed-in user', async () => {
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-change'))
    // The sheet is closed until asked for, so its options cannot be reached early.
    expect(screen.getByTestId('profile-photo-source-library')).toBeTruthy()

    fireEvent.click(screen.getByTestId('profile-photo-source-library'))
    await screen.findByTestId('profile-photo-change')

    expect(calls.pick).toEqual(['library'])
    expect(calls.prepare).toEqual([{ uri: 'file:///picked.jpg', source: { uri: 'file:///picked.jpg', width: 4000, height: 3000 } }])
    expect(calls.upload).toEqual(['file:///prepared.jpg'])
    expect(calls.refresh).toBe(1)
  })

  test('does nothing at all when the picker is cancelled', async () => {
    pickResult = { ok: false, reason: 'cancelled' }
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-change'))
    fireEvent.click(screen.getByTestId('profile-photo-source-library'))
    await screen.findByTestId('profile-photo-change')

    expect(calls.prepare).toEqual([])
    expect(calls.upload).toEqual([])
    expect(calls.refresh).toBe(0)
    expect(screen.queryByTestId('profile-photo-error')).toBeNull()
  })

  test('explains a refused permission instead of failing silently', async () => {
    pickResult = { ok: false, reason: 'denied', message: 'Allow photo access in Settings to choose a picture.' }
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-change'))
    fireEvent.click(screen.getByTestId('profile-photo-source-library'))
    const error = await findShim('profile-photo-error')

    expect(error.textContent).toBe('Allow photo access in Settings to choose a picture.')
    expect(calls.upload).toEqual([])
  })

  test('shows the server\'s own message when the upload is rejected, and does not refresh', async () => {
    uploadError = new Error('Images must be 1 MB or smaller')
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-change'))
    fireEvent.click(screen.getByTestId('profile-photo-source-library'))
    const error = await findShim('profile-photo-error')

    expect(error.textContent).toBe('Images must be 1 MB or smaller')
    expect(calls.refresh).toBe(0)
  })

  test('the camera row asks for the camera', async () => {
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-change'))
    fireEvent.click(screen.getByTestId('profile-photo-source-camera'))
    await screen.findByTestId('profile-photo-change')

    expect(calls.pick).toEqual(['camera'])
  })

  test('removes the photo and refreshes', async () => {
    authUser = { name: 'Ada Lovelace', image: '/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig' }
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-remove'))
    await screen.findByTestId('profile-photo-remove')

    expect(calls.remove).toBe(1)
    expect(calls.refresh).toBe(1)
  })

  test('surfaces a failure to remove', async () => {
    authUser = { name: 'Ada Lovelace', image: '/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig' }
    removeError = new Error('Not authenticated')
    render(createElement(ProfilePhoto))

    fireEvent.click(screen.getByTestId('profile-photo-remove'))
    const error = await findShim('profile-photo-error')

    expect(error.textContent).toBe('Not authenticated')
  })
})
