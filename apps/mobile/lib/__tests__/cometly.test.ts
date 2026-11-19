// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The web Cometly pixel (SHO-441).
 *
 * `Platform.OS` is a mutable object here so one file can prove both the web
 * behaviour and that native never touches `document`, `localStorage` or the
 * network. Nothing leaves the process: `window.comet` is a spy.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'

const platform = { OS: 'web' as string }
mock.module('react-native', () => ({ Platform: platform }))

const {
  loadCometlyPixel,
  readCometToken,
  storeCometToken,
  clearCometTokenCookie,
  markNewSignup,
  consumeNewSignupEvent,
  COMETLY_SCRIPT_SRC,
  COMET_TOKEN_COOKIE,
  NEW_SIGNUP_FLAG_KEY,
} = await import('../cometly')

function cometScripts(): NodeListOf<HTMLScriptElement> {
  return document.querySelectorAll('script[data-cometly]')
}

function clearCookies(): void {
  for (const part of document.cookie.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`
  }
}

let cometCalls: string[] = []
/**
 * happy-dom only exposes `name=value` through `document.cookie`, so record the
 * raw strings we assign: the attributes (Max-Age, Path, SameSite) are the point
 * of these tests.
 */
let cookieWrites: string[] = []
const cookieAccessor = (() => {
  let owner: any = document
  while (owner) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, 'cookie')
    if (descriptor?.get && descriptor.set) return { owner, descriptor }
    owner = Object.getPrototypeOf(owner)
  }
  return null
})()
if (cookieAccessor) {
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    get() {
      return cookieAccessor.descriptor.get!.call(document)
    },
    set(value: string) {
      cookieWrites.push(String(value))
      cookieAccessor.descriptor.set!.call(document, value)
    },
  })
}

beforeEach(() => {
  platform.OS = 'web'
  // happy-dom does not fetch external scripts and reports that as an error;
  // treat a blocked tag as loaded so these tests observe the loader's DOM work,
  // not the sandbox's network policy.
  const happyDOM = (window as unknown as { happyDOM?: { settings?: Record<string, unknown> } })
    .happyDOM
  if (happyDOM?.settings) happyDOM.settings.handleDisabledFileLoadingAsSuccess = true
  for (const script of Array.from(cometScripts())) script.remove()
  clearCookies()
  cookieWrites = []
  window.localStorage.clear()
  cometCalls = []
  window.comet = (name: string) => {
    cometCalls.push(name)
  }
  window.cometToken = () => 'tok_abc'
})

afterEach(() => {
  delete window.comet
  delete window.cometToken
})

describe('loadCometlyPixel', () => {
  test('adds the site tag to <head> exactly once', () => {
    expect(loadCometlyPixel()).toBe(true)
    expect(loadCometlyPixel()).toBe(false)

    expect(cometScripts()).toHaveLength(1)
    expect(cometScripts()[0]!.src).toBe(COMETLY_SCRIPT_SRC)
    expect(cometScripts()[0]!.async).toBe(true)
  })

  test('native never loads it', () => {
    platform.OS = 'ios'
    expect(loadCometlyPixel()).toBe(false)
    expect(cometScripts()).toHaveLength(0)
  })
})

describe('comet token', () => {
  test('reads the token the pixel minted', () => {
    expect(readCometToken()).toBe('tok_abc')
    window.cometToken = () => '   '
    expect(readCometToken()).toBeNull()
    window.cometToken = () => {
      throw new Error('pixel blew up')
    }
    expect(readCometToken()).toBeNull()
  })

  test('a blocked pixel yields no token and no error', () => {
    delete window.cometToken
    expect(readCometToken()).toBeNull()
    // `window.cometToken` still absent: storing nothing is a no-op.
    storeCometToken('')
    expect(cookieWrites).toHaveLength(0)
  })

  test('parking it sets a 30 minute, path-/, Lax first-party cookie', () => {
    storeCometToken('tok abc/withmore')
    expect(cookieWrites).toHaveLength(1)
    const cookie = cookieWrites[0]!
    expect(cookie.startsWith(`${COMET_TOKEN_COOKIE}=${encodeURIComponent('tok abc/withmore')}`)).toBe(
      true,
    )
    expect(cookie).toContain('Max-Age=1800')
    expect(cookie).toContain('Path=/')
    expect(cookie).toMatch(/SameSite=Lax/i)
  })

  test('clearing it expires the cookie', () => {
    storeCometToken('tok_abc')
    cookieWrites = []
    clearCometTokenCookie()

    expect(cookieWrites).toHaveLength(1)
    expect(cookieWrites[0]).toContain(`${COMET_TOKEN_COOKIE}=`)
    expect(cookieWrites[0]).toContain('Max-Age=0')
    expect(document.cookie).not.toContain('tok_abc')
  })

  test('native writes nothing', () => {
    platform.OS = 'android'
    storeCometToken('tok_abc')
    clearCometTokenCookie()
    expect(cookieWrites).toHaveLength(0)
  })
})

describe('custom_event_2', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5))

  test('fires once, shortly after the first authenticated page', async () => {
    markNewSignup()
    expect(window.localStorage.getItem(NEW_SIGNUP_FLAG_KEY)).not.toBeNull()

    expect(consumeNewSignupEvent(Date.now(), 0)).toBe(true)
    await flush()

    expect(cometCalls).toEqual(['custom_event_2'])
    // The flag is gone, so a second page load reports nothing.
    expect(window.localStorage.getItem(NEW_SIGNUP_FLAG_KEY)).toBeNull()
    expect(consumeNewSignupEvent(Date.now(), 0)).toBe(false)
    await flush()
    expect(cometCalls).toEqual(['custom_event_2'])
  })

  test('loads the pixel on that page, since app routes do not have it', async () => {
    markNewSignup()
    consumeNewSignupEvent(Date.now(), 0)
    await flush()

    expect(cometScripts()).toHaveLength(1)
    expect(cometCalls).toEqual(['custom_event_2'])
  })

  test('a normal login has no flag and never fires', async () => {
    expect(consumeNewSignupEvent(Date.now(), 0)).toBe(false)
    await flush()

    expect(cometCalls).toEqual([])
    expect(cometScripts()).toHaveLength(0)
  })

  test('a flag older than a day is dropped silently', async () => {
    const dayAndABit = 25 * 60 * 60 * 1000
    markNewSignup(Date.now() - dayAndABit)

    expect(consumeNewSignupEvent(Date.now(), 0)).toBe(false)
    await flush()

    expect(cometCalls).toEqual([])
    expect(window.localStorage.getItem(NEW_SIGNUP_FLAG_KEY)).toBeNull()
  })

  test('native never marks or fires', async () => {
    platform.OS = 'ios'
    markNewSignup()
    expect(consumeNewSignupEvent(Date.now(), 0)).toBe(false)
    await flush()

    expect(cometCalls).toEqual([])
  })
})
