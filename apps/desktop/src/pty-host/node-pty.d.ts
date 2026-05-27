// Minimal local type stub for `node-pty`. Replaces @types/node-pty until
// `npm install` is run inside apps/desktop (Phase 2 prerequisite — see
// plan v2 § 0 notes). Only covers the surface we actually call.
//
// Once node-pty is installed, this file becomes redundant — TS will prefer
// the package's bundled types. Keep the stub anyway so editor/typecheck
// works pre-install for new contributors.

declare module 'node-pty' {
  export interface IPty {
    readonly pid: number
    readonly cols: number
    readonly rows: number
    onData(cb: (data: string) => void): { dispose(): void }
    onExit(cb: (e: { exitCode: number; signal?: number | undefined }) => void): { dispose(): void }
    write(data: string): void
    resize(cols: number, rows: number): void
    kill(signal?: string): void
  }

  export interface IPtyForkOptions {
    cwd?: string
    env?: Record<string, string | undefined>
    cols?: number
    rows?: number
    name?: string
    encoding?: string | null
    useConpty?: boolean
  }

  export function spawn(
    file: string,
    args: string[] | string,
    options?: IPtyForkOptions,
  ): IPty
}
