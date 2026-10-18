// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Tools gated by `imageGenEnabled`. */
export const IMAGE_TOOL_NAMES = ['generate_image', 'upscale_image', 'remove_background'] as const

/** Tools gated by the opt-in `videoGenEnabled`. */
export const VIDEO_TOOL_NAMES = ['generate_video'] as const

/** Tools gated by the opt-in `threeDGenEnabled`. */
export const THREE_D_TOOL_NAMES = ['generate_3d_model', 'edit_3d_model'] as const

/** Every media generation tool, all delegated to the `media` subagent on team workspaces. */
export const MEDIA_TOOL_NAMES = [
  ...IMAGE_TOOL_NAMES,
  ...VIDEO_TOOL_NAMES,
  ...THREE_D_TOOL_NAMES,
  'list_media_models',
] as const
