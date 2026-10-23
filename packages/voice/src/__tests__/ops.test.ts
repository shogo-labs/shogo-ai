// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * The voice op registry is data, and this file is the schema check on it.
 *
 * The point of the registry is that adding an op is one row — so the rows
 * themselves have to carry every decision a hand-written route used to make:
 * who may call it, how big a body it takes, and who pays. A row that skips
 * one of those fails here rather than in production.
 */

import { describe, expect, test } from 'bun:test'

import {
  VOICE_OPS,
  VOICE_OP_IDS,
  getVoiceOp,
  parseVoiceOpForm,
  parseVoiceOpJsonBody,
  voiceOpCredentialError,
  voiceOpForwardPath,
  voiceOpPathParams,
  voiceOpReturnsAudio,
  voiceOpUpstreamBody,
  voiceOpUpstreamPath,
  type VoiceOp,
} from '../ops'

describe('VOICE_OPS invariants', () => {
  test('every row decides who pays and how big a body it takes', () => {
    for (const op of VOICE_OPS) {
      expect(op.permission, `${op.id} permission`).toBeTruthy()
      expect(typeof op.maxBodyBytes, `${op.id} maxBodyBytes`).toBe('number')
      expect(op.maxBodyBytes, `${op.id} maxBodyBytes`).toBeGreaterThanOrEqual(0)
      // Either the pooled key pays for it with a metered unit, or it can only
      // ever run on a caller's own key.
      expect(
        Boolean(op.cost) || Boolean(op.byoOnly),
        `${op.id} must declare cost or be byoOnly`,
      ).toBe(true)
      if (op.byoOnly) expect(op.cost, `${op.id} byoOnly needs no cost`).toBeUndefined()
    }
  })

  test('ordering, ids and hosted paths are unique', () => {
    const ids = VOICE_OPS.map((op) => op.id)
    expect(new Set(ids).size).toBe(ids.length)
    const hosted = VOICE_OPS.map((op) => op.hostedPath)
    expect(new Set(hosted).size).toBe(hosted.length)
    const legacy = VOICE_OPS.flatMap((op) => (op.legacyHostedPath ? [op.legacyHostedPath] : []))
    expect(new Set(legacy).size).toBe(legacy.length)
    for (const path of legacy) expect(hosted).not.toContain(path)
    expect(VOICE_OP_IDS).toEqual(ids)
  })

  test('every POST row forwards something and every GET row takes no body', () => {
    for (const op of VOICE_OPS) {
      if (op.method === 'GET') {
        expect(op.forward, `${op.id} GET forwards no body`).toBeUndefined()
        expect(op.required).toBeUndefined()
        expect(op.maxBodyBytes, `${op.id} GET takes no body`).toBe(0)
      } else {
        expect(Object.keys(op.forward ?? {}).length, `${op.id} forward map`).toBeGreaterThan(0)
      }
    }
  })

  test('a path param is always resolvable from the body (or declared)', () => {
    for (const op of VOICE_OPS) {
      for (const param of op.pathParams ?? []) {
        expect(op.forward, `${op.id} path param ${param}`).toHaveProperty(param)
      }
    }
  })

  test('an accepted model list matches the default model', () => {
    for (const op of VOICE_OPS) {
      if (op.defaultModel) {
        expect(op.models, `${op.id} default model needs a models list`).toBeDefined()
        expect(op.models).toContain(op.defaultModel)
      }
    }
  })

  test('getVoiceOp knows every id and nothing else', () => {
    for (const id of VOICE_OP_IDS) expect(getVoiceOp(id)?.id).toBe(id)
    expect(getVoiceOp('nope')).toBeUndefined()
    expect(getVoiceOp(undefined)).toBeUndefined()
  })

  test('the four transports from the card all have a row', () => {
    const transports = new Set(VOICE_OPS.map((op) => op.transport))
    expect(transports).toEqual(
      new Set(['json-binary', 'json-json', 'multipart-binary', 'multipart-json']),
    )
  })

  test('every family the card lists is reachable', () => {
    for (const id of [
      'text-to-speech',
      'text-to-speech-with-timestamps',
      'speech-to-speech',
      'speech-to-text',
      'sound-generation',
      'music',
      'voices',
      'models',
    ]) {
      expect(VOICE_OP_IDS).toContain(id)
    }
  })
})

