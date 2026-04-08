#!/usr/bin/env node

/**
 * Installs whisper-cli (via Homebrew on macOS) and downloads a model for local transcription.
 *
 * Usage:
 *   node scripts/download-whisper.mjs                   # Install binary + base.en model
 *   node scripts/download-whisper.mjs --model small.en  # Install binary + specified model
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources')

const MODEL_URLS = {
  'tiny.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
  'tiny': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin',
  'base.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
  'base': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
  'small.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
  'small': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'medium.en': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
  'medium': 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin',
}

function getArgs() {
  const args = process.argv.slice(2)
  const modelIdx = args.indexOf('--model')
  const model = modelIdx >= 0 ? args[modelIdx + 1] : 'base.en'
  return { model }
}

function whichSync(cmd) {
  try {
    return execSync(`which ${cmd}`, { encoding: 'utf-8' }).trim() || null
  } catch {
    return null
  }
}

function ensureBinary() {
  const outputDir = path.join(RESOURCES_DIR, 'whisper')
  const outputPath = path.join(outputDir, 'whisper-cli')

  if (fs.existsSync(outputPath)) {
    console.log(`whisper-cli binary already exists at ${outputPath}`)
    return
  }

  if (whichSync('whisper-cli')) {
    console.log('whisper-cli found in PATH (e.g. from Homebrew)')
    return
  }

  // Install via Homebrew on macOS
  if (process.platform === 'darwin') {
    if (!whichSync('brew')) {
      console.error('Homebrew is required to install whisper-cpp on macOS.')
      console.error('Install it from https://brew.sh then re-run this script.')
      process.exit(1)
    }

    console.log('Installing whisper-cpp via Homebrew...')
    execSync('brew install whisper-cpp', { stdio: 'inherit' })
    console.log('whisper-cli installed via Homebrew')
    return
  }

  console.error('No prebuilt whisper binaries for this platform.')
  console.error('Install whisper-cpp manually and ensure whisper-cli is in your PATH.')
  console.error('  Linux: build from source — https://github.com/ggml-org/whisper.cpp')
  process.exit(1)
}

function downloadModel(model) {
  const url = MODEL_URLS[model]
  if (!url) {
    console.error(`Unknown model: ${model}`)
    console.error(`Available: ${Object.keys(MODEL_URLS).join(', ')}`)
    process.exit(1)
  }

  const modelsDir = path.join(RESOURCES_DIR, 'whisper', 'models')
  const filename = `ggml-${model}.bin`
  const outputPath = path.join(modelsDir, filename)

  if (fs.existsSync(outputPath)) {
    console.log(`Model ${model} already exists at ${outputPath}`)
    return
  }

  fs.mkdirSync(modelsDir, { recursive: true })

  console.log(`Downloading whisper model: ${model}...`)
  console.log(`  URL: ${url}`)
  execSync(`curl -fSL -o "${outputPath}" "${url}"`, { stdio: 'inherit' })

  const stats = fs.statSync(outputPath)
  console.log(`Model saved to ${outputPath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`)
}

function main() {
  const { model } = getArgs()

  ensureBinary()
  downloadModel(model)

  console.log('\nWhisper setup complete!')
}

main()
