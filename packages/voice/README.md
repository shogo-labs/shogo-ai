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

## Peers (all optional)

Install only the peers you actually use:

- `@elevenlabs/react`, `@ai-sdk/react`, `ai`, `react`, `three` — web React
- `@elevenlabs/react-native`, `react-native`, `expo-gl`, `expo-three`,
  `three` — React Native

## License

MIT — see [LICENSE](./LICENSE).
