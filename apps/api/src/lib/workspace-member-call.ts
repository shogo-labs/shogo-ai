/**
 * How long a member mount/unmount keeps asking for a workspace runtime that is
 * still cold-booting. A single metal assign gives up after ~30s while the host
 * carries on booting (20-60s is normal), so one attempt fails exactly the
 * mounts that would have succeeded a few seconds later.
 */
export const MEMBER_BOOT_WAIT_MS = 150_000
export const MEMBER_BOOT_POLL_MS = 3_000

/** We stopped waiting on the runtime, rather than it refusing us. */
export function isRuntimeStillStarting(err: unknown): boolean {
  const e = err as { name?: string; code?: string; cause?: { name?: string; code?: string } } | null
  const name = e?.name ?? e?.cause?.name
  const code = e?.code ?? e?.cause?.code
  return name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT'
}

/**
 * Keep resolving while the runtime is still starting, up to `waitMs`. Any
 * other failure, or the deadline, surfaces the last error.
 */
export async function resolveWhileStarting<T>(
  resolve: () => Promise<T>,
  opts: { waitMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? MEMBER_BOOT_WAIT_MS
  const pollMs = opts.pollMs ?? MEMBER_BOOT_POLL_MS
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  for (;;) {
    try {
      return await resolve()
    } catch (err) {
      if (!isRuntimeStillStarting(err) || now() - started >= waitMs) throw err
      await sleep(pollMs)
    }
  }
}

/**
 * Status + body for a failed member mount/unmount. Session misuse is the
 * caller's error (4xx, so agents don't retry it); a runtime still starting is
 * 503 with a message that says so.
 */
export function memberCallFailure(
  error: any,
  op: 'mount' | 'unmount',
): { status: 404 | 409 | 502 | 503; body: { error: string; code?: string } } {
  if (error?.name === 'WorkspaceSessionError' && typeof error.code === 'string') {
    return { status: error.code === 'session_not_found' ? 404 : 409, body: { error: error.message, code: error.code } }
  }
  if (isRuntimeStillStarting(error)) {
    return {
      status: 503,
      body: { error: 'The workspace runtime is still starting. Try again in a minute.', code: 'runtime_starting' },
    }
  }
  return { status: 502, body: { error: error?.message ?? `${op} failed` } }
}
