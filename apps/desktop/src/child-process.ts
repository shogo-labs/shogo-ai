// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `node:child_process` with `windowsHide: true` filled in whenever the caller
 * doesn't set it. Twin of `packages/shared-runtime/src/child-process.ts` —
 * keep the implementation identical. This package can't depend on
 * `@shogo/shared-runtime` (published, and a different license).
 *
 * Shogo's desktop shell is a GUI process. On Windows, spawning a console
 * program (`git.exe`, `cmd.exe`, `npm.cmd`, …) from a GUI process opens a
 * visible console window unless `windowsHide` is set. The flag is a no-op
 * on macOS and Linux. An explicit `windowsHide` (including `false`) is left
 * untouched, and the caller's options object is not mutated.
 */
import * as cp from 'node:child_process'
import { promisify } from 'node:util'

type Options = Record<string, unknown>

function isOptions(value: unknown): value is Options {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Keep an explicit `windowsHide`. Otherwise return a shallow copy with it set. */
function mergeHide(opts: Options): Options {
  if (opts.windowsHide !== undefined) return opts
  return { ...opts, windowsHide: true }
}

/** `exec` / `execSync`: `(command, options?, callback?)`. No argv array. */
function hideExecArgs(args: unknown[]): unknown[] {
  const out = args.slice()
  const slot = out[1]
  if (out.length < 2 || typeof slot === 'function') {
    out.splice(1, 0, { windowsHide: true })
    return out
  }
  if (slot == null) {
    out[1] = { windowsHide: true }
    return out
  }
  if (isOptions(slot)) {
    out[1] = mergeHide(slot)
    return out
  }
  return out
}

/**
 * `spawn`, `spawnSync`, `execFile`, `execFileSync`, `fork`:
 * `(file, args?, options?, callback?)`. A `null` argv is preserved.
 */
function hideSpawnArgs(args: unknown[]): unknown[] {
  const out = args.slice()
  let callbackAt = -1
  for (let i = 1; i < out.length; i++) {
    if (typeof out[i] === 'function') {
      callbackAt = i
      break
    }
  }
  const end = callbackAt === -1 ? out.length : callbackAt
  for (let i = 1; i < end; i++) {
    if (isOptions(out[i])) {
      out[i] = mergeHide(out[i] as Options)
      return out
    }
  }
  // Options follow argv when argv (array or null) was passed. Fill an empty
  // `undefined` / `null` slot in place: inserting after it would push a
  // trailing callback out of position, or land where Node ignores it.
  const slot = end > 1 && (Array.isArray(out[1]) || out[1] == null) ? 2 : 1
  if (slot >= end) out.splice(end, 0, { windowsHide: true })
  else if (out[slot] == null) out[slot] = { windowsHide: true }
  return out
}

const customPromisify = promisify.custom

function wrap<T extends (...args: any[]) => any>(
  hide: (args: unknown[]) => unknown[],
  getFn: () => T,
): T {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    const fn = getFn()
    return Reflect.apply(fn, this, hide(args))
  }
  // `util.promisify(exec)` returns this instead of guessing a callback slot.
  // Delegate to the underlying custom so Node's encoding overloads stay intact,
  // and read it at call time so tests that mock `child_process` are honored.
  Object.defineProperty(wrapped, customPromisify, {
    enumerable: false,
    configurable: true,
    writable: false,
    value(this: unknown, ...args: unknown[]) {
      const fn = getFn() as T & { [customPromisify]?: (...a: unknown[]) => unknown }
      const custom = fn[customPromisify]
      if (typeof custom === 'function') return Reflect.apply(custom, fn, hide(args))
      const promisified = promisify(fn as (...a: never[]) => unknown)
      return Reflect.apply(promisified, this, hide(args))
    },
  })
  return wrapped as T
}

export const spawn: typeof cp.spawn = wrap(hideSpawnArgs, () => cp.spawn)
export const spawnSync: typeof cp.spawnSync = wrap(hideSpawnArgs, () => cp.spawnSync)
export const exec: typeof cp.exec = wrap(hideExecArgs, () => cp.exec)
export const execSync: typeof cp.execSync = wrap(hideExecArgs, () => cp.execSync)
export const execFile: typeof cp.execFile = wrap(hideSpawnArgs, () => cp.execFile)
export const execFileSync: typeof cp.execFileSync = wrap(hideSpawnArgs, () => cp.execFileSync)
export const fork: typeof cp.fork = wrap(hideSpawnArgs, () => cp.fork)

export type * from 'node:child_process'
