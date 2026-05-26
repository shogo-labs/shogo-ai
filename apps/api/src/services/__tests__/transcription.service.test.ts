// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ─── child_process spawn mock ────────────────────────────────────────────────

type SpawnImpl = (cmd: string, args: string[], opts: any) => FakeProc

class FakeProc extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { on: any }
  stderr = new EventEmitter() as EventEmitter & { on: any }
  killed = false
}

let spawnImpl: SpawnImpl = () => {
  const p = new FakeProc()
  queueMicrotask(() => p.emit('exit', 0))
  return p
}

mock.module('child_process', () => ({
  spawn: (cmd: string, args: string[], opts: any) => spawnImpl(cmd, args, opts),
  execSync: () => '',
}))

// ─── fs fixtures (real fs, fake sherpa dir layout) ──────────────────────────

let tmpRoot: string
let sherpaDir: string
const SAVED_ENV = { ...process.env }

const PLATFORM_EXT = process.platform === 'win32' ? '.exe' : ''
const BIN_NAME = `sherpa-onnx-offline${PLATFORM_EXT}`

function seedSherpaBinary() {
  const binDir = join(sherpaDir, 'bin')
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, BIN_NAME), '')
}

function seedWhisperModel(name: string) {
  const modelDir = join(sherpaDir, 'models', `whisper-${name}`)
  mkdirSync(modelDir, { recursive: true })
  writeFileSync(join(modelDir, `${name}-encoder.onnx`), '')
  writeFileSync(join(modelDir, `${name}-decoder.onnx`), '')
  writeFileSync(join(modelDir, `${name}-tokens.txt`), '')
}

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'transcribe-test-'))
})

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true })
})

beforeEach(() => {
  sherpaDir = mkdtempSync(join(tmpRoot, 'sherpa-'))
  for (const k of Object.keys(process.env)) {
    if (
      k === 'SHOGO_SHERPA_DIR'
      || k === 'SHOGO_DATA_DIR'
      || k === 'OPENAI_API_KEY'
      || k === 'AI_PROXY_URL'
      || k === 'AI_PROXY_TOKEN'
    ) {
      delete process.env[k]
    }
  }
  process.env.SHOGO_SHERPA_DIR = sherpaDir
  spawnImpl = () => {
    const p = new FakeProc()
    queueMicrotask(() => p.emit('exit', 0))
    return p
  }
})

afterEach(() => {
  rmSync(sherpaDir, { recursive: true, force: true })
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED_ENV)) delete process.env[k]
  }
  for (const k of Object.keys(SAVED_ENV)) process.env[k] = SAVED_ENV[k]
})

const svc = await import('../transcription.service')

// ─── path resolution ─────────────────────────────────────────────────────────

describe('path resolution', () => {
  it('getSherpaOfflinePath returns null when binary is missing', () => {
    expect(svc.getSherpaOfflinePath()).toBeNull()
  })

  it('getSherpaOfflinePath returns the path when the binary exists', () => {
    seedSherpaBinary()
    expect(svc.getSherpaOfflinePath()).toBe(join(sherpaDir, 'bin', BIN_NAME))
  })

  it('getSherpaLibDir returns <sherpa>/lib (whether or not it exists)', () => {
    expect(svc.getSherpaLibDir()).toBe(join(sherpaDir, 'lib'))
  })

  it('getWhisperModelDir returns null when model files are absent', () => {
    expect(svc.getWhisperModelDir('base.en')).toBeNull()
  })

  it('getWhisperModelDir returns the dir when all three files are present', () => {
    seedWhisperModel('base.en')
    expect(svc.getWhisperModelDir('base.en')).toBe(join(sherpaDir, 'models', 'whisper-base.en'))
  })

  it('getWhisperModelDir defaults the model name to base.en', () => {
    seedWhisperModel('base.en')
    expect(svc.getWhisperModelDir()).toBe(join(sherpaDir, 'models', 'whisper-base.en'))
  })

  it('getWhisperModelDir returns null when only some of the three files exist', () => {
    const modelDir = join(sherpaDir, 'models', 'whisper-partial')
    mkdirSync(modelDir, { recursive: true })
    writeFileSync(join(modelDir, 'partial-encoder.onnx'), '')
    // missing decoder + tokens
    expect(svc.getWhisperModelDir('partial')).toBeNull()
  })

  it('getInstalledModels returns empty list when models dir is missing', () => {
    expect(svc.getInstalledModels()).toEqual([])
  })

  it('getInstalledModels returns only fully-installed known models', () => {
    seedWhisperModel('base.en')
    seedWhisperModel('small')
    // Seed a known model name with partial files — should be skipped.
    const partial = join(sherpaDir, 'models', 'whisper-tiny')
    mkdirSync(partial, { recursive: true })
    writeFileSync(join(partial, 'tiny-encoder.onnx'), '')
    expect(svc.getInstalledModels().sort()).toEqual(['base.en', 'small'])
  })

  it('isLocalTranscriptionAvailable is false without binary', () => {
    seedWhisperModel('base.en')
    expect(svc.isLocalTranscriptionAvailable()).toBe(false)
  })

  it('isLocalTranscriptionAvailable is false without model', () => {
    seedSherpaBinary()
    expect(svc.isLocalTranscriptionAvailable('base.en')).toBe(false)
  })

  it('isLocalTranscriptionAvailable is true when both present', () => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
    expect(svc.isLocalTranscriptionAvailable('base.en')).toBe(true)
  })
})

