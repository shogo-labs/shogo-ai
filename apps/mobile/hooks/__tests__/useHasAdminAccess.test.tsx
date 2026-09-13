import { resolve } from "node:path"
import { describe, expect, mock, test } from "bun:test"
import { renderHook, waitFor } from "@testing-library/react"

let http: object
const responses: Array<{ ok: boolean; data?: { role?: string; adminScopes?: string[] } }> = []

mock.module(resolve(import.meta.dir, "../../contexts/domain"), () => ({
  useDomainHttp: () => http,
}))

mock.module(resolve(import.meta.dir, "../../lib/api"), () => ({
  api: {
    getMe: mock(async () => responses.shift()),
  },
}))

const { useHasAdminAccess } = await import("../useHasAdminAccess")

describe("useHasAdminAccess", () => {
  test("resets access when the user changes to a non-admin", async () => {
    http = {}
    responses.push(
      { ok: true, data: { role: "super_admin" } },
      { ok: true, data: { role: "user", adminScopes: [] } },
    )

    const { result, rerender } = renderHook(
      ({ userId }: { userId: string | undefined }) => useHasAdminAccess(userId),
      { initialProps: { userId: "admin-user" } },
    )

    await waitFor(() => expect(result.current).toBe(true))

    rerender({ userId: "ordinary-user" })
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(false))
  })
})
