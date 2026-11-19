// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.

/** Media query that matches phones only (touch, phone-sized viewport, either orientation). */
export declare const PHONE_MEDIA_QUERY: string

/** `content` for the viewport meta: no pinch, no input-focus zoom. */
export declare const VIEWPORT_META_CONTENT: string

/** Attribute marking (and labelling) the injected pinch-zoom guard script. */
export declare const ZOOM_GUARD_ATTRIBUTE: string

/** IIFE source for the pinch-zoom guard; wrap it in a `<script>` tag to use it. */
export declare const ZOOM_GUARD_SCRIPT: string

/** `id` of the `<style>` element carrying {@link PHONE_VIEWPORT_GUARD_CSS}. */
export declare const PHONE_GUARD_STYLE_ID: string

/** CSS for the phone viewport guard: zoom off, 16px form controls, landscape rotate prompt. */
export declare const PHONE_VIEWPORT_GUARD_CSS: string

/** `id` of the landscape rotate prompt element. */
export declare const LANDSCAPE_OVERLAY_ID: string

/** Markup for the landscape rotate prompt (already hidden until a phone is landscape). */
export declare const LANDSCAPE_OVERLAY_HTML: string
