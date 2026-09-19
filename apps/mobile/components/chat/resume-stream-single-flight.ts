export type ResumeStreamSessionId = string | null

export interface ResumeStreamFlight<T> {
  sessionId: ResumeStreamSessionId
  promise: Promise<T>
}

export interface ResumeStreamFlightRef<T> {
  current: ResumeStreamFlight<T> | null
}

/**
 * Start at most one resume request for a chat session at a time.
 *
 * The AI SDK Chat instance has one active response slot. Starting two
 * `resumeStream()` calls for the same session concurrently can make one
 * request clear that slot while the other request is still running, causing
 * its finish handler to read `activeResponse.state` from `undefined`.
 */
export function runResumeStreamSingleFlight<T>(
  ref: ResumeStreamFlightRef<T>,
  sessionId: ResumeStreamSessionId,
  resumeStream: () => Promise<T>,
): Promise<T> {
  const inFlight = ref.current
  if (inFlight?.sessionId === sessionId) {
    return inFlight.promise
  }

  // Queue the invocation in a microtask so the ref is populated before the
  // underlying function runs. A second caller in the same tick therefore
  // observes and reuses this promise as well.
  const promise = Promise.resolve().then(resumeStream)
  const entry: ResumeStreamFlight<T> = { sessionId, promise }
  ref.current = entry

  // Handle both outcomes without creating a new unhandled-rejection promise.
  const clearIfCurrent = () => {
    if (ref.current?.promise === promise) {
      ref.current = null
    }
  }
  void promise.then(clearIfCurrent, clearIfCurrent)

  return promise
}
