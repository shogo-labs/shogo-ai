// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
// Namespace imports: a test that mocks these modules partially must not break linking.
import * as fsp from 'fs/promises'
import * as os from 'os'
import { join, resolve } from 'path'

export interface TranscriptSegment {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface TranscriptionResult {
  text: string
  segments: TranscriptSegment[]
  language: string
  duration: number
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const SHERPA_BIN_EXT = process.platform === 'win32' ? '.exe' : ''

function getSherpaDir(): string {
  const candidates = [
    // Explicit override from desktop local-server (packaged app writable path)
    process.env.SHOGO_SHERPA_DIR,
    // Co-located with data dir (packaged desktop default)
    process.env.SHOGO_DATA_DIR ? join(process.env.SHOGO_DATA_DIR, 'sherpa-onnx') : undefined,
    // Dev mode: installed under apps/desktop/resources
    resolve(process.cwd(), 'apps', 'desktop', 'resources', 'sherpa-onnx'),
    // Electron resourcesPath (only set when running inside Electron, not in spawned bun process)
    join((process as any).resourcesPath || '', 'sherpa-onnx'),
  ].filter(Boolean) as string[]
  for (const dir of candidates) {
    if (existsSync(join(dir, 'bin', `sherpa-onnx-offline${SHERPA_BIN_EXT}`))) return dir
  }
  return candidates[0]
}

export function getSherpaOfflinePath(): string | null {
  const dir = getSherpaDir()
  const binPath = join(dir, 'bin', `sherpa-onnx-offline${SHERPA_BIN_EXT}`)
  return existsSync(binPath) ? binPath : null
}

export function getSherpaLibDir(): string {
  return join(getSherpaDir(), 'lib')
}

export function getWhisperModelDir(model: string = 'base.en'): string | null {
  const dir = getSherpaDir()
  const modelDir = join(dir, 'models', `whisper-${model}`)
  const prefix = model
  const encoder = join(modelDir, `${prefix}-encoder.onnx`)
  const decoder = join(modelDir, `${prefix}-decoder.onnx`)
  const tokens = join(modelDir, `${prefix}-tokens.txt`)
  if (existsSync(encoder) && existsSync(decoder) && existsSync(tokens)) return modelDir
  return null
}

/** Streaming recognizer server (sherpa-onnx online websocket server), or null when not installed. */
export function getSherpaOnlineServerPath(): string | null {
  const binPath = join(getSherpaDir(), 'bin', `sherpa-onnx-online-websocket-server${SHERPA_BIN_EXT}`)
  return existsSync(binPath) ? binPath : null
}

export interface StreamingModelFiles {
  encoder: string
  decoder: string
  joiner: string
  tokens: string
}

/** Files of the streaming zipformer model installed by `download-sherpa --streaming`, or null. */
export function getStreamingModelFiles(): StreamingModelFiles | null {
  const dir = join(getSherpaDir(), 'models', 'streaming-zipformer-en')
  const pick = (names: string[]) => names.map((n) => join(dir, n)).find((p) => existsSync(p)) ?? null
  const encoder = pick(['encoder.int8.onnx', 'encoder.onnx'])
  const decoder = pick(['decoder.onnx', 'decoder.int8.onnx'])
  const joiner = pick(['joiner.int8.onnx', 'joiner.onnx'])
  const tokens = pick(['tokens.txt'])
  return encoder && decoder && joiner && tokens ? { encoder, decoder, joiner, tokens } : null
}

export function isStreamingTranscriptionAvailable(): boolean {
  return !!getSherpaOnlineServerPath() && !!getStreamingModelFiles()
}

/** Environment that lets a sherpa binary find its shared libraries. */
export function getSherpaProcessEnv(): NodeJS.ProcessEnv {
  const libDir = getSherpaLibDir()
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':')
  } else if (process.platform === 'win32') {
    env.PATH = [join(getSherpaDir(), 'bin'), libDir, env.PATH].filter(Boolean).join(';')
  } else {
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }
  return env
}

