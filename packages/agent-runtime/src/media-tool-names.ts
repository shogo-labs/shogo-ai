// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Tools gated by `imageGenEnabled`. */
export const IMAGE_TOOL_NAMES = ['generate_image'] as const

/** Tools gated by the opt-in `videoGenEnabled`. */
export const VIDEO_TOOL_NAMES = ['generate_video'] as const

/** Tools gated by the opt-in `threeDGenEnabled`. */
export const THREE_D_TOOL_NAMES = ['generate_3d_model', 'edit_3d_model'] as const

/**
 * Every media generation tool. These are called directly by the project's own
 * agent — never delegated to a subagent — and gated by the capability that
 * owns each one (`imageGenEnabled`, `videoGenEnabled`, `threeDGenEnabled`);
 * `list_media_models` stays while any of them is on.
 */
export const MEDIA_TOOL_NAMES = [
  ...IMAGE_TOOL_NAMES,
  ...VIDEO_TOOL_NAMES,
  ...THREE_D_TOOL_NAMES,
  'list_media_models',
] as const
