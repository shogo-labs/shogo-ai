/**
 * Screencast broadcaster — small in-process pub/sub keyed by AgentManager
 * instance id. Produces JPEG frames emitted by Chrome DevTools Protocol
 * `Page.startScreencast` inside the browser tool, and fans them out to SSE
 * subscribers (e.g. the mobile `LiveBrowserView`).
 *
 * The runtime process is single-tenant per project, so an in-memory map is
 * sufficient — no Redis / cross-process broadcast required.
 */

export interface ScreencastFrame {
  /** Base64-encoded JPEG payload (as emitted by CDP). */
  jpegBase64: string
  /** Wall-clock millis when the frame was published. */
  ts: number
  /** Device width in CSS pixels (from CDP frame metadata). */
  width: number
  /** Device height in CSS pixels (from CDP frame metadata). */
  height: number
}

type Listener = (frame: ScreencastFrame) => void

const listeners = new Map<string, Set<Listener>>()
const lastFrame = new Map<string, ScreencastFrame>()
// Per-instance frame counters so we can log the first frame and then every
// N-th frame without spamming the console.
const publishCounts = new Map<string, number>()

/** Publish a frame for `instanceId`. Stores it as the last frame and notifies listeners. */
export function publish(instanceId: string, frame: ScreencastFrame): void {
  if (!instanceId) return
  lastFrame.set(instanceId, frame)
  const ls = listeners.get(instanceId)
  const count = (publishCounts.get(instanceId) ?? 0) + 1
  publishCounts.set(instanceId, count)
  if (count === 1 || count % 60 === 0) {
    console.log(
      `[screencast] publish instanceId=${instanceId} frame#${count} ` +
      `subscribers=${ls?.size ?? 0} size=${frame.width}x${frame.height} ` +
      `bytes~${frame.jpegBase64.length}`,
    )
  }
  if (!ls) return
  for (const l of ls) {
    try {
      l(frame)
    } catch {
      // ignore listener errors so one bad client doesn't take down the channel
    }
  }
}

/** Subscribe to frames for `instanceId`. Returns an unsubscribe function. */
export function subscribe(instanceId: string, listener: Listener): () => void {
  let set = listeners.get(instanceId)
  if (!set) {
    set = new Set()
    listeners.set(instanceId, set)
  }
  set.add(listener)
  console.log(
    `[screencast] subscribe instanceId=${instanceId} subscribers=${set.size} ` +
    `lastFrame=${lastFrame.has(instanceId) ? 'yes' : 'no'}`,
  )
  return () => {
    const s = listeners.get(instanceId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) listeners.delete(instanceId)
    console.log(`[screencast] unsubscribe instanceId=${instanceId} subscribers=${s.size}`)
  }
}

/** Get the most recent frame for `instanceId`, if any. */
export function getLastFrame(instanceId: string): ScreencastFrame | undefined {
  return lastFrame.get(instanceId)
}

/** Whether any subscribers are currently attached to `instanceId`. */
export function hasSubscribers(instanceId: string): boolean {
  const s = listeners.get(instanceId)
  return !!s && s.size > 0
}

/** Drop all state for `instanceId` (last frame + any remaining listeners). */
export function dropChannel(instanceId: string): void {
  const had = listeners.has(instanceId) || lastFrame.has(instanceId)
  listeners.delete(instanceId)
  lastFrame.delete(instanceId)
  publishCounts.delete(instanceId)
  if (had) console.log(`[screencast] dropChannel instanceId=${instanceId}`)
}

/** Test-only: reset all state. */
export function __resetForTests(): void {
  listeners.clear()
  lastFrame.clear()
  publishCounts.clear()
}
