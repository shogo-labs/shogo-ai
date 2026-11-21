// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * SHO-483: `(err as Error).message` inside a `.catch` threw on a native
 * rejection with no value (react-native-callkeep `setup()` on Android),
 * producing the launch-time unhandled rejection "Cannot read property
 * 'message' of undefined" (Sentry SHOGO-ANDROID-11, symbolicated to
 * lib/native-call.native.ts:265 by rebuilding a03fde0's Hermes bundle).
 *
 * Run: cd apps/mobile && bun test lib/__tests__/error-message.test.ts
 */
import { describe, expect, test } from "bun:test"
import { errorMessage } from "../error-message"

describe("errorMessage", () => {
  test("a rejection with no value is described instead of throwing", () => {
    expect(() => errorMessage(undefined)).not.toThrow()
    expect(errorMessage(undefined)).toBe("no error details")
    expect(errorMessage(null)).toBe("no error details")
  })

  test("the catch handler pattern no longer turns into an unhandled rejection", async () => {
    const logged: string[] = []
    // The shape of the CallKeep setup call: a native promise that rejects bare.
    await Promise.reject(undefined).catch((err: unknown) => logged.push(errorMessage(err)))
    expect(logged).toEqual(["no error details"])
  })

  test("errors, strings and message-bearing objects keep their text", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom")
    expect(errorMessage("plain")).toBe("plain")
    expect(errorMessage({ message: "from native", code: "E_X" })).toBe("from native")
    expect(errorMessage({ code: 7 })).toBe('{"code":7}')
  })
})
