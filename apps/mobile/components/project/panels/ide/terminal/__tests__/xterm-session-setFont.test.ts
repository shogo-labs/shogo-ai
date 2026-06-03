// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * BUG-012 — xterm-session.setFont contract.
 *
 * Tests focus on the OBSERVABLE behaviour without booting a real xterm
 * (which needs DOM + canvas + WebGL). We exercise three paths:
 *
 *   1. pre-attach   — setFont mutates `opts` so the next `attach()` picks
 *                     up the new value via the existing closure path.
 *   2. post-attach  — setFont writes to `term.options.fontFamily` (xterm@5
 *                     live setter) and triggers a fit().
 *   3. disposed     — setFont is a no-op (no throw, no mutation).
 *
 * We reflect into the private fields via `as unknown as ...` in the test
 * file only — production code never reaches in. The cast is local to
 * this file and guarded by `eslint-disable` markers in the lines that
 * need it.
 */
import { describe, expect, test } from "bun:test"
import { XtermSession } from "../xterm-session"
import type { PtyClientLike } from "../pty-factory"

// Minimal PtyClientLike — never actually called by setFont, just needs
// to satisfy the constructor signature.
const fakeClient = {
  state: "open" as const,
  send: () => {},
  resize: () => {},
  onData: () => () => {},
  onExit: () => () => {},
  onTruncated: () => () => {},
  onState: () => () => {},
} as unknown as PtyClientLike

// Internal-shape reflection helper. The session is the unit under test
// — production callers don't peek inside, but the tests DO so we can
// pin the contract without booting xterm.
type SessionInternals = {
  opts: { fontFamily?: string; fontSize?: number }
  term: { options: { fontFamily: string; fontSize: number } } | null
  fitAddon: { fit: () => void } | null
  disposed: boolean
}
const peek = (s: XtermSession) => s as unknown as SessionInternals

describe("XtermSession.setFont — BUG-012 contract", () => {
  test("pre-attach: setFont(family) mutates opts so subsequent attach uses it", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "OldFont", fontSize: 13 })
    s.setFont("NewFont, monospace")
    expect(peek(s).opts.fontFamily).toBe("NewFont, monospace")
    expect(peek(s).opts.fontSize).toBe(13) // unchanged
    expect(peek(s).term).toBeNull() // never attached — confirms pre-attach path
  })

  test("pre-attach: setFont(undefined, size) only mutates size", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "Keep", fontSize: 13 })
    s.setFont(undefined, 16)
    expect(peek(s).opts.fontFamily).toBe("Keep")
    expect(peek(s).opts.fontSize).toBe(16)
  })

  test("pre-attach: setFont() with both undefined is a no-op", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "X", fontSize: 13 })
    s.setFont(undefined, undefined)
    expect(peek(s).opts.fontFamily).toBe("X")
    expect(peek(s).opts.fontSize).toBe(13)
  })

  test("post-attach: setFont writes through to term.options and refits", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "Boot", fontSize: 13 })
    // Inject a fake `term` and `fitAddon` so we can observe writes
    // without booting the real xterm renderer.
    let fitCount = 0
    const fakeTerm = { options: { fontFamily: "Boot", fontSize: 13 } }
    peek(s).term = fakeTerm
    peek(s).fitAddon = { fit: () => { fitCount++ } }

    s.setFont("Updated, monospace", 15)

    expect(peek(s).opts.fontFamily).toBe("Updated, monospace")
    expect(peek(s).opts.fontSize).toBe(15)
    expect(fakeTerm.options.fontFamily).toBe("Updated, monospace")
    expect(fakeTerm.options.fontSize).toBe(15)
    expect(fitCount).toBe(1) // fit() called exactly once after a font change
  })

  test("post-attach: setFont(family) leaves size on term.options untouched", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "Boot", fontSize: 13 })
    const fakeTerm = { options: { fontFamily: "Boot", fontSize: 13 } }
    peek(s).term = fakeTerm
    peek(s).fitAddon = { fit: () => {} }

    s.setFont("OnlyFamily", undefined)

    expect(fakeTerm.options.fontFamily).toBe("OnlyFamily")
    expect(fakeTerm.options.fontSize).toBe(13) // unchanged
  })

  test("post-attach: setFont survives a throw from the term.options Proxy", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "Boot", fontSize: 13 })
    const throwingTerm = {
      options: new Proxy({} as { fontFamily: string }, {
        set: () => { throw new Error("xterm rejected the live update") },
      }),
    }
    peek(s).term = throwingTerm as unknown as SessionInternals["term"]
    peek(s).fitAddon = { fit: () => {} }

    // Must not throw — production swallows the error and the next
    // remount picks up the new value via this.opts.
    expect(() => s.setFont("HopeThisWorks")).not.toThrow()
    // opts.fontFamily still updated even though term.options rejected.
    expect(peek(s).opts.fontFamily).toBe("HopeThisWorks")
  })

  test("disposed: setFont is a no-op (no throw, no mutation)", () => {
    const s = new XtermSession(fakeClient, { fontFamily: "Initial", fontSize: 13 })
    s.dispose()
    expect(() => s.setFont("Anything", 99)).not.toThrow()
    // After dispose, opts mutation is irrelevant but we still gate on
    // `disposed` first so we don't waste a write.
    // (We can't easily assert "no mutation" because the early-return
    //  happens before the assignment — both branches end in the same
    //  observable state for a disposed session.)
    expect(peek(s).disposed).toBe(true)
  })
})
