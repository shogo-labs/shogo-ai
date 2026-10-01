// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Per-platform shell for real-PTY tests.
 *
 * POSIX uses `/bin/sh -i` for a predictable prompt. Windows uses the same
 * PowerShell the runtime defaults to, driven through ConPTY (Bun >= 1.4).
 * ConPTY treats `\r` as Enter and re-encodes output as VT, so tests send
 * `line(...)` and match substrings rather than exact bytes.
 */

export const IS_WIN = process.platform === 'win32'

export const TEST_SHELL: string[] = IS_WIN
  ? ['powershell.exe', '-NoLogo', '-NoProfile']
  : ['/bin/sh', '-i']

export const EOL = IS_WIN ? '\r' : '\n'

export function line(cmd: string): string {
  return cmd + EOL
}

/** PowerShell starts in ~1s on a cold runner; /bin/sh in a few ms. */
export const SHELL_START_MS = IS_WIN ? 10_000 : 2_000

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Dispose `session` and remove its cwd. Windows keeps a process's cwd locked
 * until the process is gone, so wait for the shell to exit before `rm`.
 */
export async function disposeAndRemove(
  session: { dispose(): void; pid: number | null | undefined },
  dir: string,
): Promise<void> {
  const pid = session.pid
  session.dispose()
  if (pid) await waitUntil(() => !isPidAlive(pid), 10_000)
  const { rmSync } = await import('fs')
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 20) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}

/** Poll `predicate` until true or `timeoutMs` elapses (resolves either way). */
export async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const t0 = Date.now()
  while (!predicate() && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50))
  }
}
