// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `RUNTIME_AUTH_SECRET` reader for every SDK surface (LLM gateway, voice,
 * tools). The implementation lives in `@shogo-ai/voice` — the package the SDK
 * already depends on — so the SDK and the voice handlers share one rule and one
 * error message instead of drifting.
 *
 * See `packages/voice/src/runtime-token.ts` for why a `wrt_v1_` value is an
 * error rather than a credential.
 */

export {
  readRuntimeAuthSecret,
  WORKSPACE_RUNTIME_TOKEN_MESSAGE,
} from '@shogo-ai/voice'
