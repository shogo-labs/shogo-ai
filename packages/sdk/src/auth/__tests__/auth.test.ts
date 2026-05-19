// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Tests for ShogoAuth.
 *
 *   bun test packages/sdk/src/auth/__tests__/auth.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { ShogoAuth } from '../index'
import { AuthError } from '../../errors'
import type { StorageAdapter, ShogoUser, AuthTokens } from '../../types'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class MemoryStorage implements StorageAdapter {
  store = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async removeItem(key: string): Promise<void> {
    this.store.delete(key)
  }
  async clear(): Promise<void> {
    this.store.clear()
  }
}

class ThrowingStorage implements StorageAdapter {
  async getItem(): Promise<string | null> {
    throw new Error('boom')
  }
  async setItem(): Promise<void> {}
  async removeItem(): Promise<void> {}
}

interface MockResp<T> {
  data: T
}

class MockHttp {
  authRequestCalls: Array<{ endpoint: string; options: any }> = []
  authRequestImpl: ((endpoint: string, options: any) => Promise<MockResp<any>>) | null = null
  resetCalls = 0
  authUrlBase = 'https://api.example.com/api/auth'

  authRequest<T>(endpoint: string, options: any = {}): Promise<MockResp<T>> {
    this.authRequestCalls.push({ endpoint, options })
    if (!this.authRequestImpl) {
      return Promise.resolve({ data: {} as T })
    }
    return this.authRequestImpl(endpoint, options)
  }
  getAuthUrl(endpoint: string): string {
    return `${this.authUrlBase}${endpoint}`
  }
  resetMcpSession(): void {
    this.resetCalls++
  }
}

const user1: ShogoUser = { id: 'u1', email: 'a@b.com', name: 'A' } as any

