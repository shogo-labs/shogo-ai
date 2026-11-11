#!/usr/bin/env node
// Build the prebuilt Shogo IDE server (Code - OSS REH-web) for one target.
//
//   node scripts/build-code-oss-server.mjs --target win32-x64 [--work <dir>] [--out <dir>]
//        [--phase prepare,build,package,verify]
//
// prepare  clone the pinned commit (code-oss.lock.json), apply patches/code-oss,
//          brand product.json
// build    npm ci + gulp vscode-reh-web-<target>-min, drop Copilot, add shogo-core
// package  <artifactId>-<target>.tar.gz + .sha256 in --out
// verify   patch markers present, Copilot absent, server answers HTTP
//
// `prepare` runs with any Node; `build` needs the checkout's .nvmrc Node (CI
// installs it between the two phases). Used by .github/workflows/shogo-ide-server.yml
// and by developers iterating on patches (see apps/shogo-ide/README.md).

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SERVER_TARGETS, SHOGO_IDE_ROOT, assetFileName, computeArtifactId, readCodeOssLock } from './code-oss-artifact-id.mjs'

/** Longest relative path allowed inside the archive, so installs stay under Windows MAX_PATH. */
export const MAX_ARCHIVE_PATH = 160
/** Strings from patches/code-oss that must survive into the minified workbench. */
export const PATCH_MARKERS = ['shogo-chat-drop-active', 'shogo.context.addUris']
const COPILOT_EXTENSIONS = new Set(['copilot', 'copilot-chat'])

function parseArgs(argv) {
  const args = { phase: ['prepare', 'build', 'package', 'verify'] }
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--target') args.target = value
    else if (key === '--work') args.work = value
    else if (key === '--out') args.out = value
    else if (key === '--phase') args.phase = value.split(',')
    else continue
    i++
  }
  return args
}

