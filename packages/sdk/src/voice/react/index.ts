// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * @shogo-ai/sdk/voice/react
 *
 * React integration for the voice module. Requires `@elevenlabs/react` and
 * `react` to be installed in the host app (optional peer dependencies).
 */

export {
  useVoiceConversation,
  type UseVoiceConversationOptions,
  type UseVoiceConversationResult,
} from './useVoiceConversation.js'

export {
  OrganicSphere,
  type OrganicSphereProps,
} from './OrganicSphere.js'

export {
  ORGANIC_SPHERE_VERTEX_SHADER,
  ORGANIC_SPHERE_FRAGMENT_SHADER,
} from './shaders/organicSphereShaders.js'