export function getInstalledModels(): string[] {
  const dir = getSherpaDir()
  const modelsDir = join(dir, 'models')
  if (!existsSync(modelsDir)) return []

  const knownModels = ['tiny.en', 'base.en', 'small.en', 'medium.en', 'tiny', 'base', 'small']
  return knownModels.filter((m) => getWhisperModelDir(m) !== null)
}

// ---------------------------------------------------------------------------
// Local transcription via sherpa-onnx-offline
// ---------------------------------------------------------------------------

export async function transcribeLocal(
  audioPath: string,
  model: string = 'base.en',
): Promise<TranscriptionResult> {
  const binaryPath = getSherpaOfflinePath()
  if (!binaryPath) {
    throw new Error('sherpa-onnx-offline binary not found. Run download-sherpa to install.')
  }

  const modelDir = getWhisperModelDir(model)
  if (!modelDir) {
    throw new Error(`Whisper ONNX model "${model}" not found. Run download-sherpa --model ${model}`)
  }

  const prefix = model
  const baseArgs = [
    `--whisper-encoder=${join(modelDir, `${prefix}-encoder.onnx`)}`,
    `--whisper-decoder=${join(modelDir, `${prefix}-decoder.onnx`)}`,
    `--tokens=${join(modelDir, `${prefix}-tokens.txt`)}`,
    '--num-threads=4',
  ]

  const libDir = getSherpaLibDir()
  const env = { ...process.env }
  if (process.platform === 'darwin') {
    env.DYLD_LIBRARY_PATH = [libDir, env.DYLD_LIBRARY_PATH].filter(Boolean).join(':')
  } else if (process.platform === 'win32') {
    const binDir = join(getSherpaDir(), 'bin')
    env.PATH = [binDir, libDir, env.PATH].filter(Boolean).join(';')
  } else {
    env.LD_LIBRARY_PATH = [libDir, env.LD_LIBRARY_PATH].filter(Boolean).join(':')
  }

  const run = (files: string[], durationSeconds: number) =>
    runSherpaOffline(binaryPath, [...baseArgs, ...files], env, durationSeconds)

  // Whisper decodes at most ~30 s per call, so anything longer is cut into
  // windows. If the audio can't be windowed, fall back to a single pass.
  const prepared = await prepareWindows(audioPath).catch((err) => {
    console.warn(`[Transcription] Could not window ${audioPath}; transcribing in one pass:`, err?.message ?? err)
    return null
  })
  if (prepared) {
    try {
      return await transcribeWindows(prepared, run)
    } finally {
      await fsp.rm(prepared.dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const info = await readWavInfo(audioPath).catch(() => null)
  const stdout = await run([audioPath], info?.durationSeconds ?? 0)
  let result: TranscriptionResult
  try {
    result = parseSherpaOutput(stdout)
  } catch (err) {
    throw new Error(`Failed to parse sherpa-onnx output: ${err}`)
  }
  if (info && isImplausiblyEmpty(countWords(result.text), info.durationSeconds)) {
    throw new Error(emptyResultMessage(info.durationSeconds))
  }
  return result
}

// ---------------------------------------------------------------------------
// Windowing for long recordings
// ---------------------------------------------------------------------------

/** Whisper's context is 30 s; audio at or below this goes through in one piece. */
export const WHISPER_MAX_SINGLE_SECONDS = 28
/** Target window length. Cuts snap to the quietest moment within SNAP_RADIUS_SECONDS. */
export const WHISPER_WINDOW_SECONDS = 25
const SNAP_RADIUS_SECONDS = 2
const SNAP_FRAME_SECONDS = 0.1
const WINDOW_RATE = 16_000
/** Windows quieter than this RMS (16-bit scale) are skipped: Whisper invents text for silence. */
export const SILENT_WINDOW_RMS = 25
/** Audio this long (non-silent) with fewer words than 1 per 5 minutes did not get transcribed. */
const MIN_SECONDS_PER_WORD = 300
const MIN_CHECKED_SECONDS = 120

export interface WavInfo {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** 1 = PCM, 3 = float. WAVE_FORMAT_EXTENSIBLE is reported as 1 when 16-bit. */
  audioFormat: number
  dataOffset: number
  dataBytes: number
  durationSeconds: number
}

/** Parse a WAV header. Tolerates the zero / 0xFFFFFFFF data sizes that streaming writers leave behind. */
export function parseWavHeader(buf: Buffer, fileSize: number): WavInfo | null {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let audioFormat = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pos = 12
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') {
      if (pos + 8 + 16 > buf.length) return null
      audioFormat = buf.readUInt16LE(pos + 8)
      channels = buf.readUInt16LE(pos + 10)
      sampleRate = buf.readUInt32LE(pos + 12)
      bitsPerSample = buf.readUInt16LE(pos + 22)
      if (audioFormat === 0xfffe && bitsPerSample === 16) audioFormat = 1
    } else if (id === 'data') {
      if (!channels || !sampleRate || !bitsPerSample) return null
      const dataOffset = pos + 8
      const available = Math.max(0, fileSize - dataOffset)
      const dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size
      const bytesPerFrame = channels * (bitsPerSample / 8)
      return {
        sampleRate,
        channels,
        bitsPerSample,
        audioFormat,
        dataOffset,
        dataBytes,
        durationSeconds: dataBytes / (sampleRate * bytesPerFrame),
      }
    }
    pos += 8 + size + (size & 1)
  }
  return null
}

export async function readWavInfo(path: string): Promise<WavInfo | null> {
  const fh = await fsp.open(path, 'r')
  try {
    const { size } = await fh.stat()
    const buf = Buffer.alloc(Math.min(size, 4096))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    return parseWavHeader(buf.subarray(0, bytesRead), size)
  } finally {
    await fh.close()
  }
}

export interface AudioWindow {
  /** Sample offsets into the 16 kHz mono audio. */
  start: number
  end: number
}

/** Offset (in samples, from the start of `samples`) of the centre of the quietest frame. */
export function quietestFrameCenter(samples: Int16Array, frame: number): number {
  if (samples.length <= frame) return Math.floor(samples.length / 2)
  const step = Math.max(1, Math.floor(frame / 2))
  let bestStart = 0
  let bestEnergy = Infinity
  for (let s = 0; s + frame <= samples.length; s += step) {
    let energy = 0
    for (let i = s; i < s + frame; i++) energy += samples[i] * samples[i]
    if (energy < bestEnergy) {
      bestEnergy = energy
      bestStart = s
    }
  }
  return bestStart + Math.floor(frame / 2)
}

/**
 * Split `totalSamples` of 16 kHz audio into windows of about
 * WHISPER_WINDOW_SECONDS, each cut placed at the quietest moment near the
 * nominal boundary so words aren't split. Windows never exceed Whisper's limit.
 */
export async function planWindows(
  totalSamples: number,
  readRegion: (start: number, count: number) => Promise<Int16Array>,
  sampleRate = WINDOW_RATE,
): Promise<AudioWindow[]> {
  const target = WHISPER_WINDOW_SECONDS * sampleRate
  const radius = SNAP_RADIUS_SECONDS * sampleRate
  const frame = Math.round(SNAP_FRAME_SECONDS * sampleRate)
  const windows: AudioWindow[] = []
  let start = 0
  while (start < totalSamples) {
    if (totalSamples - start <= WHISPER_MAX_SINGLE_SECONDS * sampleRate) {
      windows.push({ start, end: totalSamples })
      break
    }
    const nominal = start + target
    const from = Math.max(start + frame, nominal - radius)
    const to = Math.min(totalSamples - frame, nominal + radius)
    const region = await readRegion(from, to - from)
    const cut = from + quietestFrameCenter(region, frame)
    windows.push({ start, end: cut })
    start = cut
  }
  return windows
}

export function rmsOf(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / samples.length)
}