function makeAuth(opts: { storage?: StorageAdapter; http?: MockHttp; config?: any } = {}) {
  const storage = opts.storage ?? new MemoryStorage()
  const http = opts.http ?? new MockHttp()
  const auth = new ShogoAuth(http as any, storage, opts.config ?? {})
  return { auth, http, storage }
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

describe('ShogoAuth: initialization', () => {
  test('starts unauthenticated when storage is empty', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(false)
    expect(auth.currentUser()).toBeNull()
    expect(auth.getToken()).toBeNull()
    expect(await auth.getSession()).toBeNull()
    const s = auth.getState()
    expect(s.isLoading).toBe(false)
    expect(s.user).toBeNull()
  })

  test('restores session from storage when tokens not expired', async () => {
    const storage = new MemoryStorage()
    const tokens: AuthTokens = { accessToken: 'tok-abc', expiresAt: Date.now() + 60_000 } as any
    storage.store.set('auth_tokens', JSON.stringify(tokens))
    storage.store.set('auth_user', JSON.stringify(user1))

    const { auth } = makeAuth({ storage })
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(true)
    expect(auth.getToken()).toBe('tok-abc')
    expect(auth.currentUser()?.id).toBe('u1')
    const sess = await auth.getSession()
    expect(sess?.token).toBe('tok-abc')
  })

  test('treats no-expiry token as valid', async () => {
    const storage = new MemoryStorage()
    storage.store.set('auth_tokens', JSON.stringify({ accessToken: 'tok' }))
    storage.store.set('auth_user', JSON.stringify(user1))
    const { auth } = makeAuth({ storage })
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(true)
  })

  test('clears expired tokens during init', async () => {
    const storage = new MemoryStorage()
    storage.store.set(
      'auth_tokens',
      JSON.stringify({ accessToken: 'old', expiresAt: Date.now() - 1000 })
    )
    storage.store.set('auth_user', JSON.stringify(user1))
    const http = new MockHttp()
    const { auth } = makeAuth({ storage, http })
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(false)
    expect(storage.store.has('auth_tokens')).toBe(false)
    expect(storage.store.has('auth_user')).toBe(false)
    expect(http.resetCalls).toBe(1)
  })

  test('survives storage read failure', async () => {
    const { auth } = makeAuth({ storage: new ThrowingStorage() })
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(false)
    expect(auth.getState().isLoading).toBe(false)
  })

  test('ready() is a no-op after first call', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    await auth.ready()
    expect(auth.isAuthenticated()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// State / listeners
// ---------------------------------------------------------------------------

describe('ShogoAuth: state listeners', () => {
  test('onAuthStateChanged fires immediately and on updates, unsubscribe works', async () => {
    const { auth, http } = makeAuth()
    await auth.ready()
    const events: boolean[] = []
    const unsub = auth.onAuthStateChanged((s) => events.push(s.isAuthenticated))
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events[0]).toBe(false)

    http.authRequestImpl = async () => ({ data: { user: user1, token: 't1', expiresIn: 60 } })
    await auth.signIn({ email: 'a@b.com', password: 'pw' })
    expect(events[events.length - 1]).toBe(true)

    unsub()
    const before = events.length
    await auth.signOut()
    expect(events.length).toBe(before)
  })

  test('listener errors during state updates are swallowed', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({ data: { user: user1, token: 't1' } })
    const { auth } = makeAuth({ http })
    await auth.ready()
    let firstCalls = 0
    let secondCalls = 0
    auth.onAuthStateChanged(() => {
      firstCalls++
      if (firstCalls > 1) throw new Error('listener fail')
    })
    auth.onAuthStateChanged(() => {
      secondCalls++
    })
    await auth.signIn({ email: 'a@b.com', password: 'pw' })
    expect(firstCalls).toBeGreaterThan(1)
    expect(secondCalls).toBeGreaterThan(1)
  })

  test('getState returns a copy', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    const s = auth.getState()
    s.isAuthenticated = true
    expect(auth.isAuthenticated()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// signUp / signIn
// ---------------------------------------------------------------------------

describe('ShogoAuth: signUp', () => {
  test('signUp success persists tokens, user and updates state', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({
      data: { user: user1, token: 'tk', expiresIn: 3600 },
    })
    const { auth, storage } = makeAuth({ http })
    await auth.ready()
    const result = await auth.signUp({
      email: 'a@b.com',
      password: 'pw',
      name: 'A',
      metadata: { invite: 'x' },
    } as any)
    expect(result.id).toBe('u1')
    expect(auth.isAuthenticated()).toBe(true)
    expect(auth.getToken()).toBe('tk')
    const call = http.authRequestCalls[0]
    expect(call.endpoint).toBe('/sign-up/email')
    expect(call.options.method).toBe('POST')
    expect(call.options.body.email).toBe('a@b.com')
    expect(call.options.body.invite).toBe('x')
    const stored = JSON.parse((storage as MemoryStorage).store.get('auth_tokens')!)
    expect(stored.accessToken).toBe('tk')
    expect(typeof stored.expiresAt).toBe('number')
  })

  test('signUp rethrows AuthError untouched', async () => {
    const http = new MockHttp()
    const err = new AuthError('nope', 'AUTH_USER_EXISTS')
    http.authRequestImpl = async () => {
      throw err
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    await expect(
      auth.signUp({ email: 'a@b.com', password: 'pw' } as any)
    ).rejects.toBe(err)
    expect(auth.getState().isLoading).toBe(false)
  })

  test('signUp wraps generic Error in AuthError', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => {
      throw new Error('network down')
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    try {
      await auth.signUp({ email: 'a@b.com', password: 'pw' } as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError)
      expect(e.message).toBe('network down')
      expect(e.code).toBe('UNKNOWN')
    }
  })

  test('signUp wraps non-Error throwable', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => {
      throw 'string-err'
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    try {
      await auth.signUp({ email: 'a@b.com', password: 'pw' } as any)
      throw new Error('should have thrown')
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError)
      expect(e.message).toBe('Sign up failed')
    }
  })
})

describe('ShogoAuth: signIn', () => {
  test('signIn success', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({
      data: { user: user1, token: 'tk' },
    })
    const { auth } = makeAuth({ http })
    await auth.ready()
    const u = await auth.signIn({ email: 'a@b.com', password: 'pw' })
    expect(u.id).toBe('u1')
    expect(http.authRequestCalls[0].endpoint).toBe('/sign-in/email')
    expect(http.authRequestCalls[0].options.body).toEqual({
      email: 'a@b.com',
      password: 'pw',
    })
  })

  test('signIn rethrows AuthError', async () => {
    const http = new MockHttp()
    const e = AuthError.userExists('a@b.com')
    http.authRequestImpl = async () => {
      throw e
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    await expect(
      auth.signIn({ email: 'a@b.com', password: 'pw' })
    ).rejects.toBe(e)
  })

  test('signIn maps generic errors to invalidCredentials', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => {
      throw new Error('500')
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    try {
      await auth.signIn({ email: 'a@b.com', password: 'pw' })
      throw new Error('should fail')
    } catch (e: any) {
      expect(e).toBeInstanceOf(AuthError)
      expect(e.code).toBe('AUTH_INVALID_CREDENTIALS')
    }
  })
})

// ---------------------------------------------------------------------------
// OAuth / provider redirects
// ---------------------------------------------------------------------------

describe('ShogoAuth: provider sign-in', () => {
  const origWindow = (globalThis as any).window
  beforeEach(() => {
    ;(globalThis as any).window = {
      location: { href: 'https://app.test/page', origin: 'https://app.test' },
    }
  })
  afterEach(() => {
    if (origWindow === undefined) delete (globalThis as any).window
    else (globalThis as any).window = origWindow
  })

  test('signInWithProvider builds URL with callbackURL and assigns location.href', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    await auth.signInWithProvider('google' as any)
    const href = (globalThis as any).window.location.href as string
    expect(href).toContain('/sign-in/google')
    expect(href).toContain('callbackURL=')
    expect(decodeURIComponent(href)).toContain('https://app.test/page')
  })

  test('uses config.redirectUrl when provided', async () => {
    const { auth } = makeAuth({ config: { redirectUrl: 'https://app.test/done' } })
    await auth.ready()
    await auth.signInWithGoogle()
    const href = (globalThis as any).window.location.href as string
    expect(decodeURIComponent(href)).toContain('https://app.test/done')
  })

  test('helper methods route to correct provider', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    await auth.signInWithGitHub()
    expect((globalThis as any).window.location.href).toContain('/sign-in/github')
    await auth.signInWithApple()
    expect((globalThis as any).window.location.href).toContain('/sign-in/apple')
    await auth.signInWithMicrosoft()
    expect((globalThis as any).window.location.href).toContain('/sign-in/microsoft')
  })

  test('falls back to "/" when no redirect available', async () => {
    ;(globalThis as any).window = {
      location: { origin: 'https://app.test' },
    }
    const { auth } = makeAuth()
    await auth.ready()
    await auth.signInWithProvider('google' as any)
    const href = (globalThis as any).window.location.href as string
    expect(decodeURIComponent(href)).toContain('callbackURL=/')
  })
})

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

describe('ShogoAuth: signOut', () => {
  test('signOut clears state and storage', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({ data: { user: user1, token: 'tk' } })
    const { auth, storage } = makeAuth({ http })
    await auth.ready()
    await auth.signIn({ email: 'a@b.com', password: 'pw' })
    expect(auth.isAuthenticated()).toBe(true)

    http.authRequestImpl = async () => ({ data: {} })
    await auth.signOut()

    expect(auth.isAuthenticated()).toBe(false)
    expect(auth.getToken()).toBeNull()
    expect((storage as MemoryStorage).store.has('auth_tokens')).toBe(false)
    expect(http.resetCalls).toBeGreaterThanOrEqual(1)
    expect(http.authRequestCalls[http.authRequestCalls.length - 1].endpoint).toBe(
      '/sign-out'
    )
  })

  test('signOut still clears local state even if server fails', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({ data: { user: user1, token: 'tk' } })
    const { auth } = makeAuth({ http })
    await auth.ready()
    await auth.signIn({ email: 'a@b.com', password: 'pw' })

    http.authRequestImpl = async () => {
      throw new Error('server unreachable')
    }
    await auth.signOut()
    expect(auth.isAuthenticated()).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// setSession / fetchCurrentUser / me / updateProfile
// ---------------------------------------------------------------------------

describe('ShogoAuth: setSession', () => {
  test('setSession with user uses given user', async () => {
    const http = new MockHttp()
    const { auth, storage } = makeAuth({ http })
    await auth.ready()
    const u = await auth.setSession({ accessToken: 'tk', expiresIn: 10 } as any, user1)
    expect(u.id).toBe('u1')
    expect(auth.getToken()).toBe('tk')
    expect((storage as MemoryStorage).store.get('auth_user')).toBeTruthy()
    expect(http.authRequestCalls.length).toBe(0)
  })

  test('setSession without user fetches from /session with Bearer header', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async (endpoint, opts) => {
      expect(endpoint).toBe('/session')
      expect(opts.headers.Authorization).toBe('Bearer tk')
      return { data: { user: user1 } }
    }
    const { auth } = makeAuth({ http })
    await auth.ready()
    const u = await auth.setSession({ accessToken: 'tk' } as any)
    expect(u.id).toBe('u1')
  })
})

describe('ShogoAuth: me', () => {
  test('me throws when not authenticated', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    await expect(auth.me()).rejects.toBeInstanceOf(AuthError)
  })

  test('me fetches /session with empty headers map', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({
      data: { user: user1, token: 'tk' },
    })
    const { auth } = makeAuth({ http })
    await auth.ready()
    await auth.signIn({ email: 'a@b.com', password: 'pw' })

    http.authRequestImpl = async (endpoint, opts) => {
      expect(endpoint).toBe('/session')
      expect(opts.headers).toEqual({})
      return { data: { user: { ...user1, name: 'Updated' } } }
    }
    const u = await auth.me()
    expect(u.name).toBe('Updated')
  })
})

describe('ShogoAuth: updateProfile', () => {
  test('updateProfile throws when not authenticated', async () => {
    const { auth } = makeAuth()
    await auth.ready()
    await expect(auth.updateProfile({ name: 'X' } as any)).rejects.toBeInstanceOf(AuthError)
  })

  test('updateProfile persists and updates session', async () => {
    const http = new MockHttp()
    http.authRequestImpl = async () => ({ data: { user: user1, token: 'tk' } })
    const { auth, storage } = makeAuth({ http })
    await auth.ready()
    await auth.signIn({ email: 'a@b.com', password: 'pw' })

    const updated = { ...user1, name: 'Renamed' }
    http.authRequestImpl = async (endpoint, opts) => {
      expect(endpoint).toBe('/update-user')
      expect(opts.method).toBe('POST')
      expect(opts.body).toEqual({ name: 'Renamed' })
      return { data: { user: updated } }
    }
    const u = await auth.updateProfile({ name: 'Renamed' } as any)
    expect(u.name).toBe('Renamed')
    expect(auth.currentUser()?.name).toBe('Renamed')
    const sess = await auth.getSession()
    expect(sess?.user.name).toBe('Renamed')
    const persisted = JSON.parse((storage as MemoryStorage).store.get('auth_user')!)
    expect(persisted.name).toBe('Renamed')
  })
})