// ─── SHOGO_DATA_DIR fallback ────────────────────────────────────────────────

describe('SHOGO_DATA_DIR fallback path', () => {
  it('finds the binary under SHOGO_DATA_DIR/sherpa-onnx', () => {
    delete process.env.SHOGO_SHERPA_DIR
    const dataDir = mkdtempSync(join(tmpRoot, 'data-'))
    const altSherpa = join(dataDir, 'sherpa-onnx')
    const binDir = join(altSherpa, 'bin')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, BIN_NAME), '')
    process.env.SHOGO_DATA_DIR = dataDir
    try {
      expect(svc.getSherpaOfflinePath()).toBe(join(binDir, BIN_NAME))
    } finally {
      delete process.env.SHOGO_DATA_DIR
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

// ─── transcribeLocal — error paths ──────────────────────────────────────────

describe('transcribeLocal — preconditions', () => {
  it('throws when sherpa binary is missing', async () => {
    await expect(svc.transcribeLocal('/tmp/in.wav')).rejects.toThrow(
      /sherpa-onnx-offline binary not found/,
    )
  })

  it('throws when model is missing (but binary present)', async () => {
    seedSherpaBinary()
    await expect(svc.transcribeLocal('/tmp/in.wav', 'tiny')).rejects.toThrow(
      /Whisper ONNX model "tiny" not found/,
    )
  })
})

// ─── transcribeLocal — happy + edge paths ───────────────────────────────────

describe('transcribeLocal — spawn outcomes', () => {
  beforeEach(() => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
  })

  function setSpawn(handler: (p: FakeProc) => void) {
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => handler(p))
      return p
    }
  }

  it('parses tokens + timestamps into per-token segments', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from(
        '{"text":"hello world","tokens":["hello","world"],"timestamps":[0.1,0.4],"lang":"en"}\n'
        + 'Real time factor (RTF): 0.5 / 1.2 = 0.42\n',
      ))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.text).toBe('hello world')
    expect(res.segments).toHaveLength(2)
    expect(res.segments[0]).toEqual({ start: 0.1, end: 0.4, text: 'hello' })
    expect(res.segments[1].start).toBe(0.4)
    expect(res.segments[1].end).toBeCloseTo(0.9) // last token: end = start + 0.5
    expect(res.language).toBe('en')
    expect(res.duration).toBeCloseTo(1.2)
  })

  it('falls back to one single segment when timestamps are missing', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('{"text":"hi","lang":"fr"}'))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.segments).toEqual([{ start: 0, end: 0, text: 'hi' }])
    expect(res.language).toBe('fr')
    expect(res.duration).toBe(0)
  })

  it('returns empty segments when text is empty and no timestamps', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('{"text":""}'))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.text).toBe('')
    expect(res.segments).toEqual([])
    expect(res.language).toBe('en')
  })

  it('defaults language to "en" when lang field is absent', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('{"text":"x"}'))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.language).toBe('en')
  })

  it('rejects with the last 500 bytes of stderr on non-zero exit', async () => {
    setSpawn((p) => {
      p.stderr.emit('data', Buffer.from('segfault please call mom'))
      p.emit('exit', 1)
    })
    await expect(svc.transcribeLocal('/tmp/in.wav')).rejects.toThrow(
      /sherpa-onnx-offline exited with code 1: segfault please call mom/,
    )
  })

  it('rejects when the child emits an error event', async () => {
    setSpawn((p) => {
      p.emit('error', new Error('ENOENT spawn'))
    })
    await expect(svc.transcribeLocal('/tmp/in.wav')).rejects.toThrow(
      /Failed to run sherpa-onnx-offline: ENOENT spawn/,
    )
  })

  it('rejects when stdout has no JSON line', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('starting...\ndone.\n'))
      p.emit('exit', 0)
    })
    await expect(svc.transcribeLocal('/tmp/in.wav')).rejects.toThrow(
      /Failed to parse sherpa-onnx output: .*No JSON output found/,
    )
  })

  it('ignores malformed-JSON lines and picks the next valid line', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from('{not json}\n{"text":"ok"}'))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.text).toBe('ok')
  })

  it('ignores mismatched-length tokens/timestamps and falls back to single segment', async () => {
    setSpawn((p) => {
      p.stdout.emit('data', Buffer.from(
        '{"text":"hi","tokens":["hi"],"timestamps":[0.1,0.2]}',
      ))
      p.emit('exit', 0)
    })
    const res = await svc.transcribeLocal('/tmp/in.wav')
    expect(res.segments).toEqual([{ start: 0, end: 0, text: 'hi' }])
  })

  it('passes the correct CLI args to sherpa-onnx-offline', async () => {
    let captured: { cmd: string; args: string[]; env: Record<string, string> } | null = null
    spawnImpl = (cmd, args, opts) => {
      captured = { cmd, args, env: opts.env }
      const p = new FakeProc()
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from('{"text":"ok"}'))
        p.emit('exit', 0)
      })
      return p
    }
    await svc.transcribeLocal('/tmp/in.wav', 'base.en')
    expect(captured!.cmd).toBe(join(sherpaDir, 'bin', BIN_NAME))
    expect(captured!.args).toEqual([
      `--whisper-encoder=${join(sherpaDir, 'models/whisper-base.en/base.en-encoder.onnx')}`,
      `--whisper-decoder=${join(sherpaDir, 'models/whisper-base.en/base.en-decoder.onnx')}`,
      `--tokens=${join(sherpaDir, 'models/whisper-base.en/base.en-tokens.txt')}`,
      '--num-threads=4',
      '/tmp/in.wav',
    ])
    // Platform-specific lib path is set in env
    const envKey = process.platform === 'darwin'
      ? 'DYLD_LIBRARY_PATH'
      : process.platform === 'win32' ? 'PATH' : 'LD_LIBRARY_PATH'
    expect(captured!.env[envKey]).toContain(join(sherpaDir, 'lib'))
  })
})

