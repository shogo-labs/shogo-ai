// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Three.js voice visualizations. Separate from `./conversation` so a
 * dynamic import of this module is the only way `three` enters the app.
 */
export {
  OrganicSphere,
  type OrganicSphereProps,
} from './OrganicSphere.js'

export {
  OrganicParticles,
  type OrganicParticlesProps,
} from './OrganicParticles.js'

export {
  type OrganicParticlesConfig,
} from './particlesConfig.js'
