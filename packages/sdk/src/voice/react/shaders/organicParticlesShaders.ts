// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * GLSL shaders for the `OrganicParticles` audio-reactive visualization —
 * a sibling of `OrganicSphere` that replaces the solid mesh with a
 * spherical cloud of point-sprite particles whose radial displacement,
 * swirl, size, and color gradient are driven by the same four frequency
 * bands.
 *
 * The Perlin 4D noise is shared with the sphere shader via the re-usable
 * `PERLIN_4D` partial so we only vendor Stefan Gustavson's implementation
 * once.
 */

import { PERLIN_4D } from './organicSphereShaders.js'

/**
 * Vertex shader. Reads a static `aBasePosition` (on a deterministic
 * seeded sphere) plus a per-particle `aSeed` (0–1) for subtle variation,
 * then:
 *   1. Displaces each particle radially by Perlin noise + audio volume.
 *   2. Twists the cloud around the Y axis by an amount driven by audio
 *      high-band (`uSwirl`).
 *   3. Writes `vHeat` in [0, 1] for the fragment to mix between the two
 *      tint colors.
 *   4. Sizes the point sprite by distance (perspective) + audio medium.
 */
export const ORGANIC_PARTICLES_VERTEX_SHADER = /* glsl */ `
${PERLIN_4D}

attribute vec3 aBasePosition;
attribute float aSeed;

uniform float uTime;
uniform float uNoiseFrequency;
uniform float uNoiseStrength;
uniform float uDisplacement;
uniform float uSwirl;
uniform float uSwirlTimeRate;
uniform float uSizeBase;
uniform float uSizeAudio;
uniform float uPixelRatio;

varying float vHeat;
varying float vSeed;

void main() {
  vec3 pos = aBasePosition;

  // 4D Perlin sampled in particle space. The 4th axis is time so the
  // cloud evolves over time without tiling.
  float n = perlin4d(vec4(pos * uNoiseFrequency, uTime));

  // Per-particle phase so the cloud doesn't breathe in lockstep.
  float phaseShift = (aSeed - 0.5) * 0.5;
  float breath = sin(uTime * 0.0008 + aSeed * 6.2831) * 0.5 + 0.5;

  // Outward push: noise + audio-driven displacement, scaled by seed so
  // some particles dart further than others on the same beat.
  vec3 radial = normalize(pos);
  float push = n * uNoiseStrength + uDisplacement * (0.6 + aSeed * 0.8) + breath * 0.05;
  pos += radial * push;

  // Twist around Y. Amount scales with height so the cloud spirals
  // rather than rigid-rotating. uSwirlTimeRate is 0 by default so the
  // swirl is driven by audio (uSwirl) alone; crank it for a constant
  // drift.
  float swirlAngle = pos.y * uSwirl + uTime * uSwirlTimeRate + phaseShift;
  float c = cos(swirlAngle);
  float s = sin(swirlAngle);
  pos.xz = mat2(c, -s, s, c) * pos.xz;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;

  // Point size: base + audio boost, gently perspective-attenuated. At
  // the default camera (z ~= 3.84) a uSizeBase of 1 renders roughly one
  // device pixel — intentionally tiny so 40k+ additively-blended points
  // read as fine dust rather than a solid blob.
  float size = uSizeBase + uSizeAudio * (0.5 + aSeed);
  gl_PointSize = max(1.0, size * uPixelRatio * (2.0 / max(0.1, -mvPos.z)));

  // Heat: 0 at core, 1 at fringe. Used by the fragment to lerp color.
  vHeat = clamp((length(pos) - 0.4) / 1.4, 0.0, 1.0);
  vSeed = aSeed;
}
`

/**
 * Fragment shader. Draws each particle as a soft disc that mixes between
 * the cool and hot tint based on `vHeat`, with per-particle noise-free
 * alpha shaping for a plasma-dust feel. Paired with additive blending
 * and no depth-write for a glowing cloud that doesn't self-occlude.
 */
export const ORGANIC_PARTICLES_FRAGMENT_SHADER = /* glsl */ `
precision mediump float;

uniform vec3 uColorCool;
uniform vec3 uColorHot;
uniform float uOpacity;
uniform float uSoftness;

varying float vHeat;
varying float vSeed;

void main() {
  vec2 centered = gl_PointCoord - vec2(0.5);
  float distSq = dot(centered, centered);
  if (distSq > 0.25) discard;

  // Soft circular falloff. uSoftness in [0.5, 1] controls how hard the
  // edge is: 0.5 = sharp disc, 1 = feathered blob.
  float innerR = 0.25 * (1.0 - uSoftness);
  float alpha = smoothstep(0.25, innerR, distSq);

  // Warm/cool gradient, with a tiny seed-based tint wobble so the cloud
  // doesn't look banded.
  float wobble = (vSeed - 0.5) * 0.15;
  vec3 color = mix(uColorCool, uColorHot, clamp(vHeat + wobble, 0.0, 1.0));

  gl_FragColor = vec4(color, alpha * uOpacity);
}
`