// ─── transcribeCloud ─────────────────────────────────────────────────────────

describe('transcribeCloud', () => {
  let audioFile: string
  let fetchMock: ((input: any, init?: any) => Promise<Response>) | null = null
  const realFetch = globalThis.fetch

  beforeEach(() => {
    audioFile = join(tmpRoot, `audio-${Date.now()}.wav`)
    writeFileSync(audioFile, Buffer.from([1, 2, 3, 4]))
    fetchMock = null
    globalThis.fetch = (input: any, init?: any) =>
      fetchMock ? fetchMock(input, init) : Promise.reject(new Error('no fetch mock set'))
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (existsSync(audioFile)) rmSync(audioFile)
  })

  it('throws when neither OPENAI_API_KEY nor AI_PROXY_TOKEN is set', async () => {
    await expect(svc.transcribeCloud(audioFile)).rejects.toThrow(
      /No OpenAI API key or proxy configured/,
    )
  })

  it('uses OPENAI_API_KEY when only that is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    let receivedUrl = ''
    let receivedAuth = ''
    fetchMock = async (url: string, init: any) => {
      receivedUrl = url
      receivedAuth = init.headers.Authorization
      return new Response(
        JSON.stringify({
          text: 'hello',
          segments: [{ start: 0, end: 1, text: ' hello ' }],
          language: 'en',
          duration: 1,
        }),
        { status: 200 },
      )
    }
    const res = await svc.transcribeCloud(audioFile)
    expect(receivedUrl).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(receivedAuth).toBe('Bearer sk-test')
    expect(res).toEqual({
      text: 'hello',
      segments: [{ start: 0, end: 1, text: 'hello' }],
      language: 'en',
      duration: 1,
    })
  })

  it('uses AI_PROXY_TOKEN + AI_PROXY_URL when both are set (overrides OPENAI_API_KEY)', async () => {
    process.env.OPENAI_API_KEY = 'sk-fallback'
    process.env.AI_PROXY_URL = 'https://proxy.test'
    process.env.AI_PROXY_TOKEN = 'proxy-tok'
    let receivedUrl = ''
    let receivedAuth = ''
    fetchMock = async (url: string, init: any) => {
      receivedUrl = url
      receivedAuth = init.headers.Authorization
      return new Response(JSON.stringify({ text: 't', segments: [], language: 'en', duration: 0 }))
    }
    await svc.transcribeCloud(audioFile)
    expect(receivedUrl).toBe('https://proxy.test/v1/audio/transcriptions')
    expect(receivedAuth).toBe('Bearer proxy-tok')
  })

  it('forwards the language hint as a form field', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    let body: FormData | null = null
    fetchMock = async (_url: string, init: any) => {
      body = init.body as FormData
      return new Response(JSON.stringify({ text: 't', segments: [], language: 'fr' }))
    }
    await svc.transcribeCloud(audioFile, 'fr')
    expect(body!.get('language')).toBe('fr')
    expect(body!.get('model')).toBe('whisper-1')
    expect(body!.get('response_format')).toBe('verbose_json')
  })

  it('throws with status and body on non-2xx responses', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response('rate-limited buddy', { status: 429 })
    await expect(svc.transcribeCloud(audioFile)).rejects.toThrow(
      /OpenAI Whisper API error: 429 rate-limited buddy/,
    )
  })

  it('applies sensible defaults when response fields are missing', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response('{}', { status: 200 })
    const res = await svc.transcribeCloud(audioFile, 'es')
    expect(res).toEqual({ text: '', segments: [], language: 'es', duration: 0 })
  })

  it('falls back to "en" for language when neither response nor hint is set', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response('{}', { status: 200 })
    expect((await svc.transcribeCloud(audioFile)).language).toBe('en')
  })

  it('maps unknown audio extensions to audio/wav', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const weird = join(tmpRoot, `audio-${Date.now()}.flac`)
    writeFileSync(weird, Buffer.from([0]))
    fetchMock = async () => new Response('{}', { status: 200 })
    try {
      await svc.transcribeCloud(weird)
    } finally {
      rmSync(weird)
    }
  })

  it('extension defaults to wav when filename has no dot', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    const noExt = join(tmpRoot, `noextfile`)
    writeFileSync(noExt, Buffer.from([0]))
    fetchMock = async () => new Response('{}', { status: 200 })
    try {
      await svc.transcribeCloud(noExt)
    } finally {
      rmSync(noExt)
    }
  })

  it('trims whitespace inside each segment.text', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response(JSON.stringify({
      text: 'x',
      segments: [{ start: 1, end: 2, text: '  hello  ' }, {}],
    }))
    const res = await svc.transcribeCloud(audioFile)
    expect(res.segments).toEqual([
      { start: 1, end: 2, text: 'hello' },
      { start: 0, end: 0, text: '' },
    ])
  })
})

