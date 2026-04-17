#!/usr/bin/env node

/**
 * Downloads sherpa-onnx binaries and models for local transcription + diarization.
 *
 * Binaries: sherpa-onnx-offline, sherpa-onnx-offline-speaker-diarization + shared libs
 * Models:   Whisper ONNX (encoder/decoder/tokens) + Pyannote segmentation + NeMo embedding
 *
 * Usage:
 *   node scripts/download-sherpa.mjs                         # All components, base.en model
 *   node scripts/download-sherpa.mjs --model tiny.en         # Smaller model
 *   node scripts/download-sherpa.mjs --skip-diarization      # Transcription only
 */

import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RESOURCES_DIR = path.join(__dirname, '..', 'resources', 'sherpa-onnx')
const VERSION = '1.12.35'

const WHISPER_MODELS = {
  'tiny.en': { hf: 'csukuangfj/sherpa-onnx-whisper-tiny.en', prefix: 'tiny.en' },
  'base.en': { hf: 'csukuangfj/sherpa-onnx-whisper-base.en', prefix: 'base.en' },
  'small.en': { hf: 'csukuangfj/sherpa-onnx-whisper-small.en', prefix: 'small.en' },
  'medium.en': { hf: 'csukuangfj/sherpa-onnx-whisper-medium.en', prefix: 'medium.en' },
  'tiny': { hf: 'csukuangfj/sherpa-onnx-whisper-tiny', prefix: 'tiny' },
  'base': { hf: 'csukuangfj/sherpa-onnx-whisper-base', prefix: 'base' },
  'small': { hf: 'csukuangfj/sherpa-onnx-whisper-small', prefix: 'small' },
}

function getArgs() {
  const args = process.argv.slice(2)
  const modelIdx = args.indexOf('--model')
  const model = modelIdx >= 0 ? args[modelIdx + 1] : 'base.en'
  const skipDiarization = args.includes('--skip-diarization')
  return { model, skipDiarization }
}

function getPlatformConfig() {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') {
    return {
      tarball: `sherpa-onnx-v${VERSION}-osx-arm64-shared-no-tts.tar.bz2`,
      extractDir: `sherpa-onnx-v${VERSION}-osx-arm64-shared-no-tts`,
      libExt: 'dylib',
    }
  }
  if (platform === 'darwin' && arch === 'x64') {
    return {
      tarball: `sherpa-onnx-v${VERSION}-osx-x64-shared-no-tts.tar.bz2`,
      extractDir: `sherpa-onnx-v${VERSION}-osx-x64-shared-no-tts`,
      libExt: 'dylib',
    }
  }
  if (platform === 'linux' && arch === 'x64') {
    return {
      tarball: `sherpa-onnx-v${VERSION}-linux-x64-shared-no-tts.tar.bz2`,
      extractDir: `sherpa-onnx-v${VERSION}-linux-x64-shared-no-tts`,
      libExt: 'so',
    }
  }
  throw new Error(`Unsupported platform: ${platform}/${arch}`)
}

function downloadFile(url, destPath) {
  if (fs.existsSync(destPath)) {
    console.log(`  Already exists: ${path.basename(destPath)}`)
    return
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  console.log(`  Downloading: ${path.basename(destPath)}`)
  execSync(`curl -fSL --progress-bar -o "${destPath}" "${url}"`, { stdio: 'inherit' })
}

function downloadBinaries() {
  const binDir = path.join(RESOURCES_DIR, 'bin')
  const libDir = path.join(RESOURCES_DIR, 'lib')
  const offlineBin = path.join(binDir, 'sherpa-onnx-offline')

  if (fs.existsSync(offlineBin)) {
    console.log('Binaries already downloaded.')
    return
  }

  const config = getPlatformConfig()
  const url = `https://github.com/k2-fsa/sherpa-onnx/releases/download/v${VERSION}/${config.tarball}`
  const tmpTar = path.join(RESOURCES_DIR, config.tarball)

  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(libDir, { recursive: true })

  console.log(`\nDownloading sherpa-onnx v${VERSION} binaries...`)
  downloadFile(url, tmpTar)

  console.log('Extracting...')
  execSync(`tar xjf "${tmpTar}" -C "${RESOURCES_DIR}"`, { stdio: 'inherit' })

  const extractedDir = path.join(RESOURCES_DIR, config.extractDir)
  const binSrc = path.join(extractedDir, 'bin')
  const libSrc = path.join(extractedDir, 'lib')

  const requiredBins = ['sherpa-onnx-offline', 'sherpa-onnx-offline-speaker-diarization']
  for (const bin of requiredBins) {
    const src = path.join(binSrc, bin)
    const dest = path.join(binDir, bin)
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest)
      fs.chmodSync(dest, 0o755)
    }
  }

  for (const entry of fs.readdirSync(libSrc)) {
    const src = path.join(libSrc, entry)
    const dest = path.join(libDir, entry)
    const stat = fs.lstatSync(src)
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(src)
      if (fs.existsSync(dest)) fs.unlinkSync(dest)
      fs.symlinkSync(target, dest)
    } else {
      fs.copyFileSync(src, dest)
    }
  }

  fs.rmSync(extractedDir, { recursive: true, force: true })
  fs.unlinkSync(tmpTar)

  console.log('Binaries installed.')
}

