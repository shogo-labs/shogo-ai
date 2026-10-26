// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

import { resolve } from 'node:path'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createReactNativeMock } from '../../test/react-native-mock'

const calls: { uri?: string; crop?: unknown; resize?: unknown; save?: unknown } = {}
const fakeImage = {
  saveAsync: async (options: unknown) => {
    calls.save = options
    return { uri: 'file:///prepared.jpg', width: 512, height: 512 }
  },
}
const fakeContext = {
  crop: (rect: unknown) => { calls.crop = rect },
  resize: (size: unknown) => { calls.resize = size },
  renderAsync: async () => fakeImage,
}

mock.module('react-native', () => createReactNativeMock({ Platform: { OS: 'web' } }))
mock.module('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
  ImageManipulator: {
    manipulate: (uri: string) => { calls.uri = uri; return fakeContext },
  },
}))
mock.module(resolve(import.meta.dir, '../api'), () => ({ API_URL: 'https://api.test' }))
mock.module(resolve(import.meta.dir, '../team-chat-api'), () => ({ nativeCookieHeader: () => ({}) }))

const { AVATAR_SIZE, avatarCropRect, prepareAvatarImage, removeAvatar, uploadAvatar } =
  await import('../avatar-image')

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Answers the two fetches the web path makes: the object URL, then the upload. */
function mockFetch(handler: (url: string, init?: RequestInit) => Response) {
  ;(globalThis as any).fetch = async (url: string, init?: RequestInit) => {
    if (String(url).startsWith('blob:')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }))
    }
    return handler(String(url), init)
  }
}

beforeEach(() => {
  calls.uri = undefined
  calls.crop = undefined
  calls.resize = undefined
  calls.save = undefined
})

describe('avatarCropRect', () => {
  test('takes the largest centred square from a landscape photo', () => {
    expect(avatarCropRect(4000, 3000)).toEqual({ originX: 500, originY: 0, width: 3000, height: 3000 })
  })

  test('takes the largest centred square from a portrait photo', () => {
    expect(avatarCropRect(3000, 4000)).toEqual({ originX: 0, originY: 500, width: 3000, height: 3000 })
  })

  test('is a no-op on an already square photo', () => {
    expect(avatarCropRect(512, 512)).toEqual({ originX: 0, originY: 0, width: 512, height: 512 })
  })

  test('returns null when the source has no usable size, rather than a nonsense rectangle', () => {
    // The picker cannot always report dimensions; the caller then skips the crop.
    expect(avatarCropRect(0, 0)).toBeNull()
    expect(avatarCropRect(NaN, 100)).toBeNull()
    expect(avatarCropRect(100, 0)).toBeNull()
  })
})

describe('prepareAvatarImage', () => {
  test('centre-crops to a square, resizes to 512, and re-encodes as JPEG', async () => {
    const prepared = await prepareAvatarImage('file:///picked.jpg', { width: 4000, height: 3000 })

    expect(calls.uri).toBe('file:///picked.jpg')
    expect(calls.crop).toEqual({ originX: 500, originY: 0, width: 3000, height: 3000 })
    expect(calls.resize).toEqual({ width: AVATAR_SIZE, height: AVATAR_SIZE })
    // JPEG, not PNG: a photo compresses hugely under JPEG and re-encoding also
    // drops EXIF (including GPS) before the bytes ever leave the device.
    expect(calls.save).toEqual({ format: 'jpeg', compress: 0.85 })
    expect(prepared).toEqual({ uri: 'file:///prepared.jpg', width: 512, height: 512 })
  })

  test('skips the crop when the picker did not report dimensions, but still resizes', async () => {
    await prepareAvatarImage('file:///picked.jpg', {})
    expect(calls.crop).toBeUndefined()
    expect(calls.resize).toEqual({ width: AVATAR_SIZE, height: AVATAR_SIZE })
  })
})

describe('uploadAvatar', () => {
  test('posts multipart to /api/me/avatar and returns the URL the server stored', async () => {
    let uploadUrl = ''
    let uploadInit: RequestInit | undefined
    mockFetch((url, init) => {
      uploadUrl = url
      uploadInit = init
      return jsonResponse(200, { ok: true, data: { image: '/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig' } })
    })

    const image = await uploadAvatar('file:///prepared.jpg')

    expect(image).toBe('/api/user-avatar/u1?k=abcdef0123456789.jpg&t=sig')
    expect(uploadUrl).toBe('https://api.test/api/me/avatar')
    expect(uploadInit?.method).toBe('POST')
    expect(uploadInit?.body).toBeInstanceOf(FormData)
    const part = (uploadInit!.body as FormData).get('file')
    expect(part).toBeTruthy()
  })

  test('surfaces the server\'s own message, not a generic failure', async () => {
    mockFetch(() => jsonResponse(400, {
      error: { code: 'file_too_large', message: 'Images must be 1 MB or smaller' },
    }))

    // Asserting on the server's sentence is the point: it is what tells someone
    // with a huge photo what to do about it.
    await expect(uploadAvatar('file:///prepared.jpg')).rejects.toThrow('Images must be 1 MB or smaller')
  })

  test('rejects rather than reporting success when the server returns no URL', async () => {
    mockFetch(() => jsonResponse(200, { ok: true, data: {} }))
    await expect(uploadAvatar('file:///prepared.jpg')).rejects.toThrow('did not return a picture URL')
  })
})

describe('removeAvatar', () => {
  test('sends a DELETE', async () => {
    let seen: RequestInit | undefined
    mockFetch((_url, init) => { seen = init; return jsonResponse(200, { ok: true, data: { image: null } }) })

    await removeAvatar()

    expect(seen?.method).toBe('DELETE')
  })

  test('throws the server message on failure', async () => {
    mockFetch(() => jsonResponse(401, { error: { code: 'unauthorized', message: 'Not authenticated' } }))
    await expect(removeAvatar()).rejects.toThrow('Not authenticated')
  })
})