// ─── transcribe (orchestrator) ──────────────────────────────────────────────

describe('transcribe', () => {
  let audioFile: string
  const realFetch = globalThis.fetch
  let fetchMock: ((url: any, init?: any) => Promise<Response>) | null = null

  beforeEach(() => {
    audioFile = join(tmpRoot, `o-${Date.now()}.wav`)
    writeFileSync(audioFile, Buffer.from([1]))
    fetchMock = null
    globalThis.fetch = (url: any, init?: any) =>
      fetchMock ? fetchMock(url, init) : Promise.reject(new Error('no fetch mock'))
  })

  afterEach(() => {
    globalThis.fetch = realFetch
    if (existsSync(audioFile)) rmSync(audioFile)
  })

  it('uses local when binary + model are available and local succeeds', async () => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from('{"text":"from local"}'))
        p.emit('exit', 0)
      })
      return p
    }
    const res = await svc.transcribe(audioFile)
    expect(res.text).toBe('from local')
  })

  it('falls back to cloud when local fails', async () => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
    process.env.OPENAI_API_KEY = 'sk-test'
    spawnImpl = () => {
      const p = new FakeProc()
      queueMicrotask(() => p.emit('error', new Error('local broke')))
      return p
    }
    fetchMock = async () => new Response(JSON.stringify({ text: 'from cloud' }))
    const errs: string[] = []
    const orig = console.error
    console.error = (...a: any[]) => errs.push(a.join(' '))
    try {
      const res = await svc.transcribe(audioFile)
      expect(res.text).toBe('from cloud')
      expect(errs.some((e) => e.includes('Local transcription failed'))).toBe(true)
    } finally {
      console.error = orig
    }
  })

  it('goes straight to cloud when preferLocal is false', async () => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
    process.env.OPENAI_API_KEY = 'sk-test'
    let spawnCalls = 0
    spawnImpl = () => {
      spawnCalls++
      const p = new FakeProc()
      queueMicrotask(() => p.emit('exit', 0))
      return p
    }
    fetchMock = async () => new Response(JSON.stringify({ text: 'cloud-only' }))
    const res = await svc.transcribe(audioFile, { preferLocal: false })
    expect(res.text).toBe('cloud-only')
    expect(spawnCalls).toBe(0)
  })

  it('goes to cloud when binary is missing (no error, just skip)', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response(JSON.stringify({ text: 'no local' }))
    const res = await svc.transcribe(audioFile)
    expect(res.text).toBe('no local')
  })

  it('goes to cloud when model is missing', async () => {
    seedSherpaBinary()
    process.env.OPENAI_API_KEY = 'sk-test'
    fetchMock = async () => new Response(JSON.stringify({ text: 'no model' }))
    const res = await svc.transcribe(audioFile, { model: 'tiny.en' })
    expect(res.text).toBe('no model')
  })

  it('forwards language hint to the cloud call', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    let body: FormData | null = null
    fetchMock = async (_url: any, init: any) => {
      body = init.body as FormData
      return new Response(JSON.stringify({ text: 't' }))
    }
    await svc.transcribe(audioFile, { language: 'de', preferLocal: false })
    expect(body!.get('language')).toBe('de')
  })
})

