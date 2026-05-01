#!/usr/bin/env node

/**
 * Downloads the Bun binary for the current (or specified) platform.
 * Used by CI and local development to bundle Bun with the Electron app.
 *
 * Usage:
 *   node scripts/download-bun.mjs                    # Current platform
 *   node scripts/download-bun.mjs --platform darwin   # macOS
 *   node scripts/download-bun.mjs --platform win32    # Windows
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')
const BUN_VERSION = process.env.BUN_VERSION || 'latest'

const PLATFORM_MAP = {
  'darwin-arm64': 'bun-darwin-aarch64',
  'darwin-x64': 'bun-darwin-x64',
  'win32-x64': 'bun-windows-x64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-aarch64',
}

function getTargetKey() {
  const args = process.argv.slice(2)
  const platformIdx = args.indexOf('--platform')
  const archIdx = args.indexOf('--arch')

  const platform = platformIdx >= 0 ? args[platformIdx + 1] : process.platform
  const arch = archIdx >= 0 ? args[archIdx + 1] : process.arch

  return `${platform}-${arch}`
}

function main() {
  const targetKey = getTargetKey()
  const bunTarget = PLATFORM_MAP[targetKey]

  if (!bunTarget) {
    console.error(`Unsupported platform: ${targetKey}`)
    console.error(`Supported: ${Object.keys(PLATFORM_MAP).join(', ')}`)
    process.exit(1)
  }

  const isWindows = targetKey.startsWith('win32')
  const bunExe = isWindows ? 'bun.exe' : 'bun'
  const outputDir = path.join(RESOURCES_DIR, 'bun')
  const outputPath = path.join(outputDir, bunExe)

  if (fs.existsSync(outputPath)) {
    console.log(`Bun binary already exists at ${outputPath}`)
    return
  }

  fs.mkdirSync(outputDir, { recursive: true })

  const versionPath = BUN_VERSION === 'latest'
    ? 'latest/download'
    : `download/bun-v${BUN_VERSION}`

  const url = `https://github.com/oven-sh/bun/releases/${versionPath}/${bunTarget}.zip`
  const zipPath = path.join(outputDir, `${bunTarget}.zip`)

  console.log(`Downloading Bun for ${targetKey} from ${url}...`)
  execSync(`curl -fSL -o "${zipPath}" "${url}"`, { stdio: 'inherit' })

  console.log('Extracting...')
  if (isWindows) {
    execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${outputDir}' -Force"`)
  } else {
    execSync(`unzip -o "${zipPath}" -d "${outputDir}"`)
  }

  // The zip contains a directory like bun-darwin-aarch64/bun.
  // On Windows the same directory may also contain bunx.exe (a thin
  // wrapper that calls into bun). We copy both so package.json scripts
  // and agent commands that say `bunx <tool>` keep working out of the
  // box — without bunx.exe, Windows users hit `'bunx' is not recognized`
  // the moment the runtime tries to run `bunx prisma db push` etc.
  // (See platform-pkg.ts and the rewriteBunxOnWindows() shim, which
  // exists as a defense-in-depth fallback for shells that still don't
  // see bunx on PATH.)
  const extractedDir = path.join(outputDir, bunTarget)
  const extractedBin = path.join(extractedDir, bunExe)

  if (fs.existsSync(extractedBin)) {
    fs.renameSync(extractedBin, outputPath)
  }

  if (isWindows) {
    const bunxExe = 'bunx.exe'
    const extractedBunx = path.join(extractedDir, bunxExe)
    const outputBunx = path.join(outputDir, bunxExe)
    if (fs.existsSync(extractedBunx) && !fs.existsSync(outputBunx)) {
      fs.renameSync(extractedBunx, outputBunx)
    }
  }

  fs.rmSync(extractedDir, { recursive: true, force: true })

  // Make executable on unix
  if (!isWindows) {
    fs.chmodSync(outputPath, 0o755)
  }

  // Clean up zip
  fs.rmSync(zipPath, { force: true })

  console.log(`Bun binary saved to ${outputPath}`)
  if (isWindows && fs.existsSync(path.join(outputDir, 'bunx.exe'))) {
    console.log(`Bunx binary saved to ${path.join(outputDir, 'bunx.exe')}`)
  }
}

main()