function downloadWhisperModel(model) {
  const modelInfo = WHISPER_MODELS[model]
  if (!modelInfo) {
    console.error(`Unknown model: ${model}`)
    console.error(`Available: ${Object.keys(WHISPER_MODELS).join(', ')}`)
    process.exit(1)
  }

  const modelDir = path.join(RESOURCES_DIR, 'models', `whisper-${model}`)
  const files = [
    `${modelInfo.prefix}-encoder.onnx`,
    `${modelInfo.prefix}-decoder.onnx`,
    `${modelInfo.prefix}-tokens.txt`,
  ]

  const allExist = files.every((f) => fs.existsSync(path.join(modelDir, f)))
  if (allExist) {
    console.log(`Whisper model "${model}" already downloaded.`)
    return
  }

  fs.mkdirSync(modelDir, { recursive: true })
  console.log(`\nDownloading Whisper ONNX model: ${model}...`)

  for (const file of files) {
    const url = `https://huggingface.co/${modelInfo.hf}/resolve/main/${file}`
    downloadFile(url, path.join(modelDir, file))
  }

  console.log(`Model "${model}" installed.`)
}

function downloadDiarizationModels() {
  const segDir = path.join(RESOURCES_DIR, 'models', 'segmentation')
  const embDir = path.join(RESOURCES_DIR, 'models', 'embedding')

  const segModel = path.join(segDir, 'model.onnx')
  const embModel = path.join(embDir, 'nemo_en_titanet_small.onnx')

  if (fs.existsSync(segModel) && fs.existsSync(embModel)) {
    console.log('Diarization models already downloaded.')
    return
  }

  console.log('\nDownloading diarization models...')

  // Segmentation model (from tarball)
  if (!fs.existsSync(segModel)) {
    fs.mkdirSync(segDir, { recursive: true })
    const segTar = path.join(RESOURCES_DIR, 'seg-model.tar.bz2')
    downloadFile(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2',
      segTar,
    )
    execSync(`tar xjf "${segTar}" -C "${RESOURCES_DIR}"`, { stdio: 'inherit' })
    const extracted = path.join(RESOURCES_DIR, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx')
    if (fs.existsSync(extracted)) {
      fs.copyFileSync(extracted, segModel)
    }
    fs.rmSync(path.join(RESOURCES_DIR, 'sherpa-onnx-pyannote-segmentation-3-0'), { recursive: true, force: true })
    fs.unlinkSync(segTar)
    console.log('  Segmentation model installed.')
  }

  // Embedding model (single file)
  if (!fs.existsSync(embModel)) {
    fs.mkdirSync(embDir, { recursive: true })
    downloadFile(
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx',
      embModel,
    )
    console.log('  Embedding model installed.')
  }

  console.log('Diarization models installed.')
}

function main() {
  const { model, skipDiarization } = getArgs()

  downloadBinaries()
  downloadWhisperModel(model)

  if (!skipDiarization) {
    downloadDiarizationModels()
  }

  // Print summary
  console.log('\n=== sherpa-onnx setup complete ===')
  console.log(`  Resources: ${RESOURCES_DIR}`)
  console.log(`  Whisper model: ${model}`)
  console.log(`  Diarization: ${skipDiarization ? 'skipped' : 'installed'}`)

  let totalSize = 0
  function addDirSize(dir) {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) addDirSize(full)
      else if (entry.isFile()) totalSize += fs.statSync(full).size
    }
  }
  addDirSize(RESOURCES_DIR)
  console.log(`  Total size: ${(totalSize / 1024 / 1024).toFixed(0)} MB`)
}

main()