describe('forwarding paths', () => {
  test('a shipped legacy path wins over the canonical one', () => {
    expect(voiceOpForwardPath(getVoiceOp('text-to-speech')!)).toBe('/voice/tts')
    expect(voiceOpForwardPath(getVoiceOp('music')!)).toBe('/voice/music')
    expect(voiceOpForwardPath(getVoiceOp('speech-to-speech')!)).toBe(
      '/voice/op/speech-to-speech',
    )
  })

  test('audio rows return audio, listing rows return JSON', () => {
    expect(voiceOpReturnsAudio(getVoiceOp('speech-to-speech')!)).toBe(true)
    expect(voiceOpReturnsAudio(getVoiceOp('sound-generation')!)).toBe(true)
    expect(voiceOpReturnsAudio(getVoiceOp('speech-to-text')!)).toBe(false)
    expect(voiceOpReturnsAudio(getVoiceOp('voices')!)).toBe(false)
  })

  test('upstream paths interpolate path params and refuse to guess', () => {
    const op = getVoiceOp('speech-to-speech')!
    expect(voiceOpUpstreamPath(op, { voiceId: 'v1' })).toBe('/v1/speech-to-speech/v1')
    expect(voiceOpUpstreamPath(op, { voiceId: 'a b/c' })).toBe(
      '/v1/speech-to-speech/a%20b%2Fc',
    )
    expect(voiceOpUpstreamPath(op, {})).toEqual({
      error: 'Missing `voiceId` (required path parameter for speech-to-speech)',
    })
  })

  test('path params come from the body first, then the query', () => {
    const op = getVoiceOp('speech-to-speech')!
    expect(voiceOpPathParams(op, { voiceId: 'body' }, new URLSearchParams('voiceId=q'))).toEqual({
      voiceId: 'body',
    })
    expect(voiceOpPathParams(op, {}, new URLSearchParams('voiceId=q'))).toEqual({ voiceId: 'q' })
    expect(voiceOpPathParams(op, {}, new URLSearchParams())).toEqual({})
  })
})

describe('parseVoiceOpJsonBody', () => {
  test('whitelists the caller body and maps nothing yet', () => {
    const op = getVoiceOp('speech-to-speech')!
    const parsed = parseVoiceOpJsonBody(op, {
      audio: 'not-really',
      modelId: 'eleven_english_sts_v2',
      evil: 'ignore-me',
    })
    expect(parsed).toEqual({
      ok: true,
      fields: { audio: 'not-really', modelId: 'eleven_english_sts_v2' },
    })
  })

  test('a missing required field is a 400 naming it', () => {
    const op = getVoiceOp('sound-generation')!
    expect(parseVoiceOpJsonBody(op, {})).toEqual({
      ok: false,
      status: 400,
      error: 'Missing `text`',
    })
    expect(parseVoiceOpJsonBody(op, { text: '   ' })).toMatchObject({ ok: false, status: 400 })
  })

  test('an unknown model is a 400 with the allowed list', () => {
    const parsed = parseVoiceOpJsonBody(getVoiceOp('text-to-speech')!, {
      text: 'hi',
      modelId: 'eleven_nope',
    })
    expect(parsed).toMatchObject({ ok: false, status: 400, error: 'unknown_model' })
    if (!parsed.ok) expect(parsed.allowed).toContain('eleven_v4')
  })

  test('never invents a default model — the body stays the caller’s', () => {
    const parsed = parseVoiceOpJsonBody(getVoiceOp('text-to-speech')!, { text: 'hi' })
    expect(parsed).toEqual({ ok: true, fields: { text: 'hi' } })
  })

  test('a non-object body is a 400', () => {
    const op = getVoiceOp('sound-generation')!
    for (const raw of [null, 42, [1, 2], 'nope']) {
      expect(parseVoiceOpJsonBody(op, raw)).toMatchObject({ ok: false, status: 400 })
    }
  })

  test('a row-specific validator runs (music: prompt XOR compositionPlan)', () => {
    const op = getVoiceOp('music')!
    expect(parseVoiceOpJsonBody(op, { prompt: 'a', compositionPlan: {} })).toEqual({
      ok: false,
      status: 400,
      error: 'Provide exactly one of `prompt` or `compositionPlan`',
    })
    expect(parseVoiceOpJsonBody(op, { prompt: 'a' })).toEqual({
      ok: true,
      fields: { prompt: 'a' },
    })
  })
})

