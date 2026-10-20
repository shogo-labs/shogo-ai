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
  `requestedModel` / `fellBack` / `fallbackReason`. The `tts` handler adds
  `x-tts-model-used`, `x-tts-model-requested` and a `Warning: 199` header when
  they differ.

## Proxy mode (Shogo pods)

With `RUNTIME_AUTH_SECRET` + `PROJECT_ID` in env and no `apiKey`,
`createVoiceHandlers({})` forwards to the Shogo API (`SHOGO_API_URL`, else
`SHOGO_CLOUD_URL`) using the runtime token:

- `signedUrl`, `tts`, `music`, `audioTags` — hosted.
- `elevenLabs.textToSpeech()` / `.composeMusic()` — hosted.
- `agent.*` and other `elevenLabs` methods — not available; they throw and
  need a BYO key.

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
