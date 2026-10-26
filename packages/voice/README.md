<!-- SPDX-License-Identifier: MIT -->
<!-- Copyright (C) 2026 Shogo Technologies, Inc. -->

# @shogo-ai/voice

Voice infrastructure for Shogo agents — ElevenLabs ConvAI integration,
Twilio inbound/outbound, optional 3D visualizers, and React + React
Native UI primitives.

## Subpaths

| Subpath | Use |
| --- | --- |
| `@shogo-ai/voice` | Server-safe primitives: `ElevenLabsClient`, audio-tag helpers, types. |
| `@shogo-ai/voice/server` | Handler factories that turn the SDK into ready-to-mount HTTP routes. |
| `@shogo-ai/voice/react` | Web React hooks + visualizers (`useShogoVoice`, `OrganicParticles`). |
| `@shogo-ai/voice/native` | React Native equivalents (Expo). |
| `@shogo-ai/voice/route/*` | Standard `(Request) => Response` route handlers. |

## Media ops: one registry, no per-endpoint code

`VOICE_OPS` (from `@shogo-ai/voice`) is the registry of every ElevenLabs media
endpoint the SDK exposes. A row carries the upstream path, the transport
(`json-binary`, `json-json`, `multipart-binary`, `multipart-json`), the project
permission, the body limit, the model list and the metering unit. Handlers read
that table — there is no hand-written route per endpoint.

| Op | Transport | Upstream |
| --- | --- | --- |
| `text-to-speech` | JSON → audio | `POST /v1/text-to-speech/{voiceId}` |
| `text-to-speech-with-timestamps` | JSON → JSON | `POST /v1/text-to-speech/{voiceId}/with-timestamps` |
| `speech-to-speech` | multipart → audio | `POST /v1/speech-to-speech/{voiceId}` |
| `speech-to-text` | multipart → JSON | `POST /v1/speech-to-text` |
| `sound-generation` | JSON → audio | `POST /v1/sound-generation` |
| `music` | JSON → audio | `POST /v1/music` |
| `voices` | JSON → JSON | `GET /v1/voices` |
| `models` | JSON → JSON | `GET /v1/models` |

One route file serves all of them, present and future:

```ts
// app/api/voice/op/[opId]+api.ts
export { GET, POST } from '@shogo-ai/sdk/voice/route/op'
```

`handlers.op(req, opId)` is the same thing without a file convention. In proxy
mode every op is hosted on the Shogo API; the two legacy paths
(`/api/voice/tts`, `/api/voice/music`) still work because a row may keep a
`legacyHostedPath` for clients already in the field.

### Adding an op

1. Append a row to `VOICE_OPS` (`packages/voice/src/ops.ts`).
2. Add one row to `packages/voice/src/__tests__/ops.test.ts` if it needs
   validation the declarative fields cannot express.

That is the whole change. No route file, no handler, no proxy branch, no
per-op test file: `handlers.op`, the `route/op` modules and the hosted
`/api/voice/op/:opId` executor all pick it up.

Two things a row has to state, because the code cannot infer them: a body
field goes in `forward` (caller name → upstream name), while an upstream
**query** param goes in `queryForward` under its upstream name — ElevenLabs
ignores a body field that belongs in the query (`sound-generation`'s
`output_format`), so putting it in the wrong one is a silent no-op. A path
param in `pathParams` may be sent by the caller as a body field or a query
param; the multipart rebuild drops it from the upload either way.


## TTS models

`VOICE_TTS_MODELS` (from `@shogo-ai/voice`) is the single source of truth for
model ids, per-request character caps and which models a convai agent can run
on (`realtime`). It covers `eleven_v4`, `eleven_v4_turbo`, `eleven_v3`,
`eleven_v3_conversational`, `eleven_multilingual_v2`, `eleven_flash_v2_5`,
`eleven_flash_v2`, `eleven_turbo_v2_5` and `eleven_turbo_v2`.

- `textToSpeech()` defaults to `eleven_v4`; convai agents default to
  `eleven_v4_turbo` (`CONVAI_TTS_MODEL_FALLBACK`).
- `resolveConvaiTtsModelDetailed(requested)` returns
  `{ modelId, requested, downgraded, reason }`; a downgrade is logged once per
  distinct model instead of silently swapping it.
- `textToSpeech()` only falls back when the upstream failure is model-related
  (402, or 400/403/404/422 mentioning model/plan/permission) and reports
  `requestedModel` / `fellBack` / `fallbackReason`. The retry target is
  `TTS_FALLBACK_MODEL` (`eleven_flash_v2_5`, the widest-available model) —
  deliberately *not* `CONVAI_TTS_MODEL_FALLBACK`, so a BYO account without v4
  entitlement still gets audio. The `tts` handler adds `x-tts-model-used`,
  `x-tts-model-requested` and a `Warning: 199` header when they differ.

## Proxy mode (Shogo pods)

With `RUNTIME_AUTH_SECRET` + `PROJECT_ID` in env and no `apiKey`,
`createVoiceHandlers({})` forwards to the Shogo API (`SHOGO_API_URL`, else
`SHOGO_CLOUD_URL`) using the runtime token:

- `signedUrl`, `tts`, `music`, `op`, `audioTags` — hosted.
- `elevenLabs.textToSpeech()`, `.composeMusic()`, `.speechToSpeech()`,
  `.soundEffects()`, `.transcribe()` — hosted.
- `agent.*` and the other paired-account `elevenLabs` methods (cloning,
  dubbing, voice design) — not available; they throw and need a BYO key.

An explicit `apiKey` wins over the ambient runtime token. `mode: 'proxy'`
forces the runtime token, `mode: 'byo'` forces your key, `'auto'` (default)
prefers the key. `tts` and `music` need only `apiKey`; `getUser` and
`companionStore` are required only for the user-scoped handlers
(`signedUrl`, `agent.*`).

## Peers (all optional)

Install only the peers you actually use:

- `@elevenlabs/react`, `@ai-sdk/react`, `ai`, `react`, `three` — web React
- `@elevenlabs/react-native`, `react-native`, `expo-gl`, `expo-three`,
  `three` — React Native

## License

MIT — see [LICENSE](./LICENSE).
