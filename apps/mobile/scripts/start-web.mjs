#!/usr/bin/env node
/**
 * Wrapper around `expo start --web` that opts the Windows dev box out of
 * Metro's lazy bundling by setting `EXPO_NO_METRO_LAZY=1` before Expo CLI
 * starts.
 *
 * Why: Metro's `lazy=true` mode (the default in dev) ships only the entry
 * module up front and then issues a separate HTTP GET per additional
 * module as the route graph evaluates. Per-module resolution involves
 * multiple `fs.stat` calls walking `package.json#exports` / source-ext
 * fallbacks, and on Windows + NTFS + Defender each stat is ~1-3ms vs
 * ~0.1ms on macOS/Linux. With ~thousands of modules in the project
 * graph this turns into a 60+ second gap between clicking a route and
 * the route layout rendering (confirmed by the `[cold-start]` trace in
 * `apps/mobile/lib/cold-start-timing.ts`).
 *
 * Disabling lazy on Windows costs ~3-5s of additional up-front compile
 * in `Web Bundled` but eliminates the per-route fetch storm entirely.
 * macOS/Linux keep the default lazy behavior — the per-module overhead
 * is small enough there that the trade-off goes the other way.
 *
 * Override knob: set `SHOGO_FORCE_METRO_LAZY=1` to opt back into lazy
 * bundling on Windows (useful if a future Metro/Expo release fixes the
 * per-stat cost or for benchmarking).
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const mobileRoot = resolve(here, '..')

const env = { ...process.env }
const forceLazy = env.SHOGO_FORCE_METRO_LAZY === '1' || env.SHOGO_FORCE_METRO_LAZY === 'true'
if (process.platform === 'win32' && !forceLazy && !env.EXPO_NO_METRO_LAZY) {
  env.EXPO_NO_METRO_LAZY = '1'
  console.log('[start-web] Windows detected — setting EXPO_NO_METRO_LAZY=1 (disable Metro lazy bundling).')
  console.log('[start-web] Override with SHOGO_FORCE_METRO_LAZY=1 to restore lazy bundling.')
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ shell?: boolean }} [opts]
 */
function run(cmd, args, opts = {}) {
  return new Promise((resolveProm, reject) => {
    // `shell: true` is only safe when the command name is shell-safe
    // (no spaces). `process.execPath` on Windows is typically
    // `C:\Program Files\nodejs\node.exe`, which the shell splits on
    // the space and tries to run `C:\Program`. For Node we spawn
    // directly. For `npx` / `expo` we go through the shell so PATHEXT
    // can resolve `.cmd` / `.bat` shims on Windows.
    const useShell = opts.shell ?? false
    const child = spawn(cmd, args, {
      cwd: mobileRoot,
      stdio: 'inherit',
      env,
      shell: useShell,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      if (code === 0) resolveProm()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

try {
  await run(process.execPath, ['scripts/copy-monaco-vs.mjs'])
  await run('npx', ['expo', 'start', '--web'], { shell: process.platform === 'win32' })
} catch (err) {
  console.error('[start-web]', err?.message ?? err)
  process.exit(1)
}
