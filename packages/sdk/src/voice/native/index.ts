// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * `@shogo-ai/sdk/voice/native`
 *
 * React Native (Expo) voice surface — sister of `@shogo-ai/sdk/voice/react`.
 * Exposes the same set of hooks, provider, visualizations, configs, and
 * shaders so a pod that already drives the web sphere can swap import
 * paths without other code changes.
 *
 * Required peer dependencies (all optional from the SDK's POV — install
 * them in your Expo app):
 *
 *   - `@elevenlabs/react-native`            (re-exports `useConversation` + ConversationProvider)
 *   - `@livekit/react-native`               (peer of `@elevenlabs/react-native`; native WebRTC bindings)
 *   - `@livekit/react-native-webrtc`        (peer of `@livekit/react-native`)
 *   - `expo-gl`                             (GL context backing the visualizations)
 *   - `expo-three`                          (Three.js renderer that targets `expo-gl` contexts)
 *   - `three`                               (the visualization engine itself)
 *
 * Expo dev builds are required — Expo Go does not ship the LiveKit
 * native modules.
 */

export { ShogoVoiceProvider, type ShogoVoiceProviderProps } from './ShogoVoiceProvider.js'

export {
  useVoiceConversation,
  type UseVoiceConversationOptions,
  type UseVoiceConversationResult,
} from './useVoiceConversation.js'

export { useShogoVoice, type UseShogoVoiceOptions } from './useShogoVoice.js'

export { OrganicSphere, type OrganicSphereProps } from './OrganicSphere.js'
export { OrganicParticles, type OrganicParticlesProps } from './OrganicParticles.js'

// Re-export the configuration surface from the web module so
// consumers can import everything they need from a single subpath.
// These modules are platform-agnostic — pure data + functions.
export {
  DEFAULT_ORGANIC_SPHERE_CONFIG,
  resolveOrganicSphereConfig,
  type BandReactivity,
  type OrganicSphereConfig,
} from '../react/sphereConfig.js'

export {
  DEFAULT_ORGANIC_PARTICLES_CONFIG,
  resolveOrganicParticlesConfig,
  type OrganicParticlesConfig,
} from '../react/particlesConfig.js'

export {
  PERLIN_4D,
  ORGANIC_SPHERE_VERTEX_SHADER,
  ORGANIC_SPHERE_FRAGMENT_SHADER,
} from '../react/shaders/organicSphereShaders.js'

export {
  ORGANIC_PARTICLES_VERTEX_SHADER,
  ORGANIC_PARTICLES_FRAGMENT_SHADER,
} from '../react/shaders/organicParticlesShaders.js'