describe('parseVoiceOpForm', () => {
  const form = (entries: Record<string, string | File>) => {
    const fd = new FormData()
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value === 'string') fd.set(key, value)
      else fd.set(key, value, value.name)
    }
    return fd
  }

  test('rebuilds the multipart body with upstream field names', () => {
    const op = getVoiceOp('speech-to-speech')!
    const parsed = parseVoiceOpForm(
      op,
      form({
        audio: new File([new Uint8Array([1, 2, 3])], 'take.mp3', { type: 'audio/mpeg' }),
        modelId: 'eleven_english_sts_v2',
        voiceSettings: JSON.stringify({ stability: 0.4 }),
        ignored: 'drop me',
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.form.get('model_id')).toBe('eleven_english_sts_v2')
    expect(parsed.form.get('voice_settings')).toBe(JSON.stringify({ stability: 0.4 }))
    expect(parsed.form.get('ignored')).toBeNull()
    const audio = parsed.form.get('audio')
    expect(audio).toBeInstanceOf(Blob)
    expect(((audio as File).name)).toBe('take.mp3')
  })

  test('a path param part is returned in `fields`, since the form drops it', () => {
    const op = getVoiceOp('speech-to-speech')!
    const parsed = parseVoiceOpForm(
      op,
      form({
        audio: new File([new Uint8Array([1])], 'a.mp3', { type: 'audio/mpeg' }),
        voiceId: 'voice_from_part',
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // Repeating it in the upload makes ElevenLabs reject the body…
    expect(parsed.form.get('voice_id')).toBeNull()
    // …so the value has to survive somewhere, or the request converts to the
    // project default voice and still answers 200.
    expect(parsed.fields.voiceId).toBe('voice_from_part')
  })

  test('a text field where a file belongs is a 400, not a downstream 500', () => {
    const op = getVoiceOp('speech-to-speech')!
    const parsed = parseVoiceOpForm(op, form({ audio: 'hello' }))
    expect(parsed).toMatchObject({ ok: false, status: 400, error: 'Missing `audio` file part' })
    if (!parsed.ok) expect(parsed.detail).toContain('must be a file part')
  })

  test('an absent part and an empty part are different 400s', () => {
    const op = getVoiceOp('speech-to-speech')!
    expect(parseVoiceOpForm(op, form({}))).toMatchObject({ ok: false, status: 400 })
    expect(
      parseVoiceOpForm(op, form({ audio: new File([], 'empty.mp3', { type: 'audio/mpeg' }) })),
    ).toMatchObject({ ok: false, status: 400, error: 'Empty `audio` file part' })
  })

  test('an unknown model is rejected before the upload goes anywhere', () => {
    const op = getVoiceOp('speech-to-speech')!
    const parsed = parseVoiceOpForm(
      op,
      form({
        audio: new File([new Uint8Array([1])], 'a.mp3', { type: 'audio/mpeg' }),
        modelId: 'nope',
      }),
    )
    expect(parsed).toMatchObject({ ok: false, status: 400, error: 'unknown_model' })
  })
})

describe('voiceOpUpstreamBody', () => {
  test('maps camelCase to the snake_case EL expects and drops path params', () => {
    const op = getVoiceOp('text-to-speech')!
    expect(
      voiceOpUpstreamBody(op, {
        text: 'hi',
        voiceId: 'v1',
        modelId: 'eleven_v4',
        voiceSettings: { stability: 0.5 },
      }),
    ).toEqual({
      text: 'hi',
      model_id: 'eleven_v4',
      voice_settings: { stability: 0.5 },
    })
  })

  test('drops unknown and undefined fields', () => {
    const op = getVoiceOp('sound-generation')!
    expect(
      voiceOpUpstreamBody(op, {
        text: 'door',
        durationSeconds: undefined,
        whatever: 'nope',
      }),
    ).toEqual({ text: 'door' })
  })
})

describe('voiceOpCredentialError', () => {
  const byoOnly: VoiceOp = {
    ...getVoiceOp('speech-to-speech')!,
    id: 'speech-to-speech',
    byoOnly: true,
  }

  test('a byoOnly row refuses the pooled key with 403', () => {
    expect(voiceOpCredentialError(byoOnly, 'pooled')).toMatchObject({
      status: 403,
      error: 'byo_key_required',
    })
    expect(voiceOpCredentialError(byoOnly, 'byo')).toBeNull()
  })

  test('a pooled row is happy with the pooled key', () => {
    for (const op of VOICE_OPS) {
      expect(voiceOpCredentialError(op, 'pooled')).toBeNull()
    }
  })
})