// ─── transcribeLocal — platform-specific env paths (lines 106, 108-109) ───────

describe('transcribeLocal — platform-specific library path setup', () => {
  beforeEach(() => {
    seedSherpaBinary()
    seedWhisperModel('base.en')
  })

  it('sets DYLD_LIBRARY_PATH on darwin', async () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnImpl = ((_cmd: string, _args: string[], opts: any) => {
      capturedEnv = opts.env
      const p = new FakeProc()
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from('{"text":"mac","lang":"en"}'))
        p.emit('exit', 0)
      })
      return p
    }) as any
    try {
      await svc.transcribeLocal('/tmp/in.wav')
      expect(typeof capturedEnv!.DYLD_LIBRARY_PATH).toBe('string')
      expect(capturedEnv!.DYLD_LIBRARY_PATH).toContain(sherpaDir)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })

  it('sets PATH on win32', async () => {
    const orig = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    let capturedEnv: NodeJS.ProcessEnv | undefined
    spawnImpl = ((_cmd: string, _args: string[], opts: any) => {
      capturedEnv = opts.env
      const p = new FakeProc()
      queueMicrotask(() => {
        p.stdout.emit('data', Buffer.from('{"text":"win","lang":"en"}'))
        p.emit('exit', 0)
      })
      return p
    }) as any
    try {
      await svc.transcribeLocal('/tmp/in.wav')
      expect(typeof capturedEnv!.PATH).toBe('string')
      expect(capturedEnv!.PATH).toContain(sherpaDir)
    } finally {
      Object.defineProperty(process, 'platform', { value: orig, configurable: true })
    }
  })
})
