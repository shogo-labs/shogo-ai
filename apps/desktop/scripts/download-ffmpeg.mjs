#!/usr/bin/env node

/**
 * Downloads FFmpeg binaries for the current (or specified) platform and places
 * them into apps/desktop/resources/ffmpeg so they are bundled with the Electron
 * app via extraResource in forge.config.ts.
 *
 * Usage:
 *   node scripts/download-ffmpeg.mjs                    # Current platform
 *   node scripts/download-ffmpeg.mjs --platform win32   # Windows
 *   node scripts/download-ffmpeg.mjs --platform darwin  # macOS
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')

// gyan.dev essentials build for Windows (well-known, trusted community builds).
// macOS / Linux users already have ffmpeg via Homebrew / apt — we only need to
// bundle on Windows where users are least likely to have it pre-installed and
// the installer error is the most confusing.
const FFMPEG_VERSION = process.env.FFMPEG_VERSION || '8.1.1'

const DOWNLOADS = {
  'win32-x64': {
    url: `https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
    extractDir: `ffmpeg-${FFMPEG_VERSION}-essentials_build`,
    binDir: 'bin',
    binaries: ['ffmpeg.exe', 'ffprobe.exe'],
  },
  'darwin-arm64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
    extractDir: null,
    binDir: '.',
    binaries: ['ffmpeg'],
  },
  'darwin-x64': {
    url: 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip',
    extractDir: null,
    binDir: '.',
    binaries: ['ffmpeg'],
  },
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
  const config = DOWNLOADS[targetKey]

  if (!config) {
    console.error(`Unsupported platform for FFmpeg download: ${targetKey}`)
    console.error(`Supported: ${Object.keys(DOWNLOADS).join(', ')}`)
    process.exit(1)
  }

  const isWindows = targetKey.startsWith('win32')
  const outputDir = path.join(RESOURCES_DIR, 'ffmpeg')
  const primaryBin = isWindows ? 'ffmpeg.exe' : 'ffmpeg'

  if (fs.existsSync(path.join(outputDir, primaryBin))) {
    console.log(`FFmpeg binary already exists at ${path.join(outputDir, primaryBin)}`)
    return
  }

  fs.mkdirSync(outputDir, { recursive: true })

  const archivePath = path.join(outputDir, 'ffmpeg-download.zip')

  console.log(`Downloading FFmpeg for ${targetKey} from ${config.url}...`)
  execSync(`curl -fSL -o "${archivePath}" "${config.url}"`, { stdio: 'inherit' })

  console.log('Extracting...')
  const tempDir = path.join(outputDir, '_extract')
  fs.mkdirSync(tempDir, { recursive: true })

  if (isWindows) {
    execSync(
      `powershell -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force"`,
    )
  } else {
    execSync(`unzip -o "${archivePath}" -d "${tempDir}"`)
  }

  // Locate the extracted bin directory
  let binSourceDir = tempDir
  if (config.extractDir) {
    binSourceDir = path.join(tempDir, config.extractDir, config.binDir)
  }

  // Copy binaries to the output directory
  for (const file of config.binaries) {
    const src = path.join(binSourceDir, file)
    const dest = path.join(outputDir, file)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      if (!isWindows) fs.chmodSync(dest, 0o755)
      console.log(`Saved: ${dest}`)
    } else {
      console.warn(`Warning: expected file not found: ${src}`)
    }
  }

  // On Windows, also copy any DLLs that ffmpeg.exe depends on
  if (isWindows && fs.existsSync(binSourceDir)) {
    const dlls = fs.readdirSync(binSourceDir).filter((f) => f.endsWith('.dll'))
    for (const dll of dlls) {
      fs.copyFileSync(path.join(binSourceDir, dll), path.join(outputDir, dll))
      console.log(`Saved DLL: ${dll}`)
    }
  }

  // Cleanup temp files
  fs.rmSync(tempDir, { recursive: true, force: true })
  fs.rmSync(archivePath, { force: true })

  console.log(`FFmpeg binaries saved to ${outputDir}`)
}

main()