export function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}

/** True when long audio produced so little text that the transcriber clearly didn't cover it. */
export function isImplausiblyEmpty(words: number, speechSeconds: number): boolean {
  return speechSeconds >= MIN_CHECKED_SECONDS && words < speechSeconds / MIN_SECONDS_PER_WORD
}

function emptyResultMessage(seconds: number): string {
  return `Local transcription returned almost no text for ${Math.round(seconds / 60)} minutes of audio`
}

/** One JSON result per input file, in input order. */
export function parseSherpaJsonLines(stdout: string): Array<{ text: string; lang: string }> {
  const out: Array<{ text: string; lang: string }> = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue
    try {
      const json = JSON.parse(trimmed)
      out.push({ text: String(json.text ?? '').trim(), lang: json.lang || '' })
    } catch { /* not JSON, continue */ }
  }
  return out
}

/**
 * Turn per-window texts into a transcript. This sherpa build returns no token
 * timestamps, so each window's text is split into sentences and the window's
 * time span is shared out by sentence length. That keeps segments short enough
 * for speaker labels to land on the right turn.
 */
export function assembleWindowedResult(
  windows: AudioWindow[],
  texts: string[],
  durationSeconds: number,
  sampleRate = WINDOW_RATE,
  language = 'en',
): TranscriptionResult {
  const segments: TranscriptSegment[] = []
  windows.forEach((w, i) => {
    const text = (texts[i] ?? '').trim()
    if (!text) return
    const start = w.start / sampleRate
    const span = (w.end - w.start) / sampleRate
    const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
    const totalChars = sentences.reduce((n, s) => n + s.length, 0)
    let cursor = start
    for (const sentence of sentences) {
      const end = cursor + (span * sentence.length) / totalChars
      segments.push({ start: cursor, end, text: sentence })
      cursor = end
    }
  })
  return { text: segments.map((s) => s.text).join(' '), segments, language, duration: durationSeconds }
}

