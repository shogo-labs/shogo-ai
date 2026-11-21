// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483: a keychain that cannot be read made SecureStore's synchronous read
 * throw out of every authenticated request (Sentry SHOGO-IOS-Y,
 * `getValueWithKeySync` failed, from getAgentImageSource).
 *
 * Run: cd apps/mobile && bun test lib/__tests__/auth-client-secure-store.test.ts
 */
import { describe, expect, test } from "bun:test"
import { tolerantSecureStore } from "../auth-client"

const locked = {
  getItem: (_key: string): string | null => {
    throw new Error("FunctionCallException: Calling the 'getValueWithKeySync' function has failed")
  },
  setItem: (_key: string, _value: string): void => {
    throw new Error("FunctionCallException: Calling the 'setValueWithKeySync' function has failed")
  },
}

describe("tolerantSecureStore", () => {
  test("a locked keychain reads as no cookie instead of throwing", () => {
    const store = tolerantSecureStore(locked)
    expect(() => store.getItem("shogo_cookie")).not.toThrow()
    expect(store.getItem("shogo_cookie")).toBeNull()
    expect(() => store.setItem("shogo_cookie", "{}")).not.toThrow()
  })

  test("a readable keychain passes values through", () => {
    const map = new Map<string, string>()
    const store = tolerantSecureStore({
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => void map.set(key, value),
    })
    store.setItem("shogo_cookie", '{"a":1}')
    expect(store.getItem("shogo_cookie")).toBe('{"a":1}')
  })
})