function run(command, args, options = {}) {
  console.log(`$ ${[command, ...args].join(' ')}`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    // npm is npm.cmd on Windows; Node refuses to spawn .cmd without a shell.
    shell: process.platform === 'win32' && command === 'npm',
    ...options,
  })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status ?? result.signal}`)
}

function systemTar() {
  return process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
}

export function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(abs, base, out)
    else out.push(abs.slice(base.length + 1).replace(/\\/g, '/'))
  }
  return out
}

/** Relative paths longer than `limit`, longest first. */
export function pathsOverBudget(files, limit = MAX_ARCHIVE_PATH) {
  return files.filter((f) => f.length > limit).sort((a, b) => b.length - a.length)
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function prepare({ checkout }) {
  const { repo, commit } = readCodeOssLock()
  const head = existsSync(join(checkout, '.git'))
    ? spawnSync('git', ['-C', checkout, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
    : ''
  if (head !== commit) {
    rmSync(checkout, { recursive: true, force: true })
    mkdirSync(checkout, { recursive: true })
    run('git', ['init', '--quiet', checkout])
    run('git', ['-C', checkout, 'config', 'core.longpaths', 'true'])
    run('git', ['-C', checkout, 'config', 'core.autocrlf', 'false'])
    run('git', ['-C', checkout, 'remote', 'add', 'origin', repo])
    run('git', ['-C', checkout, 'fetch', '--depth', '1', 'origin', commit])
    run('git', ['-C', checkout, 'checkout', '--quiet', 'FETCH_HEAD'])
  }
  // Back to the pristine commit (ignored files such as node_modules survive)
  // so the patches always apply onto exactly what the lock pins.
  run('git', ['-C', checkout, 'checkout', '--quiet', '--', '.'])
  run('git', ['-C', checkout, 'clean', '-fdq'])
  run(process.execPath, [join(SHOGO_IDE_ROOT, 'scripts', 'materialize-distribution.mjs')])
  run(process.execPath, [join(SHOGO_IDE_ROOT, 'scripts', 'apply-code-oss-patches.mjs'), checkout])
  run(process.execPath, [join(SHOGO_IDE_ROOT, 'scripts', 'apply-product-overrides.mjs'), checkout])
}

function build({ checkout, target, serverDir }) {
  const [, arch] = target.split('-')
  const env = {
    ...process.env,
    ELECTRON_SKIP_BINARY_DOWNLOAD: '1',
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    VSCODE_ARCH: arch,
    ...(arch !== process.arch ? { npm_config_arch: arch } : {}),
  }
  run('npm', ['ci'], { cwd: checkout, env })
  run('npm', ['run', 'gulp', '--', `vscode-reh-web-${target}-min`], { cwd: checkout, env })
  if (!existsSync(serverDir)) throw new Error(`gulp did not produce ${serverDir}`)

  const extensionsDir = join(serverDir, 'extensions')
  for (const name of readdirSync(extensionsDir)) {
    if (COPILOT_EXTENSIONS.has(name.toLowerCase())) rmSync(join(extensionsDir, name), { recursive: true, force: true })
  }

  const coreSource = join(SHOGO_IDE_ROOT, 'extensions', 'shogo-core')
  run(process.execPath, [join(checkout, 'node_modules', 'typescript', 'lib', 'tsc.js'), '-p', join(coreSource, 'tsconfig.json')])
  const coreTarget = join(extensionsDir, 'shogo-core')
  rmSync(coreTarget, { recursive: true, force: true })
  mkdirSync(coreTarget, { recursive: true })
  for (const entry of ['package.json', 'README.md', 'media', 'dist']) {
    cpSync(join(coreSource, entry), join(coreTarget, entry), { recursive: true })
  }
}

async function packageServer({ serverDir, out, artifactId, target }) {
  const files = walkFiles(serverDir)
  const overBudget = pathsOverBudget(files)
  if (overBudget.length > 0) {
    throw new Error(
      `${overBudget.length} paths exceed ${MAX_ARCHIVE_PATH} characters (Windows MAX_PATH budget):\n  ${overBudget.slice(0, 10).join('\n  ')}`,
    )
  }
  mkdirSync(out, { recursive: true })
  const file = assetFileName(artifactId, target)
  const archive = join(out, file)
  rmSync(archive, { force: true })
  run(systemTar(), ['-czf', archive, '-C', serverDir, '.'])
  const sha = await sha256File(archive)
  writeFileSync(`${archive}.sha256`, `${sha}  ${file}\n`)
  console.log(`Packaged ${file} (${statSync(archive).size} bytes, sha256 ${sha})`)
}

function freePort() {
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePromise(port))
    })
  })
}

function httpGet(url, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get(url, { headers, timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

export function findMarkers(dir, markers = PATCH_MARKERS) {
  const found = new Set()
  for (const rel of walkFiles(dir)) {
    if (!rel.endsWith('.js')) continue
    const text = readFileSync(join(dir, rel), 'utf8')
    for (const marker of markers) if (text.includes(marker)) found.add(marker)
    if (found.size === markers.length) break
  }
  return markers.filter((m) => !found.has(m))
}

async function verify({ serverDir }) {
  const nodeBin = join(serverDir, process.platform === 'win32' ? 'node.exe' : 'node')
  for (const required of [nodeBin, join(serverDir, 'out', 'server-main.js'), join(serverDir, 'extensions', 'shogo-core', 'dist', 'extension.js')]) {
    if (!existsSync(required)) throw new Error(`Server build is missing ${required}`)
  }
  const copilot = readdirSync(join(serverDir, 'extensions')).filter((n) => COPILOT_EXTENSIONS.has(n.toLowerCase()))
  if (copilot.length) throw new Error(`Copilot extensions still present: ${copilot.join(', ')}`)
  const missing = findMarkers(join(serverDir, 'out'))
  if (missing.length) throw new Error(`Shogo patch markers missing from the build: ${missing.join(', ')}`)

  const scratch = join(tmpdir(), `shogo-ide-verify-${randomBytes(4).toString('hex')}`)
  mkdirSync(scratch, { recursive: true })
  const token = randomBytes(32).toString('hex')
  writeFileSync(join(scratch, 'token'), token)
  const port = await freePort()
  const child = spawn(
    nodeBin,
    [
      join(serverDir, 'out', 'server-main.js'),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--connection-token-file', join(scratch, 'token'),
      '--accept-server-license-terms',
      '--disable-telemetry',
      '--disable-workspace-trust',
      '--user-data-dir', join(scratch, 'user-data'),
      '--extensions-dir', join(scratch, 'extensions'),
      '--server-data-dir', join(scratch, 'server-data'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', (c) => (output += c))
  child.stderr.on('data', (c) => (output += c))
  try {
    const deadline = Date.now() + 60_000
    let page = null
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        const res = await httpGet(`http://127.0.0.1:${port}/`, { cookie: `vscode-tkn=${token}` })
        if (res.status === 200) {
          page = res
          break
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (!page) throw new Error(`Server did not answer within 60 s.\n${output.slice(-4000)}`)
    if (!/workbench/i.test(page.body)) throw new Error('Server answered, but not with the workbench page')
    const unauthorized = await httpGet(`http://127.0.0.1:${port}/`)
    if (unauthorized.status === 200) throw new Error('Server served the workbench without the connection token')
    console.log(`Server smoke passed on port ${port}`)
  } finally {
    child.kill()
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!SERVER_TARGETS.includes(args.target)) {
    throw new Error(`--target must be one of ${SERVER_TARGETS.join(', ')}`)
  }
  const work = resolve(args.work ?? join(tmpdir(), 'scos'))
  const ctx = {
    target: args.target,
    checkout: join(work, 'vscode'),
    serverDir: join(work, `vscode-reh-web-${args.target}`),
    out: resolve(args.out ?? join(work, 'artifacts')),
    artifactId: computeArtifactId().artifactId,
  }
  console.log(`Shogo IDE server ${ctx.artifactId} for ${ctx.target} in ${work}`)
  if (args.phase.includes('prepare')) prepare(ctx)
  if (args.phase.includes('build')) build(ctx)
  if (args.phase.includes('package')) await packageServer(ctx)
  if (args.phase.includes('verify')) await verify(ctx)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