interface PreparedWindows {
  dir: string
  /** 16 kHz mono source the windows are cut from. */
  windows: Array<AudioWindow & { path: string; silent: boolean }>
  durationSeconds: number
}

function runFfmpegTo16kMono(src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-v', 'error', '-i', src, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', dest], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30 * 60_000,
    })
    let stderr = ''
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('error', (err) => reject(new Error(`ffmpeg failed: ${err.message}`)))
    proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-300)}`))))
  })
}

function is16kMonoPcm(info: WavInfo | null): boolean {
  return !!info && info.sampleRate === WINDOW_RATE && info.channels === 1 && info.bitsPerSample === 16 && info.audioFormat === 1
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVEfmt ', 8, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(WINDOW_RATE, 24)
  h.writeUInt32LE(WINDOW_RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/**
 * Cut audio longer than Whisper's context into window files in a temp dir.
 * Returns null when the audio is short enough (or isn't a readable WAV).
 */
async function prepareWindows(audioPath: string): Promise<PreparedWindows | null> {
  let sourceInfo: WavInfo | null
  try {
    sourceInfo = await readWavInfo(audioPath)
  } catch {
    return null
  }
  if (!sourceInfo || sourceInfo.durationSeconds <= WHISPER_MAX_SINGLE_SECONDS) return null

  const dir = await fsp.mkdtemp(join(os.tmpdir(), 'shogo-whisper-'))
  try {
    let srcPath = audioPath
    let info: WavInfo | null = sourceInfo
    if (!is16kMonoPcm(sourceInfo)) {
      // The recorder's `-16k.wav` sibling may already exist; use it only if it covers the same audio.
      const sibling = audioPath.replace(/\.wav$/i, '-16k.wav')
      const siblingInfo = sibling !== audioPath && existsSync(sibling) ? await readWavInfo(sibling).catch(() => null) : null
      if (siblingInfo && is16kMonoPcm(siblingInfo) && Math.abs(siblingInfo.durationSeconds - sourceInfo.durationSeconds) < 1) {
        srcPath = sibling
        info = siblingInfo
      } else {
        srcPath = join(dir, 'source-16k.wav')
        await runFfmpegTo16kMono(audioPath, srcPath)
        info = await readWavInfo(srcPath)
        if (!info || !is16kMonoPcm(info)) throw new Error('ffmpeg did not produce 16 kHz mono PCM')
      }
    }

    const totalSamples = Math.floor(info.dataBytes / 2)
    const fh = await fsp.open(srcPath, 'r')
    try {
      const readRegion = async (start: number, count: number): Promise<Int16Array> => {
        const buf = Buffer.alloc(count * 2)
        const { bytesRead } = await fh.read(buf, 0, buf.length, info!.dataOffset + start * 2)
        const n = Math.floor(bytesRead / 2)
        const out = new Int16Array(n)
        for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2)
        return out
      }

      const plan = await planWindows(totalSamples, readRegion)
      const windows: PreparedWindows['windows'] = []
      for (let i = 0; i < plan.length; i++) {
        const w = plan[i]
        const samples = await readRegion(w.start, w.end - w.start)
        const silent = rmsOf(samples) < SILENT_WINDOW_RMS
        const path = join(dir, `w${String(i).padStart(5, '0')}.wav`)
        if (!silent) {
          await fsp.writeFile(path, Buffer.concat([wavHeader(samples.length * 2), Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]))
        }
        windows.push({ ...w, path, silent })
      }
      return { dir, windows, durationSeconds: totalSamples / WINDOW_RATE }
    } finally {
      await fh.close()
    }
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

async function transcribeWindows(
  prepared: PreparedWindows,
  run: (files: string[], durationSeconds: number) => Promise<string>,
): Promise<TranscriptionResult> {
  const active = prepared.windows.filter((w) => !w.silent)
  const speechSeconds = active.reduce((sum, w) => sum + (w.end - w.start) / WINDOW_RATE, 0)
  if (active.length === 0) return assembleWindowedResult([], [], prepared.durationSeconds)

  const stdout = await run(active.map((w) => w.path), speechSeconds)
  const outputs = parseSherpaJsonLines(stdout)
  if (outputs.length !== active.length) {
    throw new Error(`sherpa-onnx returned ${outputs.length} results for ${active.length} audio windows`)
  }

  const language = outputs.find((o) => o.lang)?.lang || 'en'
  const result = assembleWindowedResult(active, outputs.map((o) => o.text), prepared.durationSeconds, WINDOW_RATE, language)
  if (isImplausiblyEmpty(countWords(result.text), speechSeconds)) {
    throw new Error(emptyResultMessage(speechSeconds))
  }
  return result
}

function runSherpaOffline(
  binaryPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  durationSeconds: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binaryPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // Long recordings need more than the old flat 10 minutes on slow machines.
      timeout: 600_000 + Math.round(durationSeconds * 500),
    })

    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('error', (err) => reject(new Error(`Failed to run sherpa-onnx-offline: ${err.message}`)))

    proc.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`sherpa-onnx-offline exited with code ${code}: ${stderr.slice(-500)}`))
        return
      }
      resolve(stdout)
    })
  })
}

function parseSherpaOutput(stdout: string): TranscriptionResult {
  const lines = stdout.trim().split('\n')
  let jsonResult: any = null

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        jsonResult = JSON.parse(trimmed)
        break
      } catch { /* not JSON, continue */ }
    }
  }

  if (!jsonResult) {
    throw new Error('No JSON output found in sherpa-onnx-offline stdout')
  }

  const text = (jsonResult.text || '').trim()
  const tokens: string[] = jsonResult.tokens || []
  const timestamps: number[] = jsonResult.timestamps || []

  let segments: TranscriptSegment[] = []
  if (timestamps.length > 0 && timestamps.length === tokens.length) {
    segments = tokens.map((tok: string, i: number) => ({
      start: timestamps[i],
      end: i + 1 < timestamps.length ? timestamps[i + 1] : timestamps[i] + 0.5,
      text: tok,
    }))
  } else if (text) {
    segments = [{ start: 0, end: 0, text }]
  }

  const durationMatch = stdout.match(/Real time factor.*?\/\s*([\d.]+)\s*=/)
  const duration = durationMatch ? parseFloat(durationMatch[1]) : 0

  return { text, segments, language: jsonResult.lang || 'en', duration }
}

// ---------------------------------------------------------------------------
// Cloud transcription (OpenAI Whisper API)
// ---------------------------------------------------------------------------

/** Proxy credentials to bill a transcription to, instead of the server's own. */
export interface CloudTranscriptionAuth {
  proxyUrl: string
  proxyToken: string
}

export async function transcribeCloud(
  audioPath: string,
  language?: string,
  auth?: CloudTranscriptionAuth,
): Promise<TranscriptionResult> {
  const apiKey = process.env.OPENAI_API_KEY
  const proxyUrl = auth?.proxyUrl ?? process.env.AI_PROXY_URL
  const proxyToken = auth?.proxyToken ?? process.env.AI_PROXY_TOKEN

  // AI_PROXY_URL is set to `${apiBase}/api/ai/v1` (see build-workspace-env.ts /
  // build-project-env.ts / internal-proxy-config.ts). Strip a trailing `/v1`
  // before appending our own `/v1/audio/transcriptions` suffix below, so we
  // don't double up on the version segment (`.../api/ai/v1/v1/audio/...`),
  // which would 404 against the real `/ai/v1/audio/transcriptions` route.
  // Mirrors the same stripping the `transcribe_audio` tool already does in
  // packages/agent-runtime/src/gateway-tools.ts.
  const baseUrl = proxyUrl ? proxyUrl.replace(/\/v1$/, '') : 'https://api.openai.com'
  const authHeader = proxyToken
    ? `Bearer ${proxyToken}`
    : apiKey
      ? `Bearer ${apiKey}`
      : null

  if (!authHeader) {
    throw new Error('No OpenAI API key or proxy configured for cloud transcription')
  }

  const audioBuffer = await readFile(audioPath)
  const ext = audioPath.split('.').pop() || 'wav'
  const mimeMap: Record<string, string> = {
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4',
    webm: 'audio/webm', mp4: 'audio/mp4', ogg: 'audio/ogg',
  }

  const formData = new FormData()
  formData.append('file', new Blob([audioBuffer], { type: mimeMap[ext] || 'audio/wav' }), `audio.${ext}`)
  formData.append('model', 'whisper-1')
  formData.append('response_format', 'verbose_json')
  if (language) formData.append('language', language)

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: authHeader },
    body: formData,
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error(`OpenAI Whisper API error: ${response.status} ${err}`)
  }

  const result: any = await response.json()

  const segments: TranscriptSegment[] = (result.segments || []).map((seg: any) => ({
    start: seg.start || 0,
    end: seg.end || 0,
    text: (seg.text || '').trim(),
  }))

  return {
    text: result.text || '',
    segments,
    language: result.language || language || 'en',
    duration: result.duration || 0,
  }
}

// ---------------------------------------------------------------------------
// Orchestrator: local-first with cloud fallback
// ---------------------------------------------------------------------------

export async function transcribe(
  audioPath: string,
  options: {
    model?: string
    language?: string
    preferLocal?: boolean
    cloudAuth?: CloudTranscriptionAuth
  } = {},
): Promise<TranscriptionResult> {
  const { model = 'base.en', language, preferLocal = true, cloudAuth } = options

  if (preferLocal) {
    const binPath = getSherpaOfflinePath()
    const modelDir = getWhisperModelDir(model)

    if (binPath && modelDir) {
      try {
        return await transcribeLocal(audioPath, model)
      } catch (err) {
        console.error('[Transcription] Local transcription failed, trying cloud:', err)
      }
    }
  }

  return transcribeCloud(audioPath, language, cloudAuth)
}

export function isLocalTranscriptionAvailable(model: string = 'base.en'): boolean {
  return !!getSherpaOfflinePath() && !!getWhisperModelDir(model)
}
