import { describe, expect, it } from "bun:test"
import { seedNoticeWrite } from "../publish-notice"

describe("publish seed notice", () => {
  it("writes nothing when no seed ran, so a republish cannot erase an earlier report", () => {
    const decision = seedNoticeWrite({ seeded: false, orphans: [] })
    expect(decision.write).toBe(false)
    expect(decision.notice).toBeNull()
  })

  it("names every table and the total when a seed had to drop rows", () => {
    const decision = seedNoticeWrite({
      seeded: true,
      orphans: [
        { table: "stage_changes", count: 1918 },
        { table: "payments", count: 188 },
        { table: "reviews", count: 175 },
      ],
    })
    expect(decision.write).toBe(true)
    expect(decision.notice).toContain("2281 row(s)")
    expect(decision.notice).toContain("stage_changes (1918)")
    expect(decision.notice).toContain("payments (188)")
    expect(decision.notice).toContain("reviews (175)")
    expect(decision.notice).toContain("deleted records")
    expect(decision.notice).toContain("SQLite archive")
  })

  it("clears a stale notice when a later seed carried everything", () => {
    const decision = seedNoticeWrite({ seeded: true, orphans: [] })
    expect(decision.write).toBe(true)
    expect(decision.notice).toBeNull()
  })

  it("does not invent a report for a seed that ran with zero orphans", () => {
    const decision = seedNoticeWrite({ seeded: true, orphans: [{ table: "payments", count: 0 }] })
    expect(decision.write).toBe(true)
    expect(decision.notice).toBeNull()
  })
})
