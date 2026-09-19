import { describe, expect, test } from "bun:test"
import {
  runResumeStreamSingleFlight,
  type ResumeStreamFlightRef,
} from "../resume-stream-single-flight"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe("runResumeStreamSingleFlight", () => {
  test("reuses an in-flight resume for the same session", async () => {
    const ref: ResumeStreamFlightRef<void> = { current: null }
    const first = deferred<void>()
    let calls = 0
    const resume = () => {
      calls += 1
      return first.promise
    }

    const firstRun = runResumeStreamSingleFlight(ref, "session-1", resume)
    const secondRun = runResumeStreamSingleFlight(ref, "session-1", resume)

    expect(secondRun).toBe(firstRun)
    await Promise.resolve()
    expect(calls).toBe(1)

    first.resolve()
    await firstRun
    expect(ref.current).toBeNull()
  })

  test("allows a different session while the previous session is finishing", async () => {
    const ref: ResumeStreamFlightRef<void> = { current: null }
    const first = deferred<void>()
    const second = deferred<void>()
    let calls = 0
    const resume = () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    }

    const firstRun = runResumeStreamSingleFlight(ref, "session-1", resume)
    const secondRun = runResumeStreamSingleFlight(ref, "session-2", resume)

    expect(secondRun).not.toBe(firstRun)
    await Promise.resolve()
    expect(calls).toBe(2)

    first.resolve()
    await firstRun
    expect(ref.current?.sessionId).toBe("session-2")

    second.resolve()
    await secondRun
    expect(ref.current).toBeNull()
  })

  test("clears a rejected resume so the session can retry", async () => {
    const ref: ResumeStreamFlightRef<void> = { current: null }
    let calls = 0
    const resume = () => {
      calls += 1
      return calls === 1 ? Promise.reject(new Error("disconnected")) : Promise.resolve()
    }

    await expect(runResumeStreamSingleFlight(ref, "session-1", resume)).rejects.toThrow(
      "disconnected",
    )
    expect(ref.current).toBeNull()

    await runResumeStreamSingleFlight(ref, "session-1", resume)
    expect(calls).toBe(2)
  })
})
