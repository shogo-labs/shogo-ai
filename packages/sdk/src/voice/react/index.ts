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
  useShogoVoice,
  type UseShogoVoiceOptions,
} from './useShogoVoice.js'

export {
  OrganicSphere,
  type OrganicSphereProps,
} from './OrganicSphere.js'

export {
  DEFAULT_ORGANIC_SPHERE_CONFIG,
  resolveOrganicSphereConfig,
  type BandReactivity,
  type OrganicSphereConfig,
} from './sphereConfig.js'

export {
  OrganicParticles,
  type OrganicParticlesProps,
} from './OrganicParticles.js'

export {
  DEFAULT_ORGANIC_PARTICLES_CONFIG,
  resolveOrganicParticlesConfig,
  type OrganicParticlesConfig,
} from './particlesConfig.js'

export {
  PERLIN_4D,
  ORGANIC_SPHERE_VERTEX_SHADER,
  ORGANIC_SPHERE_FRAGMENT_SHADER,
} from './shaders/organicSphereShaders.js'

export {
  ORGANIC_PARTICLES_VERTEX_SHADER,
  ORGANIC_PARTICLES_FRAGMENT_SHADER,
} from './shaders/organicParticlesShaders.js'
