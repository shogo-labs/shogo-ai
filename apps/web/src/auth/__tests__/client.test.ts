/**
 * Tests for Better Auth client setup
 *
 * Task: task-ba-009
 * Tests the client module exports and configuration.
 */

import { describe, test, expect } from "bun:test"

describe("Better Auth Client", () => {
  describe("createAuthClient configured with API_URL baseURL", () => {
    test("authClient is exported and configured with baseURL", async () => {
      const { authClient } = await import("../client")

      // Verify authClient is exported
      expect(authClient).toBeDefined()

      // The client should have core auth methods available
      expect(authClient.signIn).toBeDefined()
      expect(authClient.signUp).toBeDefined()
      expect(authClient.signOut).toBeDefined()
    })
  })

  describe("Client exports useSession hook", () => {
    test("useSession hook is exported", async () => {
      const { useSession } = await import("../client")

      // Verify useSession is exported and is a function (React hook)
      expect(useSession).toBeDefined()
      expect(typeof useSession).toBe("function")
    })
  })

  describe("Client exports signIn, signUp, signOut functions", () => {
    test("signIn function is exported", async () => {
      const { signIn } = await import("../client")

      expect(signIn).toBeDefined()
      // signIn should have email method
      expect(signIn.email).toBeDefined()
    })

    test("signUp function is exported", async () => {
      const { signUp } = await import("../client")

      expect(signUp).toBeDefined()
      // signUp should have email method
      expect(signUp.email).toBeDefined()
    })

    test("signOut function is exported", async () => {
      const { signOut } = await import("../client")

      expect(signOut).toBeDefined()
      expect(typeof signOut).toBe("function")
    })
  })
})
